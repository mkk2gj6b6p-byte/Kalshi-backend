'use strict';

require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const KALSHI_API_BASE = process.env.KALSHI_API_BASE || 'https://trading-api.kalshi.com/trade-api/v2';
const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID || '';
const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS watched_wallets (
        id          SERIAL PRIMARY KEY,
        wallet_id   TEXT NOT NULL UNIQUE,
        label       TEXT,
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS copy_trades (
        id              SERIAL PRIMARY KEY,
        source_wallet   TEXT NOT NULL,
        market_ticker   TEXT NOT NULL,
        side            TEXT NOT NULL,
        count           INTEGER NOT NULL,
        price           NUMERIC(10,2),
        order_id        TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS logs (
        id          SERIAL PRIMARY KEY,
        level       TEXT NOT NULL DEFAULT 'info',
        message     TEXT NOT NULL,
        meta        JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[db] Schema initialised');
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------
async function dbLog(level, message, meta = null) {
  try {
    await pool.query(
      'INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3)',
      [level, message, meta ? JSON.stringify(meta) : null],
    );
  } catch (err) {
    console.error('[db-log error]', err.message);
  }
  console.log(`[${level.toUpperCase()}] ${message}`, meta || '');
}

// ---------------------------------------------------------------------------
// Kalshi API client (HMAC-SHA256 signature auth)
// ---------------------------------------------------------------------------
function buildKalshiHeaders(method, path) {
  const ts = Date.now().toString();
  const msgString = ts + method.toUpperCase() + path;
  const signature = crypto
    .createHmac('sha256', KALSHI_PRIVATE_KEY)
    .update(msgString)
    .digest('base64');

  return {
    'Content-Type': 'application/json',
    'KALSHI-ACCESS-KEY': KALSHI_API_KEY_ID,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
}

async function kalshiRequest(method, path, data = null) {
  const url = `${KALSHI_API_BASE}${path}`;
  const headers = buildKalshiHeaders(method, path);
  const response = await axios({ method, url, headers, data });
  return response.data;
}

// ---------------------------------------------------------------------------
// Webhook signature validation
// ---------------------------------------------------------------------------
function validateWebhookSignature(req) {
  if (!WEBHOOK_SECRET) return true; // skip validation if no secret configured
  const sig = req.headers['x-webhook-signature'] || '';
  const payload = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Copy-trade logic
// ---------------------------------------------------------------------------
async function copyOrder(sourceWallet, order) {
  const { market_ticker, side, count, price } = order;
  await dbLog('info', `Copying order from wallet ${sourceWallet}`, { market_ticker, side, count, price });

  try {
    const body = {
      ticker: market_ticker,
      action: side,
      count,
      type: price ? 'limit' : 'market',
      ...(price && { price: Math.round(price) }),
    };

    const result = await kalshiRequest('POST', '/portfolio/orders', body);
    const orderId = result && result.order && result.order.order_id;

    await pool.query(
      `INSERT INTO copy_trades (source_wallet, market_ticker, side, count, price, order_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'placed')`,
      [sourceWallet, market_ticker, side, count, price || null, orderId || null],
    );

    await dbLog('info', `Order placed successfully`, { orderId });
    return { success: true, orderId };
  } catch (err) {
    await pool.query(
      `INSERT INTO copy_trades (source_wallet, market_ticker, side, count, price, status)
       VALUES ($1, $2, $3, $4, $5, 'failed')`,
      [sourceWallet, market_ticker, side, count, price || null],
    );
    await dbLog('error', `Failed to copy order: ${err.message}`, { market_ticker });
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// ── Markets ─────────────────────────────────────────────────────────────────
app.get('/markets', async (_req, res) => {
  try {
    const data = await kalshiRequest('GET', '/markets');
    res.json(data);
  } catch (err) {
    await dbLog('error', `GET /markets failed: ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch markets', detail: err.message });
  }
});

// ── Orders ──────────────────────────────────────────────────────────────────
app.get('/orders', async (_req, res) => {
  try {
    const data = await kalshiRequest('GET', '/portfolio/orders');
    res.json(data);
  } catch (err) {
    await dbLog('error', `GET /orders failed: ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch orders', detail: err.message });
  }
});

// ── Wallets ──────────────────────────────────────────────────────────────────
app.get('/wallets', async (_req, res) => {
  try {
    const data = await kalshiRequest('GET', '/portfolio/balance');
    res.json(data);
  } catch (err) {
    await dbLog('error', `GET /wallets failed: ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch wallet balance', detail: err.message });
  }
});

// ── Copy-trades ──────────────────────────────────────────────────────────────
app.get('/copy-trades', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await pool.query(
      'SELECT * FROM copy_trades ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset],
    );
    res.json({ copy_trades: rows, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Logs ─────────────────────────────────────────────────────────────────────
app.get('/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const level = req.query.level || null;
    const query = level
      ? 'SELECT * FROM logs WHERE level = $1 ORDER BY created_at DESC LIMIT $2'
      : 'SELECT * FROM logs ORDER BY created_at DESC LIMIT $1';
    const params = level ? [level, limit] : [limit];
    const { rows } = await pool.query(query, params);
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Config: watch wallet ──────────────────────────────────────────────────────
app.post('/config/watch-wallet', async (req, res) => {
  const { wallet_id, label } = req.body;
  if (!wallet_id) {
    return res.status(400).json({ error: 'wallet_id is required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO watched_wallets (wallet_id, label)
       VALUES ($1, $2)
       ON CONFLICT (wallet_id) DO UPDATE SET label = EXCLUDED.label, active = TRUE
       RETURNING *`,
      [wallet_id, label || null],
    );
    await dbLog('info', `Watching wallet ${wallet_id}`, { label });
    res.status(201).json({ watched_wallet: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/config/watch-wallet/:wallet_id', async (req, res) => {
  const { wallet_id } = req.params;
  try {
    await pool.query(
      'UPDATE watched_wallets SET active = FALSE WHERE wallet_id = $1',
      [wallet_id],
    );
    await dbLog('info', `Stopped watching wallet ${wallet_id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/config/watch-wallet', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM watched_wallets ORDER BY created_at DESC',
    );
    res.json({ watched_wallets: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------

// ── /webhook/market-updates ──────────────────────────────────────────────────
app.post('/webhook/market-updates', async (req, res) => {
  try {
    if (!validateWebhookSignature(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const { market_ticker, status, yes_price, no_price } = req.body;
    await dbLog('info', 'Market update received', { market_ticker, status, yes_price, no_price });

    // Placeholder: trigger any market-monitoring logic here
    res.json({ received: true, market_ticker });
  } catch (err) {
    await dbLog('error', `Webhook /market-updates error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── /webhook/order-events ────────────────────────────────────────────────────
app.post('/webhook/order-events', async (req, res) => {
  try {
    if (!validateWebhookSignature(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const { wallet_id, order } = req.body;
    if (!wallet_id || !order) {
      return res.status(400).json({ error: 'wallet_id and order are required' });
    }

    await dbLog('info', 'Order event received', { wallet_id, order });

    // Check if this wallet is being watched
    const { rows } = await pool.query(
      'SELECT * FROM watched_wallets WHERE wallet_id = $1 AND active = TRUE',
      [wallet_id],
    );

    if (rows.length === 0) {
      return res.json({ received: true, copied: false, reason: 'wallet not watched' });
    }

    const result = await copyOrder(wallet_id, order);
    res.json({ received: true, copied: result.success, ...result });
  } catch (err) {
    await dbLog('error', `Webhook /order-events error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── /webhook/wallet-alerts ───────────────────────────────────────────────────
app.post('/webhook/wallet-alerts', async (req, res) => {
  try {
    if (!validateWebhookSignature(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const { wallet_id, alert_type, balance, threshold } = req.body;
    await dbLog('warn', 'Wallet alert received', { wallet_id, alert_type, balance, threshold });

    res.json({ received: true, wallet_id, alert_type });
  } catch (err) {
    await dbLog('error', `Webhook /wallet-alerts error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`[server] Kalshi backend listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();

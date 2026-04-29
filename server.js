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
const KALSHI_API_BASE =
  process.env.KALSHI_API_BASE ||
  'https://trading-api.kalshi.com/trade-api/v2';
const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID || '';
const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// ---------------------------------------------------------------------------
// PostgreSQL connection pool
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[pg] Unexpected pool error:', err.message);
});

// ---------------------------------------------------------------------------
// Database schema initialisation
// ---------------------------------------------------------------------------
async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS watched_wallets (
        wallet_id   TEXT        PRIMARY KEY,
        label       TEXT        NOT NULL DEFAULT '',
        active      BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS copy_trades (
        id            SERIAL      PRIMARY KEY,
        source_wallet TEXT        NOT NULL,
        market_ticker TEXT        NOT NULL,
        side          TEXT        NOT NULL,
        count         INTEGER     NOT NULL DEFAULT 0,
        price         NUMERIC     NOT NULL DEFAULT 0,
        order_id      TEXT,
        status        TEXT        NOT NULL DEFAULT 'pending',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id         SERIAL      PRIMARY KEY,
        level      TEXT        NOT NULL DEFAULT 'info',
        message    TEXT        NOT NULL,
        meta       JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log('[db] Schema initialised successfully.');
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Database logging helper
// ---------------------------------------------------------------------------
async function dbLog(level, message, meta = null) {
  try {
    await pool.query(
      'INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3)',
      [level, message, meta ? JSON.stringify(meta) : null],
    );
  } catch (err) {
    // Never let logging failures crash the process
    console.error('[dbLog] Failed to write log:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Kalshi API helpers
// ---------------------------------------------------------------------------

/**
 * Build the Authorization header required by Kalshi's REST API.
 * Kalshi uses HMAC-SHA256 over a canonical string composed of:
 *   timestamp (ms) + method.toUpperCase() + path
 *
 * The private key is expected as a base64-encoded raw secret or a PEM string.
 */
function buildKalshiHeaders(method, path) {
  const ts = Date.now().toString();
  const msgToSign = ts + method.toUpperCase() + path;

  let signature;
  try {
    // Support both raw-base64 secrets and PEM-formatted keys
    const keyMaterial = KALSHI_PRIVATE_KEY.includes('-----')
      ? KALSHI_PRIVATE_KEY
      : Buffer.from(KALSHI_PRIVATE_KEY, 'base64');

    signature = crypto
      .createHmac('sha256', keyMaterial)
      .update(msgToSign)
      .digest('base64');
  } catch (err) {
    console.error('[kalshi] Failed to sign request:', err.message);
    signature = '';
  }

  return {
    'Content-Type': 'application/json',
    'KALSHI-ACCESS-KEY': KALSHI_API_KEY_ID,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
}

/**
 * Thin wrapper around axios for Kalshi API calls.
 */
async function kalshiRequest(method, path, data = null) {
  const headers = buildKalshiHeaders(method, path);
  const url = `${KALSHI_API_BASE}${path}`;

  const response = await axios({
    method,
    url,
    headers,
    data: data || undefined,
    timeout: 10_000,
  });

  return response.data;
}

// ---------------------------------------------------------------------------
// Webhook signature validation
// ---------------------------------------------------------------------------

/**
 * Returns true when the X-Webhook-Signature header matches the expected
 * HMAC-SHA256 of the raw request body using WEBHOOK_SECRET.
 */
function validateWebhookSignature(req) {
  if (!WEBHOOK_SECRET) {
    // If no secret is configured, skip validation (dev mode)
    console.warn('[webhook] WEBHOOK_SECRET not set — skipping signature check.');
    return true;
  }

  const provided = req.headers['x-webhook-signature'] || '';
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody || '')
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core copy-trading logic
// ---------------------------------------------------------------------------

/**
 * Places a copy of the given order on Kalshi and records the result.
 *
 * @param {string} sourceWallet - The wallet ID whose order we are copying.
 * @param {object} order        - Order details: { market_ticker, side, count, price }
 */
async function copyOrder(sourceWallet, order) {
  const { market_ticker, side, count, price } = order;

  // Record the attempt immediately so we have an audit trail even on failure
  let tradeId;
  try {
    const insert = await pool.query(
      `INSERT INTO copy_trades
         (source_wallet, market_ticker, side, count, price, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [sourceWallet, market_ticker, side, count || 1, price || 0],
    );
    tradeId = insert.rows[0].id;
  } catch (err) {
    await dbLog('error', 'copyOrder: failed to insert copy_trade record', {
      sourceWallet,
      order,
      error: err.message,
    });
    return;
  }

  // Place the order via Kalshi API
  try {
    const payload = {
      ticker: market_ticker,
      action: 'buy',
      type: 'limit',
      side: side === 'yes' ? 'yes' : 'no',
      count: count || 1,
      yes_price: side === 'yes' ? price : undefined,
      no_price: side === 'no' ? price : undefined,
      client_order_id: `copy-${tradeId}-${Date.now()}`,
    };

    const result = await kalshiRequest('POST', '/portfolio/orders', payload);
    const orderId = result?.order?.order_id || result?.order_id || null;

    await pool.query(
      `UPDATE copy_trades SET status = 'placed', order_id = $1 WHERE id = $2`,
      [orderId, tradeId],
    );

    await dbLog('info', 'copyOrder: order placed successfully', {
      tradeId,
      sourceWallet,
      market_ticker,
      orderId,
    });
  } catch (err) {
    await pool.query(
      `UPDATE copy_trades SET status = 'failed' WHERE id = $1`,
      [tradeId],
    );

    await dbLog('error', 'copyOrder: Kalshi API call failed', {
      tradeId,
      sourceWallet,
      market_ticker,
      error: err.response?.data || err.message,
    });
  }
}

// ---------------------------------------------------------------------------
// Express application
// ---------------------------------------------------------------------------
const app = express();

// Capture raw body for webhook signature verification before JSON parsing
app.use((req, _res, next) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => { req.rawBody = raw; next(); });
});

app.use(express.json());

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Kalshi proxy endpoints
// ---------------------------------------------------------------------------
app.get('/markets', async (_req, res) => {
  try {
    const data = await kalshiRequest('GET', '/markets');
    res.json(data);
  } catch (err) {
    await dbLog('error', 'GET /markets failed', { error: err.message });
    res.status(502).json({ error: 'Failed to fetch markets from Kalshi', detail: err.message });
  }
});

app.get('/orders', async (_req, res) => {
  try {
    const data = await kalshiRequest('GET', '/portfolio/orders');
    res.json(data);
  } catch (err) {
    await dbLog('error', 'GET /orders failed', { error: err.message });
    res.status(502).json({ error: 'Failed to fetch orders from Kalshi', detail: err.message });
  }
});

app.get('/wallets', async (_req, res) => {
  try {
    const data = await kalshiRequest('GET', '/portfolio/balance');
    res.json(data);
  } catch (err) {
    await dbLog('error', 'GET /wallets failed', { error: err.message });
    res.status(502).json({ error: 'Failed to fetch wallet balance from Kalshi', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Copy-trades — list with pagination
// ---------------------------------------------------------------------------
app.get('/copy-trades', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const result = await pool.query(
      `SELECT * FROM copy_trades ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const total = await pool.query('SELECT COUNT(*) FROM copy_trades');
    res.json({
      data: result.rows,
      pagination: { limit, offset, total: parseInt(total.rows[0].count, 10) },
    });
  } catch (err) {
    await dbLog('error', 'GET /copy-trades failed', { error: err.message });
    res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Logs — list with optional level filter and pagination
// ---------------------------------------------------------------------------
app.get('/logs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const level = req.query.level || null;

  try {
    const params = level ? [level, limit, offset] : [limit, offset];
    const whereClause = level ? 'WHERE level = $1' : '';
    const limitParam = level ? '$2' : '$1';
    const offsetParam = level ? '$3' : '$2';

    const result = await pool.query(
      `SELECT * FROM logs ${whereClause} ORDER BY created_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM logs ${whereClause}`,
      level ? [level] : [],
    );

    res.json({
      data: result.rows,
      pagination: { limit, offset, total: parseInt(countResult.rows[0].count, 10) },
    });
  } catch (err) {
    res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Watched wallets configuration
// ---------------------------------------------------------------------------
app.get('/config/watch-wallet', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM watched_wallets ORDER BY created_at DESC',
    );
    res.json({ data: result.rows });
  } catch (err) {
    await dbLog('error', 'GET /config/watch-wallet failed', { error: err.message });
    res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

app.post('/config/watch-wallet', async (req, res) => {
  const { wallet_id, label } = req.body || {};

  if (!wallet_id) {
    return res.status(400).json({ error: 'wallet_id is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO watched_wallets (wallet_id, label)
       VALUES ($1, $2)
       ON CONFLICT (wallet_id) DO UPDATE SET label = EXCLUDED.label, active = TRUE
       RETURNING *`,
      [wallet_id, label || ''],
    );

    await dbLog('info', 'Wallet added to watch list', { wallet_id, label });
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    await dbLog('error', 'POST /config/watch-wallet failed', { error: err.message });
    res.status(500).json({ error: 'Database insert failed', detail: err.message });
  }
});

app.delete('/config/watch-wallet/:wallet_id', async (req, res) => {
  const { wallet_id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE watched_wallets SET active = FALSE WHERE wallet_id = $1 RETURNING *`,
      [wallet_id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    await dbLog('info', 'Wallet removed from watch list', { wallet_id });
    res.json({ data: result.rows[0] });
  } catch (err) {
    await dbLog('error', 'DELETE /config/watch-wallet failed', { error: err.message });
    res.status(500).json({ error: 'Database update failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------

// Middleware that validates the webhook signature for all /webhook/* routes
function requireWebhookSignature(req, res, next) {
  if (!validateWebhookSignature(req)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  next();
}

/**
 * POST /webhook/market-updates
 * Handles market price and status change events from Kalshi.
 */
app.post('/webhook/market-updates', requireWebhookSignature, async (req, res) => {
  const payload = req.body;

  try {
    await dbLog('info', 'webhook/market-updates received', { payload });
    // Future: trigger alerts, update cached market state, etc.
    res.json({ received: true });
  } catch (err) {
    await dbLog('error', 'webhook/market-updates handler failed', { error: err.message });
    res.status(500).json({ error: 'Handler failed', detail: err.message });
  }
});

/**
 * POST /webhook/order-events
 * Handles order events. When the order originates from a watched wallet,
 * copyOrder() is called automatically.
 */
app.post('/webhook/order-events', requireWebhookSignature, async (req, res) => {
  const payload = req.body;

  try {
    await dbLog('info', 'webhook/order-events received', { payload });

    const walletId = payload?.wallet_id || payload?.member_id || null;
    const order = payload?.order || payload || null;

    if (walletId && order) {
      // Check whether this wallet is on the watch list
      const watchResult = await pool.query(
        'SELECT wallet_id FROM watched_wallets WHERE wallet_id = $1 AND active = TRUE',
        [walletId],
      );

      if (watchResult.rowCount > 0) {
        // Fire-and-forget — respond to the webhook immediately
        setImmediate(() => copyOrder(walletId, order));
        await dbLog('info', 'Triggering copyOrder for watched wallet', { walletId, order });
      }
    }

    res.json({ received: true });
  } catch (err) {
    await dbLog('error', 'webhook/order-events handler failed', { error: err.message });
    res.status(500).json({ error: 'Handler failed', detail: err.message });
  }
});

/**
 * POST /webhook/wallet-alerts
 * Handles wallet balance alert events.
 */
app.post('/webhook/wallet-alerts', requireWebhookSignature, async (req, res) => {
  const payload = req.body;

  try {
    await dbLog('info', 'webhook/wallet-alerts received', { payload });
    // Future: send notifications, trigger rebalancing logic, etc.
    res.json({ received: true });
  } catch (err) {
    await dbLog('error', 'webhook/wallet-alerts handler failed', { error: err.message });
    res.status(500).json({ error: 'Handler failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
async function start() {
  try {
    await initSchema();
  } catch (err) {
    console.error('[startup] Schema initialisation failed:', err.message);
    // Non-fatal — the server can still start; schema may already exist
  }

  app.listen(PORT, () => {
    console.log(`[server] Kalshi backend listening on port ${PORT}`);
  });
}

start();

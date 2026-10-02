#!/usr/bin/env node
// Deterministic in-process stubs for the seven custom AQOS services, so the
// n8n workflows can be dry-run end to end without the real backends.
//
// One http.Server answers for every service hostname (stream-gw, model-svc,
// portfolio-svc, risk-svc, ems, ems-standby, data-adapter); routing is by
// method and path only. All thirteen endpoints of CONTRACTS.md are implemented.
//
// Determinism: every value is derived from a string seed (cycle_id, ids,
// request fields) through FNV-1a + xorshift. Nothing reads the clock or
// Math.random, so the same request always yields the same response - including
// after a restart. The only mutable state is the idempotency bookkeeping that
// the contract itself requires (parent_order_id, kill request_id, destroyed
// keys).
//
// Fault injection, for exercising the workflows' error paths:
//   x-stub-fail: 503       any endpoint answers with that status (400..599)
//   x-stub-delay-ms: 1500  the response is delayed (capped at 5000 ms)
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const STUB_TOKEN = 'stub-token';
// Frozen clock for every timestamp the stub invents (snapshot.ts, headlines).
export const FROZEN_NOW = '2026-10-02T12:00:00.000Z';
export const MAX_STUB_DELAY_MS = 5000;

const STRATEGIES = ['tsmom_v1', 'xsmom_v1', 'statarb_ou_v1', 'funding_carry_v1', 'basis_xex_v1'];
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const VENUES = ['binance', 'bybit', 'okx'];
const SOURCES = ['coindesk', 'theblock', 'cointelegraph', 'decrypt'];
const REGIMES = ['trending', 'mean_revert', 'carry', 'volatile'];
const ACCOUNTS = ['acc_1', 'acc_2'];
const KILL_SCOPES = ['global', 'account', 'strategy', 'venue'];
const KILL_ACTIONS = ['halt_new', 'cancel_all', 'flatten'];
const REF_PX = { BTCUSDT: 60000, ETHUSDT: 3000, SOLUSDT: 150 };
const TITLES = [
  'Spot volumes climb as flows rotate into majors',
  'Funding rates normalise after a volatile session',
  'Desk commentary: basis widens on two venues',
  'Exchange balances fall for the fourth week',
  'Vol surface flattens ahead of the weekly expiry',
  'Perpetual open interest stalls below resistance',
];

const CURRENT_WEIGHTS = { tsmom_v1: 0.3, xsmom_v1: 0.25, statarb_ou_v1: 0.2, funding_carry_v1: 0.15, basis_xex_v1: 0.1 };
const PROPOSED_WEIGHTS = { tsmom_v1: 0.32, xsmom_v1: 0.27, statarb_ou_v1: 0.18, funding_carry_v1: 0.13, basis_xex_v1: 0.1 };

// ------------------------------------------------------------- determinism ---
function hash32(seed) {
  let h = 2166136261 >>> 0;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng(seed) {
  let s = hash32(seed) || 1;
  return () => {
    s ^= s << 13; s >>> 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>=0;
    return s / 4294967296;
  };
}

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const registered = (id) => STRATEGIES.find((s) => String(id ?? '').startsWith(s)) ?? null;
const hex8 = (seed) => hash32(seed).toString(16).padStart(8, '0');

// ------------------------------------------------------------------ errors ---
const err = (code, message) => ({ error: { code, message } });
const ok = (body) => ({ status: 200, body });
const unprocessable = (fields) => ({ status: 422, body: err('missing_field', `missing required field: ${fields.join(', ')}`) });
const invalid = (message) => ({ status: 422, body: err('invalid_field', message) });
const missing = (body, fields) => fields.filter((f) => body?.[f] === undefined || body?.[f] === null || body?.[f] === '');

// ----------------------------------------------------------------- fixtures --
const RISK_SNAPSHOT = () => ({
  source: 'risk_svc',
  ts: FROZEN_NOW,
  global: {
    var_limit_usd: 50000,
    var_99_1d_usd: 12480.5,
    es_limit_usd: 75000,
    es_975_1d_usd: 15320.25,
    absorption_ratio: 0.42,
    stablecoin_depeg_bps: { USDT: 4, USDC: -2 },
    max_mark_age_s: 5,
  },
  venues: VENUES.map((venue) => ({ venue, health: 'UP', withdrawals_suspended: false })),
  accounts: [
    {
      account_id: 'acc_1',
      equity_usd: 250000,
      day_pnl_pct: 0.004,
      drawdown_pct: 0.008,
      gross_leverage: 1.6,
      daily_loss_limit_pct: 0.03,
      max_drawdown_pct: 0.15,
      auto_flatten_on_max_dd: true,
      min_liq_distance_sigma: 6.2,
    },
  ],
});

const accountSnapshot = (accountId) => {
  const r = rng(`snapshots:${accountId}`);
  const venue = VENUES[Math.floor(r() * VENUES.length)];
  return {
    account_id: accountId,
    venue,
    positions: SYMBOLS.map((symbol) => ({ symbol, qty: r4(0.05 + r() * 1.5) })),
    external_orders_count: 0,
    external_fills_count: hash32(`fills:${accountId}`) % 5,
  };
};

const headline = (since, i) => {
  const r = rng(`headline:${since}:${i}`);
  return {
    source: SOURCES[Math.floor(r() * SOURCES.length)],
    title: TITLES[Math.floor(r() * TITLES.length)],
    url: `https://headlines.invalid/${hex8(`headline:${since}:${i}`)}`,
    published_at: new Date(Date.parse(FROZEN_NOW) - (i + 1) * 300000).toISOString(),
    symbols: [SYMBOLS[Math.floor(r() * SYMBOLS.length)]],
  };
};

const prediction = (cycleId, strategy, i) => {
  const r = rng(`predict:${cycleId}:${strategy}:${i}`);
  const symbol = SYMBOLS[i % SYMBOLS.length];
  const sigma = r6(0.005 + r() * 0.015);
  const mu = r6((r() * 2 - 1) * 2 * sigma);
  return {
    model_id: `${strategy}@lgbm`,
    model_version: '1.0.0',
    symbol,
    horizon: i % 2 === 0 ? '1h' : '4h',
    mu,
    sigma,
    p_up: r6(0.5 + (r() * 2 - 1) * 0.1),
    // Consistent quantile triple: the median is mu, the tails 1.645 sigma out.
    q05: r6(mu - 1.645 * sigma),
    q50: mu,
    q95: r6(mu + 1.645 * sigma),
  };
};

// ------------------------------------------------------------------ routes ---
// Every handler is a pure function of (body, query, state), so a mutation that
// makes one of them read a clock or Math.random shows up as a diff.
const ROUTES = {
  'POST /v1/backfill': ({ body }) => {
    const miss = missing(body, ['feed_id', 'minutes']);
    if (miss.length) return unprocessable(miss);
    const minutes = Number(body.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return invalid('minutes must be a positive number');
    return ok({ accepted: true, job_id: `job_${hex8(`${body.feed_id}:${minutes}`)}` });
  },

  'GET /v1/headlines': ({ query }) => {
    if (query.since === undefined || query.since === '') return unprocessable(['since']);
    const m = /^(\d+)([mhd])$/.exec(String(query.since));
    if (!m) return invalid('since must look like 15m, 1h or 1d');
    const minutes = Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2]];
    const count = Math.min(10, Math.max(3, Math.round(minutes / 5)));
    return ok({ items: Array.from({ length: count }, (_, i) => headline(query.since, i)) });
  },

  'POST /v1/predict': ({ body }) => {
    const miss = missing(body, ['cycle_id', 'bar_ts', 'strategy_set']);
    if (miss.length) return unprocessable(miss);
    if (!Array.isArray(body.strategy_set)) return invalid('strategy_set must be an array of strategy ids');
    const known = [...new Set(body.strategy_set.map(registered).filter(Boolean))];
    if (!known.length) return invalid('strategy_set contains no registered strategy');
    const predictions = known.map((strategy, i) => prediction(body.cycle_id, strategy, i));
    return ok({
      as_of: body.bar_ts,
      regime: REGIMES[hash32(`regime:${body.cycle_id}`) % REGIMES.length],
      predictions,
      diagnostics: { stub: true, source: 'model-svc-stub', cycle_id: body.cycle_id, models: predictions.length },
    });
  },

  'POST /v1/propose': ({ body }) => {
    const miss = missing(body, ['cycle_id', 'bar_ts', 'predictions']);
    if (miss.length) return unprocessable(miss);
    if (!Array.isArray(body.predictions)) return invalid('predictions must be an array');
    const proposals = body.predictions
      .filter((p) => p && typeof p === 'object')
      .map((p, i) => {
        const r = rng(`propose:${body.cycle_id}:${p.model_id}:${p.symbol}:${i}`);
        const symbol = SYMBOLS.includes(p.symbol) ? p.symbol : SYMBOLS[Math.floor(r() * SYMBOLS.length)];
        const mu = Number(p.mu) || 0;
        return {
          account_id: 'acc_1',
          strategy_id: registered(p.model_id) ?? 'tsmom_v1',
          symbol,
          venue: VENUES[Math.floor(r() * VENUES.length)],
          side: mu >= 0 ? 'BUY' : 'SELL',
          qty: r4(0.01 + r() * 0.04),
          order_type: 'LIMIT',
          limit_px: r2(REF_PX[symbol] * (1 + (r() * 2 - 1) * 0.002)),
          urgency: Math.abs(mu) > 0.01 ? 'high' : 'normal',
          pair_id: null,
          reduce_only: false,
        };
      });
    return ok({
      proposals,
      diagnostics: { stub: true, source: 'portfolio-svc-stub', cycle_id: body.cycle_id, from_predictions: body.predictions.length },
    });
  },

  'POST /v1/rebalance': ({ body }) => {
    const miss = missing(body, ['as_of', 'accounts']);
    if (miss.length) return unprocessable(miss);
    if (!Array.isArray(body.accounts) || !body.accounts.length) return invalid('accounts must be a non-empty array');
    const proposals = [];
    for (const a of body.accounts) {
      if (typeof a?.account_id !== 'string' || !a.account_id) return unprocessable(['account_id']);
      for (const d of Array.isArray(a.drifted) ? a.drifted : []) {
        const delta = Number(d?.target_w) - Number(d?.current_w);
        if (!Number.isFinite(delta) || delta === 0) continue;
        const r = rng(`rebalance:${a.account_id}:${d.venue}:${d.symbol}`);
        const symbol = SYMBOLS.includes(d?.symbol) ? d.symbol : SYMBOLS[Math.floor(r() * SYMBOLS.length)];
        proposals.push({
          account_id: a.account_id,
          strategy_id: 'rebalance',
          symbol,
          venue: typeof d.venue === 'string' && d.venue ? d.venue : 'binance',
          side: delta > 0 ? 'BUY' : 'SELL',
          qty: Math.max(0.0001, r4(Math.min(Math.abs(delta), 0.2))),
          order_type: 'LIMIT',
          limit_px: r2(REF_PX[symbol]),
          urgency: 'low',
          pair_id: null,
          reduce_only: false,
        });
      }
    }
    return ok({ proposals, diagnostics: { stub: true, source: 'portfolio-svc-stub', as_of: body.as_of, accounts: body.accounts.length } });
  },

  'POST /v1/allocation/propose': ({ body }) => {
    const miss = missing(body, ['as_of']);
    if (miss.length) return unprocessable(miss);
    return ok({
      proposed_weights: { ...PROPOSED_WEIGHTS },
      current_weights: { ...CURRENT_WEIGHTS },
      diagnostics: { stub: true, source: 'portfolio-svc-stub', as_of: body.as_of, method: 'deterministic_tilt', one_way_turnover: 0.04 },
    });
  },

  'GET /v1/snapshot': () => ok(RISK_SNAPSHOT()),

  'POST /v1/orders/batch': ({ body, state }) => {
    const miss = missing(body, ['request_id', 'orders']);
    if (miss.length) return unprocessable(miss);
    if (!Array.isArray(body.orders)) return invalid('orders must be an array');
    if (!body.orders.length) return invalid('orders must contain at least one order');
    const accepted = [];
    const duplicates = [];
    const rejected = [];
    for (const o of body.orders) {
      const id = o && typeof o === 'object' ? o.parent_order_id : null;
      if (typeof id !== 'string' || !id) { rejected.push({ parent_order_id: id ?? null, reason: 'missing_parent_order_id' }); continue; }
      if (!['BUY', 'SELL'].includes(String(o.side).toUpperCase())) { rejected.push({ parent_order_id: id, reason: 'invalid_side' }); continue; }
      if (!(Number(o.qty) > 0)) { rejected.push({ parent_order_id: id, reason: 'invalid_qty' }); continue; }
      if (state.orders.has(id)) duplicates.push(id);
      else { state.orders.add(id); accepted.push(id); }
    }
    return ok({ request_id: body.request_id, accepted, duplicates, rejected });
  },

  'POST /v1/kill': ({ body, state }) => {
    const miss = missing(body, ['request_id', 'scope', 'action']);
    if (miss.length) return unprocessable(miss);
    if (!KILL_SCOPES.includes(body.scope)) return invalid(`scope must be one of ${KILL_SCOPES.join(', ')}`);
    if (!KILL_ACTIONS.includes(body.action)) return invalid(`action must be one of ${KILL_ACTIONS.join(', ')}`);
    if (body.scope !== 'global' && missing(body, ['scope_id']).length) return unprocessable(['scope_id']);
    const duplicate = state.kills.has(body.request_id);
    state.kills.add(body.request_id);
    return ok({
      request_id: body.request_id,
      status: 'accepted',
      cancelled_orders: hash32(`kill:${body.request_id}`) % 5,
      duplicate,
    });
  },

  'POST /v1/exposure': ({ body }) => {
    const miss = missing(body, ['scope', 'scope_id']);
    if (miss.length) return unprocessable(miss);
    return ok({
      open_orders: 0,
      gross_notional_usd: (hash32(`exposure:${body.scope}:${body.scope_id}`) % 2500) / 100,
    });
  },

  'POST /v1/snapshots': ({ body }) => {
    const miss = missing(body, ['accounts']);
    if (miss.length) return unprocessable(miss);
    if (body.accounts !== 'all' && !Array.isArray(body.accounts)) return invalid('accounts must be "all" or an array of account ids');
    const ids = body.accounts === 'all' ? ACCOUNTS : body.accounts;
    return ok({ accounts: ids.map((id) => accountSnapshot(String(id))) });
  },

  'POST /v1/keys/inspect': ({ body, state }) => {
    const miss = missing(body, ['venue', 'key_ref']);
    if (miss.length) return unprocessable(miss);
    if (state.destroyedKeys.has(body.key_ref)) return ok({ error: { code: 'key_not_found', message: `key ${body.key_ref} was destroyed` } });
    return ok({
      can_trade: true,
      can_withdraw: false,
      can_transfer: false,
      ip_restricted: true,
      futures_enabled: body.venue === 'bybit',
    });
  },

  'POST /v1/keys/destroy': ({ body, state }) => {
    const miss = missing(body, ['key_ref']);
    if (miss.length) return unprocessable(miss);
    state.destroyedKeys.add(body.key_ref);
    return ok({ destroyed: true });
  },
};

// --------------------------------------------------------------- transport ---
export function clampDelayMs(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_STUB_DELAY_MS);
}

function failStatus(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 400 || n > 599) return 503;
  return n;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
  res.end(payload);
}

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(req, res, { token, state }) {
  const url = new URL(req.url, 'http://stub.local');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const query = Object.fromEntries(url.searchParams);
  const headers = req.headers;

  // Public health probe (the supervisor calls /healthz without credentials).
  if (req.method === 'GET' && path === '/healthz') {
    return send(res, 200, { status: 'ok', stub_ts: FROZEN_NOW, endpoints: Object.keys(ROUTES).length });
  }

  if (headers.authorization !== `Bearer ${token}`) {
    return send(res, 401, err('unauthorized', 'missing or invalid bearer token'));
  }

  const delay = clampDelayMs(headers['x-stub-delay-ms']);
  if (delay > 0) await sleep(delay);
  const fail = failStatus(headers['x-stub-fail']);
  if (fail) return send(res, fail, err('stub_failure', 'x-stub-fail requested by the caller'));

  const route = ROUTES[`${req.method} ${path}`];
  if (!route) return send(res, 404, err('not_found', `no route for ${req.method} ${path}`));

  const raw = await readRaw(req);
  let body = {};
  if (raw.trim() !== '') {
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, err('bad_json', 'request body is not valid JSON'));
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return send(res, 400, err('bad_json', 'request body must be a JSON object'));
    }
  }

  const out = route({ body, query, state, raw, method: req.method, path });
  return send(res, out.status ?? 200, out.body);
}

export function createStubServer({ token = STUB_TOKEN } = {}) {
  const state = { orders: new Set(), kills: new Set(), destroyedKeys: new Set() };
  return http.createServer((req, res) => {
    handle(req, res, { token, state }).catch((e) => {
      if (res.headersSent) { res.end(); return; }
      send(res, 500, err('stub_error', String(e && e.message ? e.message : e)));
    });
  });
}

// Signs an event body the way the internal services sign their webhooks:
// HMAC-SHA256 over the exact raw body string.
export function signEvent(secret, body) {
  const rawBody = JSON.stringify(body);
  const signature = createHmac('sha256', String(secret)).update(rawBody, 'utf8').digest('hex');
  return {
    headers: { 'x-aqos-signature': `sha256=${signature}`, 'content-type': 'application/json' },
    rawBody,
  };
}

// ------------------------------------------------------------------ script ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080);
  createStubServer({ token: process.env.STUB_TOKEN || STUB_TOKEN }).listen(port, '0.0.0.0', () => {
    process.stdout.write(`aqos stubs listening on ${port}\n`);
  });
}

export { ROUTES, hash32 };
export const fingerprint = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

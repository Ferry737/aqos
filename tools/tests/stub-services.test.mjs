// Tests for the deterministic stub services: per-endpoint behaviour, error
// handling, fault injection, idempotency and - most importantly - that the real
// n8n Code-node scripts accept what the stubs answer.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStubServer, signEvent, clampDelayMs, MAX_STUB_DELAY_MS } from '../stub-services.mjs';
import { runFirst, runCodeNode } from '../lib/sandbox.mjs';

const CYCLE_ID = 'core5m:2026-10-02T00:05:00.000Z';
const BAR_TS = '2026-10-02T00:05:00.000Z';
const STRATEGY_SET = ['tsmom_v1', 'xsmom_v1', 'statarb_ou_v1', 'funding_carry_v1', 'basis_xex_v1'];

async function start(opts) {
  const server = createStubServer(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

let server;
let base;

before(async () => { ({ server, base } = await start()); });
after(async () => { await new Promise((resolve) => server.close(resolve)); });

async function call(method, path, { body, headers = {}, token = 'stub-token', raw } = {}) {
  const h = { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers };
  if (raw !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text), text };
}

const predictBody = { cycle_id: CYCLE_ID, bar_ts: BAR_TS, strategy_set: STRATEGY_SET };
const PREDICT_KEYS = ['model_id', 'model_version', 'symbol', 'horizon', 'mu', 'sigma', 'p_up', 'q05', 'q50', 'q95'];

// ----------------------------------------------------------------- transport
test('health: /healthz answers without a token and reports the endpoint count', async () => {
  const r = await call('GET', '/healthz', { token: null });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok', stub_ts: '2026-10-02T12:00:00.000Z', endpoints: 13 });
});

test('auth: a missing token is 401 with the contract error body', async () => {
  const r = await call('GET', '/v1/snapshot', { token: null });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: { code: 'unauthorized', message: 'missing or invalid bearer token' } });
});

test('auth: a wrong token, a wrong scheme and an empty token are all 401', async () => {
  for (const authorization of ['Bearer nope', 'Basic stub-token', 'stub-token', 'Bearer  stub-token', '']) {
    const r = await call('GET', '/v1/snapshot', { headers: { authorization } });
    assert.equal(r.status, 401, authorization);
    assert.equal(r.body.error.code, 'unauthorized');
  }
});

test('routing: an unknown path and an unknown method on a known path are 404', async () => {
  const a = await call('GET', '/v1/nope');
  assert.equal(a.status, 404);
  assert.deepEqual(a.body, { error: { code: 'not_found', message: 'no route for GET /v1/nope' } });
  const b = await call('GET', '/v1/predict');
  assert.equal(b.status, 404);
  assert.equal(b.body.error.message, 'no route for GET /v1/predict');
});

test('parsing: a malformed JSON body is 400 and a non-object body is 400', async () => {
  const a = await call('POST', '/v1/predict', { raw: '{"cycle_id": ' });
  assert.equal(a.status, 400);
  assert.deepEqual(a.body, { error: { code: 'bad_json', message: 'request body is not valid JSON' } });
  const b = await call('POST', '/v1/predict', { raw: '[1,2,3]' });
  assert.equal(b.status, 400);
  assert.equal(b.body.error.code, 'bad_json');
});

test('parsing: an empty body is treated as no fields at all (422, not 400)', async () => {
  const r = await call('POST', '/v1/predict', { raw: '' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'missing_field');
});

// ------------------------------------------------------------------ endpoints
test('backfill: accepted with a job id derived from the request', async () => {
  const r = await call('POST', '/v1/backfill', { body: { feed_id: 'btc_5m', minutes: 60 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { accepted: true, job_id: 'job_39b9f3a1' });
});

test('backfill: the job id is stable for the same request and differs otherwise', async () => {
  const a = await call('POST', '/v1/backfill', { body: { feed_id: 'btc_5m', minutes: '60' } });
  const b = await call('POST', '/v1/backfill', { body: { feed_id: 'btc_5m', minutes: 60 } });
  const c = await call('POST', '/v1/backfill', { body: { feed_id: 'eth_5m', minutes: 60 } });
  const d = await call('POST', '/v1/backfill', { body: { feed_id: 'btc_5m', minutes: 15 } });
  assert.equal(a.body.job_id, b.body.job_id);
  assert.notEqual(a.body.job_id, c.body.job_id);
  assert.notEqual(a.body.job_id, d.body.job_id);
});

test('backfill: a missing field is 422 and a non-positive window is 422', async () => {
  const miss = await call('POST', '/v1/backfill', { body: { feed_id: 'btc_5m' } });
  assert.equal(miss.status, 422);
  assert.deepEqual(miss.body, { error: { code: 'missing_field', message: 'missing required field: minutes' } });
  const both = await call('POST', '/v1/backfill', { body: {} });
  assert.equal(both.body.error.message, 'missing required field: feed_id, minutes');
  const bad = await call('POST', '/v1/backfill', { body: { feed_id: 'btc_5m', minutes: 0 } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body, { error: { code: 'invalid_field', message: 'minutes must be a positive number' } });
});

test('headlines: items are complete, deterministic and counted from the window', async () => {
  const r = await call('GET', '/v1/headlines?since=15m');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, [
    { source: 'coindesk', title: 'Spot volumes climb as flows rotate into majors', url: 'https://headlines.invalid/d2df5df4', published_at: '2026-10-02T11:55:00.000Z', symbols: ['ETHUSDT'] },
    { source: 'coindesk', title: 'Vol surface flattens ahead of the weekly expiry', url: 'https://headlines.invalid/d3df5f87', published_at: '2026-10-02T11:50:00.000Z', symbols: ['SOLUSDT'] },
    { source: 'coindesk', title: 'Perpetual open interest stalls below resistance', url: 'https://headlines.invalid/d4df611a', published_at: '2026-10-02T11:45:00.000Z', symbols: ['BTCUSDT'] },
  ]);
  const again = await call('GET', '/v1/headlines?since=15m');
  assert.deepEqual(again.body, r.body);
  const day = await call('GET', '/v1/headlines?since=24h');
  assert.equal(day.body.items.length, 10);
  assert.notDeepEqual(day.body.items[0], r.body.items[0]);
});

test('headlines: since is required and must be a duration', async () => {
  const miss = await call('GET', '/v1/headlines');
  assert.equal(miss.status, 422);
  assert.deepEqual(miss.body, { error: { code: 'missing_field', message: 'missing required field: since' } });
  const bad = await call('GET', '/v1/headlines?since=yesterday');
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'invalid_field');
});

test('predict: the payload honours the model contract exactly', async () => {
  const r = await call('POST', '/v1/predict', { body: predictBody });
  assert.equal(r.status, 200);
  assert.equal(r.body.as_of, BAR_TS);
  assert.equal(r.body.regime, 'volatile');
  assert.deepEqual(r.body.predictions[0], {
    model_id: 'tsmom_v1@lgbm', model_version: '1.0.0', symbol: 'BTCUSDT', horizon: '1h',
    mu: 0.037047, sigma: 0.018725, p_up: 0.573548, q05: 0.006244, q50: 0.037047, q95: 0.06785,
  });
  assert.deepEqual(r.body.diagnostics, { stub: true, source: 'model-svc-stub', cycle_id: CYCLE_ID, models: 5 });
  for (const p of r.body.predictions) {
    assert.deepEqual(Object.keys(p), PREDICT_KEYS);
    assert.ok(p.sigma > 0);
    assert.ok(Math.abs(p.mu) <= 5 * p.sigma);
    assert.ok(p.p_up >= 0 && p.p_up <= 1);
    assert.ok(p.q05 < p.q50 && p.q50 < p.q95);
    assert.ok(STRATEGY_SET.some((s) => p.model_id.startsWith(s)));
  }
});

test('predict: one row per strategy, symbols cycle and horizons alternate', async () => {
  const r = await call('POST', '/v1/predict', { body: predictBody });
  assert.deepEqual(r.body.predictions.map((p) => p.symbol), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BTCUSDT', 'ETHUSDT']);
  assert.deepEqual(r.body.predictions.map((p) => p.horizon), ['1h', '4h', '1h', '4h', '1h']);
  const two = await call('POST', '/v1/predict', { body: { ...predictBody, strategy_set: ['basis_xex_v1'] } });
  assert.equal(two.body.predictions.length, 1);
  assert.equal(two.body.predictions[0].model_id, 'basis_xex_v1@lgbm');
  assert.equal(two.body.diagnostics.models, 1);
});

test('predict: the same cycle gives the same numbers and another cycle does not', async () => {
  const a = await call('POST', '/v1/predict', { body: predictBody });
  const b = await call('POST', '/v1/predict', { body: predictBody });
  const c = await call('POST', '/v1/predict', { body: { ...predictBody, cycle_id: 'core5m:2026-10-02T00:10:00.000Z' } });
  assert.deepEqual(b.body, a.body);
  assert.notDeepEqual(c.body.predictions, a.body.predictions);
  const d = await call('POST', '/v1/predict', { body: { ...predictBody, bar_ts: '2026-10-02T00:10:00.000Z' } });
  assert.equal(d.body.as_of, '2026-10-02T00:10:00.000Z');
  assert.deepEqual(d.body.predictions, a.body.predictions);
});

test('predict: unregistered strategies are 422 and missing fields are 422', async () => {
  const bad = await call('POST', '/v1/predict', { body: { ...predictBody, strategy_set: ['momentum_9000'] } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body, { error: { code: 'invalid_field', message: 'strategy_set contains no registered strategy' } });
  const notArray = await call('POST', '/v1/predict', { body: { ...predictBody, strategy_set: 'tsmom_v1' } });
  assert.equal(notArray.body.error.code, 'invalid_field');
  const miss = await call('POST', '/v1/predict', { body: { cycle_id: CYCLE_ID, bar_ts: BAR_TS } });
  assert.equal(miss.status, 422);
  assert.equal(miss.body.error.message, 'missing required field: strategy_set');
});

test('propose: proposals are tradable, complete and deterministic', async () => {
  const [, { body: preds }] = await Promise.all([0, call('POST', '/v1/predict', { body: { ...predictBody, strategy_set: ['tsmom_v1', 'xsmom_v1'] } })]);
  const r = await call('POST', '/v1/propose', { body: { cycle_id: CYCLE_ID, bar_ts: BAR_TS, predictions: preds.predictions } });
  assert.deepEqual(r.body.proposals[0], {
    account_id: 'acc_1', strategy_id: 'tsmom_v1', symbol: 'BTCUSDT', venue: 'binance', side: 'BUY',
    qty: 0.0141, order_type: 'LIMIT', limit_px: 59976.37, urgency: 'high', pair_id: null, reduce_only: false,
  });
  assert.deepEqual(r.body.proposals[1], {
    account_id: 'acc_1', strategy_id: 'xsmom_v1', symbol: 'ETHUSDT', venue: 'bybit', side: 'SELL',
    qty: 0.0277, order_type: 'LIMIT', limit_px: 2994.98, urgency: 'normal', pair_id: null, reduce_only: false,
  });
  assert.deepEqual(r.body.diagnostics, { stub: true, source: 'portfolio-svc-stub', cycle_id: CYCLE_ID, from_predictions: 2 });
  const again = await call('POST', '/v1/propose', { body: { cycle_id: CYCLE_ID, bar_ts: BAR_TS, predictions: preds.predictions } });
  assert.deepEqual(again.body, r.body);
});

test('propose: side follows mu and an empty prediction list proposes nothing', async () => {
  const buy = await call('POST', '/v1/propose', { body: { cycle_id: CYCLE_ID, bar_ts: BAR_TS, predictions: [{ model_id: 'xsmom_v1@lgbm', symbol: 'SOLUSDT', mu: 0.02 }] } });
  assert.equal(buy.body.proposals[0].side, 'BUY');
  const sell = await call('POST', '/v1/propose', { body: { cycle_id: CYCLE_ID, bar_ts: BAR_TS, predictions: [{ model_id: 'xsmom_v1@lgbm', symbol: 'SOLUSDT', mu: -0.02 }] } });
  assert.equal(sell.body.proposals[0].side, 'SELL');
  const none = await call('POST', '/v1/propose', { body: { cycle_id: CYCLE_ID, bar_ts: BAR_TS, predictions: [] } });
  assert.deepEqual(none.body.proposals, []);
  const miss = await call('POST', '/v1/propose', { body: { cycle_id: CYCLE_ID, bar_ts: BAR_TS } });
  assert.equal(miss.status, 422);
  assert.equal(miss.body.error.message, 'missing required field: predictions');
});

test('rebalance: drifted legs become proposals and no-drift legs do not', async () => {
  const r = await call('POST', '/v1/rebalance', { body: { as_of: BAR_TS, reason: 'drift', accounts: [
    { account_id: 'acc_1', max_abs_drift: 0.02, drifted: [
      { venue: 'binance', symbol: 'BTCUSDT', target_w: 0.3, current_w: 0.27 },
      { venue: 'bybit', symbol: 'ETHUSDT', target_w: 0.2, current_w: 0.25 },
      { venue: 'okx', symbol: 'SOLUSDT', target_w: 0.1, current_w: 0.1 },
    ] },
  ] } });
  assert.deepEqual(r.body.proposals.map((p) => [p.symbol, p.venue, p.side, p.qty]), [
    ['BTCUSDT', 'binance', 'BUY', 0.03], ['ETHUSDT', 'bybit', 'SELL', 0.05],
  ]);
  assert.deepEqual(r.body.diagnostics, { stub: true, source: 'portfolio-svc-stub', as_of: BAR_TS, accounts: 1 });
});

test('rebalance: accounts must be a non-empty array of identified accounts', async () => {
  const empty = await call('POST', '/v1/rebalance', { body: { as_of: BAR_TS, accounts: [] } });
  assert.equal(empty.body.error.code, 'invalid_field');
  const anon = await call('POST', '/v1/rebalance', { body: { as_of: BAR_TS, accounts: [{ drifted: [] }] } });
  assert.equal(anon.status, 422);
  assert.equal(anon.body.error.code, 'missing_field');
  const miss = await call('POST', '/v1/rebalance', { body: { as_of: BAR_TS } });
  assert.equal(miss.body.error.message, 'missing required field: accounts');
});

test('allocation/propose: the tilt stays inside the autonomy envelope', async () => {
  const r = await call('POST', '/v1/allocation/propose', { body: { as_of: BAR_TS } });
  assert.deepEqual(r.body, {
    proposed_weights: { tsmom_v1: 0.32, xsmom_v1: 0.27, statarb_ou_v1: 0.18, funding_carry_v1: 0.13, basis_xex_v1: 0.1 },
    current_weights: { tsmom_v1: 0.3, xsmom_v1: 0.25, statarb_ou_v1: 0.2, funding_carry_v1: 0.15, basis_xex_v1: 0.1 },
    diagnostics: { stub: true, source: 'portfolio-svc-stub', as_of: BAR_TS, method: 'deterministic_tilt', one_way_turnover: 0.04 },
  });
  const again = await call('POST', '/v1/allocation/propose', { body: { as_of: '2026-10-02T00:10:00.000Z' } });
  assert.deepEqual(again.body.proposed_weights, r.body.proposed_weights);
  assert.equal(again.body.diagnostics.as_of, '2026-10-02T00:10:00.000Z');
  const miss = await call('POST', '/v1/allocation/propose', { body: {} });
  assert.equal(miss.status, 422);
  assert.equal(miss.body.error.message, 'missing required field: as_of');
});

test('snapshot: a calm, fully shaped risk snapshot is returned', async () => {
  const r = await call('GET', '/v1/snapshot');
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'risk_svc');
  assert.equal(r.body.ts, '2026-10-02T12:00:00.000Z');
  assert.deepEqual(r.body.global, {
    var_limit_usd: 50000, var_99_1d_usd: 12480.5, es_limit_usd: 75000, es_975_1d_usd: 15320.25,
    absorption_ratio: 0.42, stablecoin_depeg_bps: { USDT: 4, USDC: -2 }, max_mark_age_s: 5,
  });
  assert.deepEqual(r.body.venues.map((v) => v.venue), ['binance', 'bybit', 'okx']);
  assert.ok(r.body.venues.every((v) => v.health === 'UP' && v.withdrawals_suspended === false));
  assert.deepEqual(r.body.accounts[0], {
    account_id: 'acc_1', equity_usd: 250000, day_pnl_pct: 0.004, drawdown_pct: 0.008, gross_leverage: 1.6,
    daily_loss_limit_pct: 0.03, max_drawdown_pct: 0.15, auto_flatten_on_max_dd: true, min_liq_distance_sigma: 6.2,
  });
  const again = await call('GET', '/v1/snapshot');
  assert.deepEqual(again.body, r.body);
});

test('orders/batch: orders are accepted once and reported as duplicates afterwards', async () => {
  const batch = { request_id: 'batch_1', sent_at: BAR_TS, orders: [
    { parent_order_id: 'po_1', account_id: 'acc_1', strategy_id: 'tsmom_v1', venue: 'binance', symbol: 'BTCUSDT', side: 'BUY', qty: 0.01, order_type: 'LIMIT', limit_px: 60000, reduce_only: false, urgency: 'normal', pair_id: null },
    { parent_order_id: 'po_2', account_id: 'acc_1', strategy_id: 'xsmom_v1', venue: 'bybit', symbol: 'ETHUSDT', side: 'SELL', qty: 0.02, order_type: 'LIMIT', limit_px: 3000, reduce_only: false, urgency: 'normal', pair_id: null },
  ] };
  const first = await call('POST', '/v1/orders/batch', { body: batch });
  assert.deepEqual(first.body, { request_id: 'batch_1', accepted: ['po_1', 'po_2'], duplicates: [], rejected: [] });
  const second = await call('POST', '/v1/orders/batch', { body: { ...batch, request_id: 'batch_2' } });
  assert.deepEqual(second.body, { request_id: 'batch_2', accepted: [], duplicates: ['po_1', 'po_2'], rejected: [] });
  const mixed = await call('POST', '/v1/orders/batch', { body: { request_id: 'batch_3', sent_at: BAR_TS, orders: [batch.orders[0], { parent_order_id: 'po_3', side: 'HODL', qty: 1 }, { side: 'BUY', qty: 1 }, { parent_order_id: 'po_4', side: 'BUY', qty: 0 }] } });
  assert.deepEqual(mixed.body.accepted, []);
  assert.deepEqual(mixed.body.duplicates, ['po_1']);
  assert.deepEqual(mixed.body.rejected, [
    { parent_order_id: 'po_3', reason: 'invalid_side' },
    { parent_order_id: null, reason: 'missing_parent_order_id' },
    { parent_order_id: 'po_4', reason: 'invalid_qty' },
  ]);
});

test('orders/batch: a rejected parent order id is not remembered', async () => {
  const r1 = await call('POST', '/v1/orders/batch', { body: { request_id: 'b', orders: [{ parent_order_id: 'po_x', side: 'BUY', qty: 0 }] } });
  assert.deepEqual(r1.body.rejected, [{ parent_order_id: 'po_x', reason: 'invalid_qty' }]);
  const r2 = await call('POST', '/v1/orders/batch', { body: { request_id: 'b', orders: [{ parent_order_id: 'po_x', side: 'BUY', qty: 0.01 }] } });
  assert.deepEqual(r2.body.accepted, ['po_x']);
});

test('orders/batch: missing or malformed collections are 422', async () => {
  const miss = await call('POST', '/v1/orders/batch', { body: { orders: [] } });
  assert.equal(miss.body.error.message, 'missing required field: request_id');
  const notArray = await call('POST', '/v1/orders/batch', { body: { request_id: 'r', orders: 'po_1' } });
  assert.equal(notArray.body.error.code, 'invalid_field');
  const empty = await call('POST', '/v1/orders/batch', { body: { request_id: 'r', orders: [] } });
  assert.deepEqual(empty.body.error, { code: 'invalid_field', message: 'orders must contain at least one order' });
});

test('kill: the first call acts, the second is flagged as a duplicate', async () => {
  const req = { request_id: 'kill_1', scope: 'global', scope_id: '*', action: 'cancel_all', reason: 'test' };
  const first = await call('POST', '/v1/kill', { body: req });
  assert.deepEqual(first.body, { request_id: 'kill_1', status: 'accepted', cancelled_orders: 0, duplicate: false });
  const second = await call('POST', '/v1/kill', { body: req });
  assert.deepEqual(second.body, { request_id: 'kill_1', status: 'accepted', cancelled_orders: 0, duplicate: true });
  const other = await call('POST', '/v1/kill', { body: { ...req, request_id: 'kill_2' } });
  assert.equal(other.body.duplicate, false);
});

test('kill: scopes and actions are validated and scoped kills need a scope id', async () => {
  const badAction = await call('POST', '/v1/kill', { body: { request_id: 'k', scope: 'global', action: 'explode' } });
  assert.equal(badAction.status, 422);
  assert.deepEqual(badAction.body, { error: { code: 'invalid_field', message: 'action must be one of halt_new, cancel_all, flatten' } });
  const badScope = await call('POST', '/v1/kill', { body: { request_id: 'k', scope: 'universe', action: 'halt_new' } });
  assert.equal(badScope.body.error.message, 'scope must be one of global, account, strategy, venue');
  const noScope = await call('POST', '/v1/kill', { body: { request_id: 'k3', scope: 'account', action: 'flatten' } });
  assert.equal(noScope.status, 422);
  assert.equal(noScope.body.error.message, 'missing required field: scope_id');
  const good = await call('POST', '/v1/kill', { body: { request_id: 'k4', scope: 'venue', scope_id: 'okx', action: 'halt_new' } });
  assert.equal(good.status, 200);
});

test('exposure: flat after a kill, with a deterministic dust residual', async () => {
  const r = await call('POST', '/v1/exposure', { body: { scope: 'global', scope_id: '*' } });
  assert.deepEqual(r.body, { open_orders: 0, gross_notional_usd: 11.85 });
  const again = await call('POST', '/v1/exposure', { body: { scope: 'global', scope_id: '*' } });
  assert.deepEqual(again.body, r.body);
  const other = await call('POST', '/v1/exposure', { body: { scope: 'account', scope_id: 'acc_1' } });
  assert.equal(other.body.open_orders, 0);
  assert.notEqual(other.body.gross_notional_usd, r.body.gross_notional_usd);
  assert.ok(other.body.gross_notional_usd < 25);
  const miss = await call('POST', '/v1/exposure', { body: { scope: 'global' } });
  assert.equal(miss.status, 422);
  assert.equal(miss.body.error.message, 'missing required field: scope_id');
});

test('snapshots: "all" reads both accounts with positions and counters', async () => {
  const r = await call('POST', '/v1/snapshots', { body: { accounts: 'all' } });
  assert.deepEqual(r.body.accounts[0], {
    account_id: 'acc_1', venue: 'okx',
    positions: [{ symbol: 'BTCUSDT', qty: 1.5352 }, { symbol: 'ETHUSDT', qty: 0.9438 }, { symbol: 'SOLUSDT', qty: 0.7953 }],
    external_orders_count: 0, external_fills_count: 1,
  });
  assert.equal(r.body.accounts[1].account_id, 'acc_2');
  assert.equal(r.body.accounts[1].external_fills_count, 2);
  const one = await call('POST', '/v1/snapshots', { body: { accounts: ['acc_2'] } });
  assert.equal(one.body.accounts.length, 1);
  assert.deepEqual(one.body.accounts[0], r.body.accounts[1]);
});

test('snapshots: the account selector is required and must be "all" or a list', async () => {
  const miss = await call('POST', '/v1/snapshots', { body: {} });
  assert.equal(miss.status, 422);
  assert.equal(miss.body.error.message, 'missing required field: accounts');
  const bad = await call('POST', '/v1/snapshots', { body: { accounts: 'everything' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'invalid_field');
});

test('keys/inspect: permissions follow the venue and a destroyed key is reported as gone', async () => {
  const safe = await call('POST', '/v1/keys/inspect', { body: { venue: 'binance', key_ref: 'key_a' } });
  assert.deepEqual(safe.body, { can_trade: true, can_withdraw: false, can_transfer: false, ip_restricted: true, futures_enabled: false });
  const futures = await call('POST', '/v1/keys/inspect', { body: { venue: 'bybit', key_ref: 'key_a' } });
  assert.equal(futures.body.futures_enabled, true);
  const gone = await call('POST', '/v1/keys/destroy', { body: { key_ref: 'key_gone' } });
  assert.deepEqual(gone.body, { destroyed: true });
  const after = await call('POST', '/v1/keys/inspect', { body: { venue: 'binance', key_ref: 'key_gone' } });
  assert.deepEqual(after.body, { error: { code: 'key_not_found', message: 'key key_gone was destroyed' } });
});

test('keys: both key endpoints require their identifiers', async () => {
  const a = await call('POST', '/v1/keys/inspect', { body: { venue: 'binance' } });
  assert.equal(a.status, 422);
  assert.equal(a.body.error.message, 'missing required field: key_ref');
  const b = await call('POST', '/v1/keys/destroy', { body: {} });
  assert.equal(b.status, 422);
  assert.equal(b.body.error.message, 'missing required field: key_ref');
});

// ----------------------------------------------------------- fault injection
test('stub failure: x-stub-fail turns any endpoint into the requested status', async () => {
  const r = await call('GET', '/v1/snapshot', { headers: { 'x-stub-fail': '503' } });
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: { code: 'stub_failure', message: 'x-stub-fail requested by the caller' } });
  const other = await call('POST', '/v1/orders/batch', { headers: { 'x-stub-fail': '500' }, body: { request_id: 'r', orders: [{ parent_order_id: 'po_f', side: 'BUY', qty: 1 }] } });
  assert.equal(other.status, 500);
  const bogus = await call('GET', '/v1/headlines?since=15m', { headers: { 'x-stub-fail': 'nonsense' } });
  assert.equal(bogus.status, 503);
  const authed = await call('GET', '/v1/snapshot', { headers: { 'x-stub-fail': '503' }, token: 'wrong' });
  assert.equal(authed.status, 401);
  const retry = await call('GET', '/v1/snapshot', {});
  assert.equal(retry.status, 200);
});

test('stub delay: x-stub-delay-ms really delays and the cap is 5000 ms', async () => {
  const started = Date.now();
  const r = await call('GET', '/v1/snapshot', { headers: { 'x-stub-delay-ms': '150' } });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 200);
  assert.ok(elapsed >= 150, `elapsed ${elapsed}`);
  assert.ok(elapsed < 2000, `elapsed ${elapsed}`);
  assert.equal(clampDelayMs(undefined), 0);
  assert.equal(clampDelayMs(''), 0);
  assert.equal(clampDelayMs('abc'), 0);
  assert.equal(clampDelayMs('-5'), 0);
  assert.equal(clampDelayMs('0'), 0);
  assert.equal(clampDelayMs('150'), 150);
  assert.equal(clampDelayMs('150ms'), 150);
  assert.equal(clampDelayMs('99999'), MAX_STUB_DELAY_MS);
  assert.equal(MAX_STUB_DELAY_MS, 5000);
});

test('determinism: a second server process answers identically', async () => {
  const other = await start({ token: 'other-token' });
  try {
    const mine = await call('POST', '/v1/predict', { body: predictBody });
    const theirs = await fetch(`${other.base}/v1/predict`, {
      method: 'POST',
      headers: { authorization: 'Bearer other-token', 'content-type': 'application/json' },
      body: JSON.stringify(predictBody),
    });
    assert.deepEqual(await theirs.json(), mine.body);
    const wrong = await fetch(`${other.base}/v1/snapshot`, { headers: { authorization: 'Bearer stub-token' } });
    assert.equal(wrong.status, 401);
  } finally {
    await new Promise((resolve) => other.server.close(resolve));
  }
});

test('determinism: the stub source never calls Math.random or reads the wall clock', () => {
  const src = readFileSync(fileURLToPath(new URL('../stub-services.mjs', import.meta.url)), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!/Math\.random\s*\(/.test(src), 'the stub must not call Math.random');
  assert.ok(!/Date\.now\s*\(/.test(src), 'the stub must not read the wall clock');
  assert.ok(!/new Date\s*\(\s*\)/.test(src), 'the stub must not build a Date from the clock');
});

// ------------------------------------------------- consumer compatibility (n8n)
test('consumer: predict output passes wf03-validate-predictions', async () => {
  const { body } = await call('POST', '/v1/predict', { body: predictBody });
  const r = await runFirst('wf03-validate-predictions.js', {
    input: [body],
    nodes: { 'Gate decision': [{ cycle_id: CYCLE_ID, bar_ts: BAR_TS, mode: 'NORMAL' }] },
  });
  assert.equal(r.ok, true, JSON.stringify(r.sample_rejections));
  assert.equal(r.reason, null);
  assert.equal(r.reject_ratio, 0);
  assert.equal(r.kept.length, 5);
  assert.deepEqual(r.sample_rejections, []);
  assert.equal(r.regime, 'volatile');
  assert.equal(r.cycle_id, CYCLE_ID);
});

test('consumer: propose output passes wf03-prepare-outputs with five proposals', async () => {
  const [, { body: preds }] = await Promise.all([0, call('POST', '/v1/predict', { body: predictBody })]);
  const { body } = await call('POST', '/v1/propose', { body: { cycle_id: CYCLE_ID, bar_ts: BAR_TS, predictions: preds.predictions } });
  const r = await runFirst('wf03-prepare-outputs.js', {
    input: [body],
    nodes: { 'Validate predictions': [{ cycle_id: CYCLE_ID, kept: preds.predictions }] },
  });
  assert.equal(r.proposals.length, 5);
  assert.equal(r.dropped, 0);
  assert.deepEqual(r.proposals[0].proposal_id, `${CYCLE_ID}:acc_1:tsmom_v1:binance:BTCUSDT:BUY`);
  assert.equal(r.proposals[0].source, 'signal_cycle');
  assert.equal(r.proposals[0].reduce_only, false);
  assert.equal(r.proposals[0].pair_id, null);
  assert.equal(r.diagnostics.from_predictions, 5);
});

test('consumer: snapshot output is OK for wf07-normalize-snapshot then wf07-evaluate-breakers', async () => {
  const { body } = await call('GET', '/v1/snapshot');
  const normalized = await runFirst('wf07-normalize-snapshot.js', { input: [body], nodes: { 'Market stress event': [{}] } });
  assert.equal(normalized.snapshot.source, 'risk_svc');
  assert.equal(normalized.trigger, 'event');
  const r = await runFirst('wf07-evaluate-breakers.js', {
    input: [{ c: { policy: {}, modes: [], monitor: { fallback_streak: 0 }, recent_fingerprints: [] } }],
    nodes: { 'Normalize snapshot': [normalized] },
  });
  assert.equal(r.severity, 'OK', r.text);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.kills, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.fingerprint, 'ok');
});

test('consumer: exposure output passes wf14-verify-exposure for a cancel_all', async () => {
  const { body } = await call('POST', '/v1/exposure', { body: { scope: 'global', scope_id: '*' } });
  const r = await runFirst('wf14-verify-exposure.js', {
    input: [body],
    nodes: { 'Normalize request': [{ action: 'cancel_all', scope: 'global', scope_id: '*', reason: 'x', request_id: 'r' }] },
  });
  assert.equal(r.clean, true);
  assert.equal(r.severity, 'SEV2');
  assert.equal(r.open_orders, 0);
  assert.equal(r.residual_gross_usd, 11.85);
  assert.equal(r.request_id, 'r');
  assert.match(r.text, /\[KILL CANCEL_ALL\] global:\*/);
});

test('consumer: keys/inspect output is VERIFIED by wf10-key-policy, and futures keys are not', async () => {
  const { body } = await call('POST', '/v1/keys/inspect', { body: { venue: 'binance', key_ref: 'k' } });
  const connected = [{ body: { account_id: 'a', client_id: 'c', venue: 'binance', key_ref: 'k', email: 'e@x.y', derivatives_allowed: false } }];
  const r = await runFirst('wf10-key-policy.js', { input: [body], nodes: { 'Key connected': connected } });
  assert.equal(r.status, 'VERIFIED');
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.instructions, []);
  assert.equal(r.email, 'e@x.y');
  assert.equal(r.permissions.can_withdraw, false);

  const { body: futures } = await call('POST', '/v1/keys/inspect', { body: { venue: 'bybit', key_ref: 'k' } });
  const bad = await runFirst('wf10-key-policy.js', { input: [futures], nodes: { 'Key connected': connected } });
  assert.equal(bad.status, 'REJECTED');
  assert.deepEqual(bad.reasons, ['futures_permission_not_allowed_for_this_mandate']);

  const { body: gone } = await call('POST', '/v1/keys/inspect', { body: { venue: 'binance', key_ref: 'key_gone' } });
  const gonePolicy = await runFirst('wf10-key-policy.js', { input: [gone], nodes: { 'Key connected': connected } });
  assert.equal(gonePolicy.status, 'REJECTED');
  assert.deepEqual(gonePolicy.reasons, ['permission_check_failed', 'trading_permission_missing', 'withdrawals_must_be_disabled', 'ip_allowlist_required']);
  assert.equal(gonePolicy.instructions.length, 4);
});

test('consumer: headlines output yields one item per headline in wf02-split-headlines', async () => {
  const { body } = await call('GET', '/v1/headlines?since=15m');
  const items = await runCodeNode('wf02-split-headlines.js', { input: [body] });
  assert.equal(items.length, 3);
  assert.deepEqual(items[0].json, {
    source: 'coindesk',
    title: 'Spot volumes climb as flows rotate into majors',
    url: 'https://headlines.invalid/d2df5df4',
    published_at: '2026-10-02T11:55:00.000Z',
    symbols: ['ETHUSDT'],
    hash_input: 'coindesk|spot volumes climb as flows rotate into majors',
  });
  assert.equal(new Set(items.map((i) => i.json.hash_input)).size, 3);
});

test('consumer: signEvent output passes common-verify-signed-webhook and a tampered body does not', async () => {
  const secret = 'whsec-stub';
  const event = {
    event_id: 'evt_1',
    source: 'stream-gw',
    type: 'bar_close',
    ts: '2026-10-02T12:00:00Z',
    payload: { bar_ts: '2026-10-02T12:00:00.000Z', timeframe: '5m' },
  };
  const { headers, rawBody } = signEvent(secret, event);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(rawBody, JSON.stringify(event));
  assert.match(headers['x-aqos-signature'], /^sha256=[0-9a-f]{64}$/);
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  assert.equal(headers['x-aqos-signature'], `sha256=${expected}`);

  const good = await runFirst('common-verify-signed-webhook.js', {
    input: [{ headers, computed_sig: expected, body: JSON.parse(rawBody) }],
    now: '2026-10-02T12:00:10Z',
  });
  assert.equal(good.valid, true);
  assert.equal(good.reason, null);
  assert.equal(good.envelope.event_id, 'evt_1');
  assert.equal(good.envelope.type, 'bar_close');

  const tampered = JSON.stringify({ ...event, type: 'market_stress' });
  const bad = await runFirst('common-verify-signed-webhook.js', {
    input: [{ headers, computed_sig: createHmac('sha256', secret).update(tampered, 'utf8').digest('hex'), body: JSON.parse(tampered) }],
    now: '2026-10-02T12:00:10Z',
  });
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, 'bad_signature');
  assert.equal(bad.envelope, null);

  const stale = await runFirst('common-verify-signed-webhook.js', {
    input: [{ headers, computed_sig: expected, body: event }],
    now: '2026-10-02T12:05:00Z',
  });
  assert.equal(stale.reason, 'stale_or_missing_ts');
});

test('consumer: allocation/propose output passes wf08-bounded-change', async () => {
  const { body } = await call('POST', '/v1/allocation/propose', { body: { as_of: BAR_TS } });
  const r = await runFirst('wf08-bounded-change.js', { input: [body] });
  assert.equal(r.within_bounds, true, r.violations.join(','));
  assert.deepEqual(r.violations, []);
  assert.ok(Math.abs(r.turnover - 0.04) < 1e-12, `turnover ${r.turnover}`);
  assert.deepEqual(r.deltas.map((d) => d.strategy), ['basis_xex_v1', 'funding_carry_v1', 'statarb_ou_v1', 'tsmom_v1', 'xsmom_v1']);
  const tsmom = r.deltas.find((d) => d.strategy === 'tsmom_v1');
  assert.equal(tsmom.from, 0.3);
  assert.equal(tsmom.to, 0.32);
  assert.ok(Math.abs(tsmom.delta - 0.02) < 1e-12, `delta ${tsmom.delta}`);
});

// Unit tests for the gate-scope, escalation-collection, EMS batch and
// reconciliation/notification plumbing between n8n Code nodes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readScript } from '../lib/code.mjs';
import { runCodeNode, runFirst } from '../lib/sandbox.mjs';

// ------------------------------------------------------------------ gate scope
const scope = (rows) => runFirst('wf04-gate-scope.js', { input: rows });

test('gate scope: accounts and symbols are unique and n counts every input row', async () => {
  const r = await scope([
    { account_id: 'a1', symbol: 'BTCUSDT' },
    { account_id: 'a1', symbol: 'BTCUSDT' },
    { account_id: 'a2', symbol: 'ETHUSDT' },
  ]);
  assert.deepEqual(r.accounts, ['a1', 'a2']);
  assert.deepEqual(r.symbols, ['BTCUSDT', 'ETHUSDT']);
  assert.equal(r.n, 3);
});
test('gate scope: empty input loads nothing and reports n = 0', async () => {
  const r = await scope([]);
  assert.deepEqual(r.accounts, []);
  assert.deepEqual(r.symbols, []);
  assert.equal(r.n, 0);
});
test('gate scope: rows missing an account or symbol do not widen the scope', async () => {
  const r = await scope([{ account_id: 'a1', symbol: 'BTCUSDT' }, { account_id: null, symbol: null }, {}]);
  assert.deepEqual(r.accounts, ['a1']);
  assert.deepEqual(r.symbols, ['BTCUSDT']);
  assert.equal(r.n, 3);
});

// -------------------------------------------------------------- escalations
const esc = (escalations, now = '2026-10-02T12:00:10Z') => runFirst('wf04-collect-escalations.js', {
  input: [{}], nodes: { 'Pre-trade checks': [{ escalations }] }, now,
});
const mode = (o = {}) => ({ kind: 'mode', scope: 'account', scope_id: 'a1', mode: 'REDUCE_ONLY', reason: 'var', tier: 'T2', ...o });
const kill = (o = {}) => ({ kind: 'kill', scope: 'account', scope_id: 'a1', action: 'flatten_all', reason: 'breaks', ...o });

test('escalations: identical escalations collapse and the first one wins', async () => {
  const r = await esc([mode({ reason: 'first' }), mode({ reason: 'second', tier: 'T3' }), kill(), kill()]);
  assert.equal(r.actions.length, 1);
  assert.equal(r.kills.length, 1);
  assert.equal(r.actions[0].reason, 'first');
  assert.equal(r.actions[0].tier, 'T2');
});
test('escalations: mode changes become actions fingerprinted by scope, id and mode', async () => {
  const r = await esc([mode({ scope: 'account', scope_id: 'a1', mode: 'REDUCE_ONLY', tier: 'T2', metric: 'recon_diff_usd', value: 500, limit: 1000 })]);
  assert.deepEqual(r.actions, [{
    scope: 'account', scope_id: 'a1', mode: 'REDUCE_ONLY', reason: 'var', tier: 'T2',
    metric: 'recon_diff_usd', value: 500, limit: 1000, fingerprint: 'gate:account:a1:REDUCE_ONLY',
  }]);
  assert.deepEqual(r.kills, []);
});
test('escalations: different scopes or modes stay separate', async () => {
  const r = await esc([mode({ scope_id: 'a1' }), mode({ scope_id: 'a2' }), mode({ scope_id: 'a1', mode: 'HALT' })]);
  assert.equal(r.actions.length, 3);
  assert.deepEqual(r.actions.map((a) => a.fingerprint), [
    'gate:account:a1:REDUCE_ONLY', 'gate:account:a2:REDUCE_ONLY', 'gate:account:a1:HALT',
  ]);
});
test('escalations: kills are requested by the risk gate and bucketed per minute', async () => {
  const r = await esc([kill({ action: 'flatten_all' })], '2026-10-02T12:00:10Z');
  assert.deepEqual(r.kills, [{
    request_id: 'gate:account:a1:flatten_all:29849040',
    scope: 'account', scope_id: 'a1', action: 'flatten_all', reason: 'breaks', requested_by: 'risk_gate',
  }]);
});
test('escalations: repeats inside a minute share a request id, the next minute does not', async () => {
  const at = async (now) => (await esc([kill()], now)).kills[0].request_id;
  assert.equal(await at('2026-10-02T12:00:10Z'), await at('2026-10-02T12:00:59Z'));
  assert.notEqual(await at('2026-10-02T12:00:10Z'), await at('2026-10-02T12:01:05Z'));
});
test('escalations: nothing to escalate produces no items at all', async () => {
  assert.equal((await esc([])), undefined);
  assert.equal((await esc(undefined)), undefined);
  assert.equal((await esc([{ kind: 'note', scope: 'account', scope_id: 'a1' }])), undefined);
});

// ------------------------------------------------------------ kill fan-out
const FANOUT = readScript('common-fan-out-kills.js').replace('__SOURCE__', 'Collect escalations');
const fanOut = (item) => runCodeNode(FANOUT, { input: [{}], nodes: { 'Collect escalations': [item] } });

test('kill fan-out: one item per kill, carrying the whole request', async () => {
  const out = await fanOut({ kills: [{ request_id: 'r1', scope: 'account', scope_id: 'a1', action: 'flatten_all', requested_by: 'risk_gate' }, { request_id: 'r2', scope: 'global', action: 'cancel_all', requested_by: 'risk_gate' }] });
  assert.deepEqual(out.map((i) => i.json.request_id), ['r1', 'r2']);
  assert.deepEqual(out[1].json, { request_id: 'r2', scope: 'global', action: 'cancel_all', requested_by: 'risk_gate' });
});
test('kill fan-out: no kills produces no items', async () => {
  assert.deepEqual(await fanOut({ kills: [] }), []);
  assert.deepEqual(await fanOut({ actions: [] }), []);
});

// ------------------------------------------------------------------ EMS batch
const ems = (rows, now = '2026-10-02T12:00:00Z') => runFirst('wf05-ems-batch.js', { input: rows, now });
const emsRow = (o = {}) => ({ parent_order_id: 'd1', account_id: 'a1', strategy_id: 's1', venue: 'binance', symbol: 'BTCUSDT', side: 'BUY', qty: '0.1', order_type: 'LIMIT', limit_px: '60010', reduce_only: false, algo: 'IS', algo_params: { slice_s: 5 }, urgency: 'normal', pair_id: 'p1', arrival_mid: '60000', ...o });

test('EMS batch: rows without a parent order id are dropped, ids keep input order', async () => {
  const r = await ems([emsRow({ parent_order_id: null }), emsRow({ parent_order_id: 'd2' }), emsRow({ parent_order_id: 'd1' })]);
  assert.deepEqual(r.ids, ['d2', 'd1']);
  assert.equal(r.payload.orders.length, 2);
  assert.equal(r.payload.request_id, 'dispatch:d2:2');
});
test('EMS batch: numbers are coerced and missing prices stay null', async () => {
  const r = await ems([emsRow({ qty: '0.25', limit_px: '60010.5', arrival_mid: null, algo_params: undefined, pair_id: undefined })]);
  const o = r.payload.orders[0];
  assert.equal(o.qty, 0.25);
  assert.equal(o.limit_px, 60010.5);
  assert.equal(o.arrival_mid, null);
  assert.deepEqual(o.algo_params, {});
  assert.equal(o.pair_id, null);
});
test('EMS batch: reduce_only is true only for the boolean true', async () => {
  const r = await ems([emsRow({ parent_order_id: 'd1', reduce_only: true }), emsRow({ parent_order_id: 'd2', reduce_only: 'true' }), emsRow({ parent_order_id: 'd3', reduce_only: 1 }), emsRow({ parent_order_id: 'd4' })]);
  assert.deepEqual(r.payload.orders.map((o) => o.reduce_only), [true, false, false, false]);
});
test('EMS batch: the request id is the first id and the count, stamped with now', async () => {
  const r = await ems([emsRow({ parent_order_id: 'first' }), emsRow({ parent_order_id: 'second' }), emsRow({ parent_order_id: 'third' })], '2026-10-02T12:00:00Z');
  assert.equal(r.payload.request_id, 'dispatch:first:3');
  assert.equal(r.payload.sent_at, '2026-10-02T12:00:00.000Z');
  assert.deepEqual(r.ids, ['first', 'second', 'third']);
});

// -------------------------------------------------------------- break policy
const brk = (o = {}) => ({ break_id: 'b1', account_id: 'a1', venue: 'binance', symbol: 'BTCUSDT', classification: 'unknown', severity: 'HIGH', diff_qty: 1, diff_usd: 500, ...o });
const breaks = (rows) => runFirst('wf06-break-policy.js', { input: rows });
const acts = (r) => r.actions.map((a) => `${a.scope_id}:${a.mode}`);

test('break policy: no breaks produces no items, and rows without a break id do not count', async () => {
  assert.equal(await breaks([]), undefined);
  assert.equal(await breaks([{ account_id: 'a1', severity: 'HIGH' }]), undefined);
});
test('break policy: an unexplained HIGH break sets that account REDUCE_ONLY with the worst diff', async () => {
  const r = await breaks([brk({ diff_usd: 500 }), brk({ break_id: 'b2', diff_usd: 1500 }), brk({ break_id: 'b3', diff_usd: 20 })]);
  assert.deepEqual(acts(r), ['a1:REDUCE_ONLY']);
  assert.deepEqual(r.actions[0], {
    scope: 'account', scope_id: 'a1', mode: 'REDUCE_ONLY', reason: 'recon:unexplained_break', tier: 'T2',
    metric: 'recon_diff_usd', value: 1500, limit: 1000, fingerprint: 'recon:a1:b1,b2,b3',
  });
  assert.equal(r.severe, true);
});
test('break policy: explained, external or MEDIUM breaks are never penalised', async () => {
  assert.deepEqual(acts(await breaks([brk({ classification: 'fill_lag' })])), []);
  assert.deepEqual(acts(await breaks([brk({ classification: 'external_activity' })])), []);
  assert.deepEqual(acts(await breaks([brk({ severity: 'MEDIUM' })])), []);
  const r = await breaks([brk({ classification: 'fill_lag' })]);
  assert.equal(r.severity, 'SEV3');
  assert.equal(r.severe, false);
});
test('break policy: external activity is reported as an external account, not an action', async () => {
  const r = await breaks([brk({ classification: 'external_activity' }), brk({ break_id: 'b2', classification: 'external_activity', account_id: 'a2' }), brk({ break_id: 'b3', classification: 'fill_lag', account_id: 'a3' })]);
  assert.deepEqual(r.external_accounts, ['a1', 'a2']);
  assert.deepEqual(r.actions, []);
  assert.equal(r.severity, 'SEV3');
});
test('break policy: severity is SEV2 with an action and SEV3 without', async () => {
  assert.equal((await breaks([brk()])).severity, 'SEV2');
  assert.equal((await breaks([brk({ severity: 'LOW' })])).severity, 'SEV3');
});
test('break policy: accounts are handled independently', async () => {
  const r = await breaks([brk({ account_id: 'a1' }), brk({ break_id: 'b2', account_id: 'a2', severity: 'MEDIUM' }), brk({ break_id: 'b3', account_id: 'a2', classification: 'external_activity' }), brk({ break_id: 'b4', account_id: 'a3', diff_usd: 40 })]);
  assert.deepEqual(acts(r), ['a1:REDUCE_ONLY', 'a3:REDUCE_ONLY']);
  assert.deepEqual(r.external_accounts, ['a2']);
  assert.equal(r.severity, 'SEV2');
});

// ------------------------------------------------------------- notable events
const NOW = '2026-10-02T12:34:56Z';
const note = (o = {}) => ({ severity: 'SEV3', kind: 'slippage', account_id: 'a1', symbol: 'BTCUSDT', venue: 'binance', slippage_bps: 12, reason: 'outlier', ...o });
const events = (r, now = NOW) => runFirst('wf06-notable-events.js', { input: [{ r }], now });

test('notable events: nothing notable produces no items', async () => {
  assert.equal(await events({ notable: [] }), undefined);
  assert.equal(await events({}), undefined);
  assert.equal(await events({ notable: 'nope' }), undefined);
});
test('notable events: severity is the worst one present', async () => {
  assert.equal((await events({ notable: [note()] })).severity, 'SEV3');
  assert.equal((await events({ notable: [note(), note({ severity: 'SEV2' })] })).severity, 'SEV2');
  assert.equal((await events({ notable: [note({ severity: 'SEV2' }), note({ severity: 'SEV1', kind: 'liquidation' })] })).severity, 'SEV1');
});
test('notable events: at most 20 lines are sent, but the count stays whole', async () => {
  const r = await events({ notable: Array.from({ length: 25 }, (_, i) => note({ slippage_bps: i })) });
  assert.equal(r.count, 25);
  const lines = r.text.split('\n');
  assert.equal(lines.length, 21);
  assert.match(lines[0], /^\[SEV3] Execution events: 25 notable$/);
  assert.ok(lines[20].includes('19 bps'));
  assert.ok(!lines[20].includes('20 bps'));
});
test('notable events: the dedup key carries the severity and the hour', async () => {
  assert.equal((await events({ notable: [note()] })).dedup_key, 'exec-SEV3-2026-10-02T12');
  assert.equal((await events({ notable: [note({ severity: 'SEV1' })] })).dedup_key, 'exec-SEV1-2026-10-02T12');
  assert.equal((await events({ notable: [note()] }, '2026-10-02T13:00:01Z')).dedup_key, 'exec-SEV3-2026-10-02T13');
});
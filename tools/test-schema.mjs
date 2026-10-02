// Runs db/schema.sql + db/seed_example.sql in PGlite (real Postgres compiled
// to WebAssembly) and checks every invariant the n8n workflows depend on.
// Usage: node tools/test-schema.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? `\n        ${JSON.stringify(detail)}` : ''}`); }
}
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
// Calls fn($1::jsonb) the way the n8n Postgres node does.
const call = async (fn, payload = {}) => (await rows(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(payload)]))[0].r;
const callSet = async (fn, payload = {}) => rows(`SELECT * FROM ${fn}($1::jsonb)`, [JSON.stringify(payload)]);
const num = (v) => (v === null || v === undefined ? v : Number(v));

console.log('Loading schema and example seed…');
await db.exec(readFileSync(join(root, 'db/schema.sql'), 'utf8'));
await db.exec(readFileSync(join(root, 'db/seed_example.sql'), 'utf8'));
// Re-running the schema must be safe (deploys are idempotent).
await db.exec(readFileSync(join(root, 'db/schema.sql'), 'utf8'));
check('schema applies twice without error', true);

console.log('\nGate context');
const ctx = await call('risk.gate_context', { accounts: ['acc_a_binance', 'acc_b_binance'], symbols: ['BTCUSDT', 'ETHUSDT'] });
check('limits version resolved', ctx.limits_version === 'lim-2026.10-a', ctx.limits_version);
check('global mode included', ctx.global.mode === 'NORMAL');
check('account equity present', num(ctx.accounts.acc_a_binance.equity_usd) === 100000);
check('position notional computed', Math.abs(num(ctx.accounts.acc_a_binance.positions['BTCUSDT@binance'].notional_usd) - 24500.2) < 0.01,
  ctx.accounts.acc_a_binance.positions);
check('gross exposure = |BTC| + |ETH|', Math.abs(num(ctx.accounts.acc_a_binance.gross_exposure_usd) - (24500.2 + 12251.25)) < 0.01);
check('mandate limits merged', num(ctx.accounts.acc_a_binance.max_gross_leverage) === 2);
check('drawdown from HWM', Math.abs(num(ctx.accounts.acc_a_binance.drawdown_pct) - (1 - 100000 / 104000)) < 1e-9);
check('marks keyed SYMBOL@venue', num(ctx.marks['BTCUSDT@binance'].px) === 61250.5);
check('strategy gross attributed', num(ctx.strategies.tsmom_v1.gross_usd) > 24000);

console.log('\nRisk decisions are single-use tokens');
const decisionsPayload = {
  decisions: [
    { proposal_id: 'c1:acc_a_binance:tsmom_v1:BTCUSDT:BUY', cycle_id: 'c1', account_id: 'acc_a_binance', strategy_id: 'tsmom_v1',
      symbol: 'BTCUSDT', venue: 'binance', side: 'BUY', requested_qty: 0.2, approved_qty: 0.1, decision: 'RESIZE',
      order_type: 'LIMIT', limit_px: 61200, urgency: 'normal', mark_px: 61250.5, reasons: ['max_order_notional'],
      limits_version: 'lim-2026.10-a', state_version: ctx.state_version },
    { proposal_id: 'c1:acc_b_binance:tsmom_v1:LUNAUSDT:BUY', cycle_id: 'c1', account_id: 'acc_b_binance', strategy_id: 'tsmom_v1',
      symbol: 'LUNAUSDT', venue: 'binance', side: 'BUY', requested_qty: 100, approved_qty: 0, decision: 'REJECT',
      reasons: ['restricted_symbol'] },
  ],
};
await rows(`INSERT INTO alpha.cycles(cycle_id, strategy_set, bar_ts) VALUES ('c1','core', now())`);
const d1 = await callSet('risk.record_decisions', decisionsPayload);
check('two decisions recorded', d1.length === 2, d1.length);
const d1again = await callSet('risk.record_decisions', decisionsPayload);
check('re-recording the same proposals returns nothing (no double dispatch)', d1again.length === 0, d1again.length);
const resize = d1.find((d) => d.decision === 'RESIZE');
const reject = d1.find((d) => d.decision === 'REJECT');
check('reject is closed at birth', reject.status === 'CLOSED');
let threw = false;
try {
  await callSet('risk.record_decisions', { decisions: [{ ...decisionsPayload.decisions[0], proposal_id: 'bad', approved_qty: 0, decision: 'RESIZE' }] });
} catch { threw = true; }
check('a RESIZE with zero quantity is rejected by a constraint', threw);

const order = { decision_id: resize.decision_id, account_id: 'acc_a_binance', symbol: 'BTCUSDT', side: 'BUY', venue: 'binance', qty: 0.1, algo: 'TWAP' };
const po1 = await callSet('oms.submit_parent_orders', { orders: [order] });
check('token consumed once creates one parent order', po1.length === 1 && po1[0].parent_order_id === resize.decision_id);
const po2 = await callSet('oms.submit_parent_orders', { orders: [order] });
check('replaying the same token creates nothing', po2.length === 0);
const poReject = await callSet('oms.submit_parent_orders', { orders: [{ ...order, decision_id: reject.decision_id }] });
check('a REJECT decision can never become an order', poReject.length === 0);
const ctxPending = await call('risk.gate_context', { accounts: ['acc_a_binance'], symbols: ['BTCUSDT'] });
check('in-flight order counts as pending exposure (+0.1 BTC)', Math.abs(num(ctxPending.accounts.acc_a_binance.pending['BTCUSDT@binance']) - 0.1) < 1e-12,
  ctxPending.accounts.acc_a_binance.pending);

const [d2] = await callSet('risk.record_decisions', { decisions: [{ ...decisionsPayload.decisions[0], proposal_id: 'c1:over', approved_qty: 0.05, decision: 'RESIZE' }] });
const poOver = await callSet('oms.submit_parent_orders', { orders: [{ ...order, decision_id: d2.decision_id, qty: 0.06 }] });
check('qty above approved_qty is refused', poOver.length === 0);
const poSide = await callSet('oms.submit_parent_orders', { orders: [{ ...order, decision_id: d2.decision_id, side: 'SELL', qty: 0.05 }] });
check('side mismatch is refused', poSide.length === 0);
await rows(`UPDATE risk.decisions SET expires_at = now() - interval '1 second' WHERE decision_id = $1`, [d2.decision_id]);
const poExpired = await callSet('oms.submit_parent_orders', { orders: [{ ...order, decision_id: d2.decision_id, qty: 0.05 }] });
const [d2row] = await rows(`SELECT status FROM risk.decisions WHERE decision_id = $1`, [d2.decision_id]);
check('expired token is refused and marked EXPIRED', poExpired.length === 0 && d2row.status === 'EXPIRED', d2row);

console.log('\nExecution events and positions');
const poId = po1[0].parent_order_id;
const ts = (s) => new Date(Date.now() + s * 1000).toISOString();
const fills = {
  slippage_alert_bps: 25,
  events: [
    { event_id: 'ev1', type: 'ACK', parent_order_id: poId, ts: ts(0) },
    { event_id: 'ev2', type: 'PARTIAL_FILL', parent_order_id: poId, account_id: 'acc_a_binance', venue: 'binance', symbol: 'BTCUSDT', side: 'BUY', qty: 0.04, px: 61260, fee_usd: 0.98, ts: ts(1) },
    { event_id: 'ev3', type: 'FILL', parent_order_id: poId, account_id: 'acc_a_binance', venue: 'binance', symbol: 'BTCUSDT', side: 'BUY', qty: 0.06, px: 61500, fee_usd: 1.47, ts: ts(2) },
  ],
};
const ap1 = await call('oms.apply_execution_events', fills);
check('three events applied', ap1.applied === 3 && ap1.duplicates === 0, ap1);
const ap2 = await call('oms.apply_execution_events', fills);
check('replayed events are ignored', ap2.applied === 0 && ap2.duplicates === 3, ap2);
const [pos] = await rows(`SELECT qty, avg_px FROM oms.positions WHERE account_id='acc_a_binance' AND venue='binance' AND symbol='BTCUSDT'`);
const expectedAvg = (0.4 * 60000 + 0.04 * 61260 + 0.06 * 61500) / 0.5;
check('position quantity updated (0.4 + 0.1)', Math.abs(num(pos.qty) - 0.5) < 1e-12, pos);
check('average price is size-weighted on increases', Math.abs(num(pos.avg_px) - expectedAvg) < 1e-6, { got: pos.avg_px, expectedAvg });
const [poAfter] = await rows(`SELECT status, filled_qty, fees_usd FROM oms.parent_orders WHERE parent_order_id = $1`, [poId]);
check('parent order FILLED with fees', poAfter.status === 'FILLED' && Math.abs(num(poAfter.fees_usd) - 2.45) < 1e-9, poAfter);
check('slippage above 25 bps flagged', ap1.notable.some((n) => n.kind === 'slippage'), ap1.notable);
const liq = await call('oms.apply_execution_events', { events: [
  { event_id: 'ev4', type: 'ADL', account_id: 'acc_a_binance', venue: 'binance', symbol: 'ETHUSDT', side: 'BUY', qty: 1, px: 2460, ts: ts(3) },
] });
check('ADL is SEV1 notable and reduces the short', liq.notable[0]?.kind === 'adl' && liq.notable[0]?.severity === 'SEV1', liq);
const [eth] = await rows(`SELECT qty, avg_px FROM oms.positions WHERE account_id='acc_a_binance' AND symbol='ETHUSDT'`);
check('reducing a short keeps its average price', num(eth.qty) === -4 && num(eth.avg_px) === 2500, eth);

const ctxAfterFill = await call('risk.gate_context', { accounts: ['acc_a_binance'], symbols: ['BTCUSDT'] });
check('filled order no longer counts as pending', ctxAfterFill.accounts.acc_a_binance.pending['BTCUSDT@binance'] === undefined,
  ctxAfterFill.accounts.acc_a_binance.pending);
const [d3] = await callSet('risk.record_decisions', { decisions: [{ ...decisionsPayload.decisions[0], proposal_id: 'c1:unconfirmed', approved_qty: 0.01, decision: 'RESIZE' }] });
const [po3] = await callSet('oms.submit_parent_orders', { orders: [{ ...order, decision_id: d3.decision_id, qty: 0.01 }] });
const mu = await call('oms.mark_unconfirmed', { parent_order_ids: [po3.parent_order_id], reason: 'ems_timeout' });
const ctxUnconf = await call('risk.gate_context', { accounts: ['acc_a_binance'], symbols: ['BTCUSDT'] });
check('timed-out send becomes SEND_UNCONFIRMED and still counts as exposure', Number(mu.updated) === 1
  && Math.abs(num(ctxUnconf.accounts.acc_a_binance.pending['BTCUSDT@binance']) - 0.01) < 1e-12, { mu, pending: ctxUnconf.accounts.acc_a_binance.pending });
await rows(`UPDATE oms.parent_orders SET updated_at = now() - interval '5 minutes' WHERE parent_order_id = $1`, [po3.parent_order_id]);
const frU = await call('ops.freshness_report');
check('supervisor sees an order stuck unconfirmed', Number(frU.unconfirmed_orders) === 1, frU.unconfirmed_orders);
await call('oms.apply_execution_events', { events: [{ event_id: 'ev-unconf-cancel', type: 'CANCELLED', parent_order_id: po3.parent_order_id, ts: ts(2.5), reason: 'ems reported never worked' }] });

console.log('\nRisk monitor bookkeeping');
const aa1 = await call('risk.apply_actions', { snapshot_source: 'db_fallback', fingerprint: 'pass-1', actions: [] });
const aa2 = await call('risk.apply_actions', { snapshot_source: 'db_fallback', fingerprint: 'pass-2', actions: [
  { scope: 'account', scope_id: 'acc_a_bybit', action: 'cancel_all', tier: 'T3', fingerprint: 'kill:account:acc_a_bybit:cancel_all' },
] });
const bc = await call('risk.breaker_context');
check('fallback snapshots increment the streak', bc.monitor.fallback_streak === 2, bc.monitor);
check('kill actions are recorded with their own fingerprint', bc.recent_fingerprints.includes('kill:account:acc_a_bybit:cancel_all'), bc.recent_fingerprints);
await call('risk.apply_actions', { snapshot_source: null, fingerprint: 'recon', actions: [] });
const bc2 = await call('risk.breaker_context');
check('reconciliation actions do not touch the risk-monitor streak', bc2.monitor.fallback_streak === 2, bc2.monitor);
await call('risk.apply_actions', { snapshot_source: 'risk_svc', fingerprint: 'pass-3', actions: [] });
const bc3 = await call('risk.breaker_context');
check('a real snapshot resets the streak', bc3.monitor.fallback_streak === 0, bc3.monitor);

console.log('\nReconciliation adopts venue truth');
const breaks = await callSet('oms.reconcile', { accounts: [
  { account_id: 'acc_a_binance', venue: 'binance', positions: [{ symbol: 'BTCUSDT', qty: 0.5 }, { symbol: 'ETHUSDT', qty: -4 }, { symbol: 'SOLUSDT', qty: 10 }] },
] });
check('one unknown break (unexpected SOL position)', breaks.length === 1 && breaks[0].symbol === 'SOLUSDT' && breaks[0].classification === 'unknown', breaks);
check('unexplained $1,421 break is HIGH (>= max($1k, 1% equity)) and resolved', breaks[0].severity === 'HIGH' && breaks[0].resolved === true, breaks[0]);
const [sol] = await rows(`SELECT qty, source FROM oms.positions WHERE account_id='acc_a_binance' AND symbol='SOLUSDT'`);
check('internal book now equals venue', num(sol.qty) === 10 && sol.source === 'venue_recon', sol);
const ext = await callSet('oms.reconcile', { accounts: [
  { account_id: 'acc_a_binance', venue: 'binance', external_orders_count: 2, positions: [{ symbol: 'BTCUSDT', qty: 0.9 }, { symbol: 'ETHUSDT', qty: -4 }, { symbol: 'SOLUSDT', qty: 10 }] },
] });
check('client manual trading classified as external_activity', ext[0]?.classification === 'external_activity', ext);
const fr = await call('ops.freshness_report');
check('freshness report sees reconciliation heartbeat', fr.heartbeat_age_s.reconciliation !== undefined, fr.heartbeat_age_s);

console.log('\nRisk modes ratchet');
let m = await call('risk.apply_mode', { scope: 'account', scope_id: 'acc_b_binance', mode: 'HALT', reason: 'max_drawdown', set_by: 'risk_monitor' });
check('escalation NORMAL -> HALT applies', m.changed === true && m.mode === 'HALT');
m = await call('risk.apply_mode', { scope: 'account', scope_id: 'acc_b_binance', mode: 'REDUCE_ONLY', reason: 'x', set_by: 'agent' });
check('silent de-escalation is ignored', m.changed === false && m.mode === 'HALT', m);
threw = false;
try { await call('risk.apply_mode', { scope: 'account', scope_id: 'acc_b_binance', mode: 'NORMAL', allow_deescalate: true, approver_ids: ['ops.alice'] }); } catch { threw = true; }
check('de-escalation with one approver raises', threw);
m = await call('risk.apply_mode', { scope: 'account', scope_id: 'acc_b_binance', mode: 'NORMAL', reason: 'reviewed', allow_deescalate: true, approver_ids: ['ops.alice', 'risk.bob'] });
check('four-eyes de-escalation applies', m.changed === true && m.mode === 'NORMAL', m);

console.log('\nAgents may only tighten limits');
let lc = await call('risk.propose_limit_change', { scope: 'account', scope_id: 'acc_a_binance', limit_name: 'max_gross_leverage', new_value: 1.5, rationale: 'correlation spike', requested_by: 'risk_agent' });
check('lowering a max_* limit applies immediately', lc.status === 'APPLIED', lc);
lc = await call('risk.propose_limit_change', { scope: 'account', scope_id: 'acc_a_binance', limit_name: 'max_gross_leverage', new_value: 3, requested_by: 'risk_agent' });
check('raising a max_* limit waits for a human', lc.status === 'PENDING_HUMAN', lc);
lc = await call('risk.propose_limit_change', { scope: 'global', limit_name: 'max_order_notional_usd', new_value: 200000, requested_by: 'risk_agent' });
const [cur] = await rows(`SELECT limits_version, doc->'global'->>'max_order_notional_usd' AS v FROM risk.current_limits`);
check('global tightening creates a new limits version', lc.status === 'APPLIED' && num(cur.v) === 200000 && cur.limits_version !== 'lim-2026.10-a', cur);

console.log('\nModel lifecycle ratchet');
let tr = await call('research.propose_transition', { model_id: 'statarb_ou_v1@ou-2026.08', to_stage: 'shadow', rationale: 'live/backtest z = -2.8' });
check('demotion production -> shadow is auto-approved', tr.status === 'AUTO_APPROVED', tr);
tr = await call('research.propose_transition', { model_id: 'xsmom_v1@tft-2026.09', to_stage: 'production', rationale: 'promising' });
check('promotion to production needs a human', tr.status === 'PENDING_HUMAN', tr);

console.log('\nBilling never liquidates');
let be = await call('biz.apply_billing_event', { event_id: 'evt_1', type: 'customer.subscription.deleted', customer_id: 'cus_stripe_b' });
const [modeB] = await rows(`SELECT mode, reason FROM risk.modes WHERE scope='account' AND scope_id='acc_b_binance'`);
check('cancellation moves accounts to REDUCE_ONLY (billing hold)', be.status === 'CANCELED' && modeB.mode === 'REDUCE_ONLY' && modeB.reason.startsWith('billing:'), { be, modeB });
be = await call('biz.apply_billing_event', { event_id: 'evt_1', type: 'customer.subscription.deleted', customer_id: 'cus_stripe_b' });
check('duplicate Stripe event ignored', be.duplicate === true);
be = await call('biz.apply_billing_event', { event_id: 'evt_2', type: 'invoice.paid', customer_id: 'cus_stripe_b' });
const [modeB2] = await rows(`SELECT mode FROM risk.modes WHERE scope='account' AND scope_id='acc_b_binance'`);
check('payment lifts only the billing hold', modeB2.mode === 'NORMAL', { be, modeB2 });
await call('risk.apply_mode', { scope: 'account', scope_id: 'acc_b_binance', mode: 'HALT', reason: 'max_drawdown', set_by: 'risk_monitor' });
await call('biz.apply_billing_event', { event_id: 'evt_3', type: 'invoice.paid', customer_id: 'cus_stripe_b' });
const [modeB3] = await rows(`SELECT mode FROM risk.modes WHERE scope='account' AND scope_id='acc_b_binance'`);
check('payment cannot lift a risk HALT', modeB3.mode === 'HALT', modeB3);

console.log('\nLeases with fencing epochs');
let l = await call('ops.try_acquire_lease', { name: 'ems-leader', holder: 'ems-a', ttl_s: 30 });
check('first holder acquires epoch 1', l.acquired && Number(l.epoch) === 1, l);
l = await call('ops.try_acquire_lease', { name: 'ems-leader', holder: 'ems-b', ttl_s: 30 });
check('second holder is blocked while lease is live', !l.acquired && l.holder === 'ems-a', l);
await rows(`UPDATE ops.leases SET expires_at = now() - interval '1 second' WHERE name = 'ems-leader'`);
l = await call('ops.try_acquire_lease', { name: 'ems-leader', holder: 'ems-b', ttl_s: 30 });
check('after expiry the standby takes over with epoch 2', l.acquired && Number(l.epoch) === 2, l);
const fenceOld = (await rows(`SELECT ops.check_fence($1::jsonb) AS ok`, [JSON.stringify({ name: 'ems-leader', holder: 'ems-a', epoch: 1 })]))[0].ok;
check('old leader is fenced off', fenceOld === false);

console.log('\nIdempotent claims, incidents, kill requests');
const c1 = await call('alpha.claim_cycle', { cycle_id: 'core5m:2026-10-02T00:05:00Z', bar_ts: '2026-10-02T00:05:00Z', trigger: 'event' });
const c2 = await call('alpha.claim_cycle', { cycle_id: 'core5m:2026-10-02T00:05:00Z', bar_ts: '2026-10-02T00:05:00Z', trigger: 'schedule' });
check('bar-close event and schedule backstop cannot both run a cycle', c1.claimed === true && c2.claimed === false);
const i1 = await call('ops.record_incident', { fingerprint: 'AQOS05:Send to EMS:ETIMEDOUT', workflow_id: 'AQOS05ExecDisptc', message: 'timeout' });
const i2 = await call('ops.record_incident', { fingerprint: 'AQOS05:Send to EMS:ETIMEDOUT', workflow_id: 'AQOS05ExecDisptc', message: 'timeout' });
check('incident dedupes and counts hits in window', i1.is_new === true && i2.is_new === false && Number(i2.occurrences_window) === 2, { i1, i2 });
const k1 = await call('ops.record_kill_request', { request_id: 'kill-1', scope: 'global', action: 'halt_new', requested_by: 'ops.alice' });
const k2 = await call('ops.record_kill_request', { request_id: 'kill-1', scope: 'global', action: 'halt_new', requested_by: 'ops.alice' });
check('kill request is idempotent', k1.duplicate === false && k2.duplicate === true);

console.log('\nData, research, allocations, reporting');
const h = await call('alt.filter_new_headlines', { items: [{ hash: 'h1', title: 'Exchange X pauses withdrawals', symbols: ['BTC'] }, { hash: 'h1', title: 'dup' }] });
const h2 = await call('alt.filter_new_headlines', { items: [{ hash: 'h1', title: 'Exchange X pauses withdrawals' }] });
check('headline dedupe within and across batches', Number(h.count) === 1 && Number(h2.count) === 0, { h, h2 });
const s = await call('alt.record_sentiment', { model: 'claude-opus-5-5', scores: [{ hash: 'h1', asset: 'btc', score: -3, relevance: 0.9, event_type: 'venue_risk' }] });
const [sc] = await rows(`SELECT score FROM alt.sentiment_scores WHERE hash='h1'`);
check('sentiment scores are clipped to [-1, 1]', Number(s.recorded) === 1 && num(sc.score) === -1, sc);
const fu = await call('md.upsert_funding', { rows: [
  { venue: 'binance', symbol: 'BTCUSDT', ts: '2026-10-02T00:00:00Z', funding_rate: 0.0001 },
  { venue: 'binance', symbol: 'BTCUSDT', ts: '2026-10-02T00:00:00Z', funding_rate: 0.0002 },
] });
check('funding upsert tolerates duplicate keys in one batch', Number(fu.upserted) === 1, fu);
const drift = await callSet('pm.drift_report');
check('drift report flags BTC underweight', drift.some((d) => d.account_id === 'acc_a_binance'), drift);
const st = await call('pm.stage_allocation', { weights: { tsmom_v1: 0.5, funding_carry_v1: 0.5 }, token: 'f'.repeat(32), rationale: 'regime shift' });
const bad = await call('pm.verify_approval', { version_id: st.version_id, token: 'e'.repeat(32), decision: 'approve' });
const good = await call('pm.verify_approval', { version_id: st.version_id, token: 'f'.repeat(32), decision: 'approve', approver: 'cio' });
check('allocation approval needs the right one-time token', bad.approved === false && good.approved === true, { bad, good });
const brief = await call('research.agent_brief');
check('research brief lists models and pending transitions', brief.models.length === 3 && brief.pending_transitions.length === 1, brief.pending_transitions);
const close = await call('pnl.close_day', { day: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
check('day close snapshots every account', Number(close.accounts_closed) === 3, close);
const due = await callSet('biz.reports_due');
check('reports due for active clients', due.length === 2, due.map((d) => d.email));
const rr1 = await call('biz.record_report', { client_id: due[0].client_id, period: due[0].period, content_sha256: 'x' });
const rr2 = await call('biz.record_report', { client_id: due[0].client_id, period: due[0].period, content_sha256: 'x' });
check('a report is sent at most once per period', rr1.duplicate === false && rr2.duplicate === true);
const fb = await callSet('biz.fee_burden_report', { threshold_annual_pct: 2 });
check('fee-burden guardrail flags the small account', fb.length === 1 && fb[0].email === 'client.b@example.com', fb);
const grad = await callSet('biz.graduation_candidates');
check('graduation needs 14 paper days (client B has 20) and a verified key', grad.length === 1, grad);

console.log('\nAudit chain');
const v1 = await call('ops.verify_audit_chain');
check('hash chain verifies', v1.ok === true && v1.checked > 10, v1);
await rows(`UPDATE ops.audit_log SET payload = '{"tampered": true}' WHERE seq = 3`);
const v2 = await call('ops.verify_audit_chain');
check('tampering is detected at the edited row', v2.ok === false && Number(v2.broken_at_seq) === 3, v2);

console.log(`\n${passed} passed, ${failed} failed`);
await db.close();
process.exit(failed ? 1 : 0);

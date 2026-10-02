// Unit tests for the Code-node scripts that guard capital, clients or system state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFirst, runCodeNode } from '../lib/sandbox.mjs';

// ------------------------------------------------------------------ breakers
const POLICY = {};
const baseCtx = (over = {}) => ({ policy: POLICY, modes: [], monitor: { fallback_streak: 0 }, recent_fingerprints: [], ...over });
const breakers = (snapshot, c = baseCtx()) => runFirst('wf07-evaluate-breakers.js', { input: [{ c }], nodes: { 'Normalize snapshot': [{ snapshot: { source: 'risk_svc', ...snapshot } }] } });
const acts = (r) => r.actions.map((a) => `${a.scope}:${a.scope_id}:${a.mode ?? a.action}`);

test('breakers: a calm snapshot does nothing', async () => {
  const r = await breakers({ global: { var_limit_usd: 100, var_99_1d_usd: 40, es_limit_usd: 150, es_975_1d_usd: 60 }, accounts: [{ account_id: 'a', drawdown_pct: 0.01, max_drawdown_pct: 0.15, day_pnl_pct: 0, daily_loss_limit_pct: 0.03 }] });
  assert.equal(r.severity, 'OK');
  assert.deepEqual(r.actions, []);
});
test('breakers: VaR at 90% of limit warns only', async () => {
  const r = await breakers({ global: { var_limit_usd: 100, var_99_1d_usd: 90 } });
  assert.equal(r.severity, 'WARN');
  assert.deepEqual(r.actions, []);
});
test('breakers: VaR at the limit reduces globally', async () => {
  const r = await breakers({ global: { var_limit_usd: 100, var_99_1d_usd: 100 } });
  assert.deepEqual(acts(r), ['global:*:REDUCE_ONLY']);
  assert.equal(r.severity, 'ACT');
});
test('breakers: ES at 125% halts and cancels everything', async () => {
  const r = await breakers({ global: { es_limit_usd: 100, es_975_1d_usd: 130 } });
  assert.ok(acts(r).includes('global:*:HALT') && acts(r).includes('global:*:cancel_all'));
  assert.equal(r.kills.length, 1);
  assert.ok(r.kills[0].request_id && r.kills[0].requested_by === 'risk_monitor');
});
test('breakers: stablecoin depeg reduces at 50 bps and halts at 200 bps', async () => {
  assert.deepEqual(acts(await breakers({ global: { stablecoin_depeg_bps: { USDT: 60 } } })), ['global:*:REDUCE_ONLY']);
  const r = await breakers({ global: { stablecoin_depeg_bps: { USDC: -250 } } });
  assert.ok(acts(r).includes('global:*:HALT') && acts(r).includes('global:*:cancel_all'));
});
test('breakers: venue down halts that venue; suspended withdrawals reduce it', async () => {
  assert.deepEqual(acts(await breakers({ venues: [{ venue: 'x', health: 'DOWN' }] })), ['venue:x:HALT']);
  assert.deepEqual(acts(await breakers({ venues: [{ venue: 'y', health: 'UP', withdrawals_suspended: true }] })), ['venue:y:REDUCE_ONLY']);
});
test('breakers: max drawdown halts the account; flatten only if the client opted in', async () => {
  const a = { account_id: 'a1', drawdown_pct: 0.2, max_drawdown_pct: 0.15 };
  assert.ok(acts(await breakers({ accounts: [a] })).includes('account:a1:cancel_all'));
  assert.ok(acts(await breakers({ accounts: [{ ...a, auto_flatten_on_max_dd: true }] })).includes('account:a1:flatten'));
});
test('breakers: daily loss reduces the account', async () => {
  assert.deepEqual(acts(await breakers({ accounts: [{ account_id: 'a1', day_pnl_pct: -0.04, daily_loss_limit_pct: 0.03 }] })), ['account:a1:REDUCE_ONLY']);
});
test('breakers: liquidation distance 2.5 sigma reduces; 1.2 sigma halts and flattens', async () => {
  assert.deepEqual(acts(await breakers({ accounts: [{ account_id: 'a1', min_liq_distance_sigma: 2.5 }] })), ['account:a1:REDUCE_ONLY']);
  const r = await breakers({ accounts: [{ account_id: 'a1', min_liq_distance_sigma: 1.2 }] });
  assert.ok(acts(r).includes('account:a1:HALT') && acts(r).includes('account:a1:flatten'));
});
test('breakers: an action that would not change state is dropped', async () => {
  const c = baseCtx({ modes: [{ scope: 'global', scope_id: '*', mode: 'HALT' }] });
  const r = await breakers({ global: { var_limit_usd: 100, var_99_1d_usd: 120 } }, c);
  assert.deepEqual(r.actions, []);
});
test('breakers: a kill already issued in the last 30 minutes is not repeated', async () => {
  const c = baseCtx({ recent_fingerprints: ['kill:global:*:cancel_all'] });
  const r = await breakers({ global: { es_limit_usd: 100, es_975_1d_usd: 130 } }, c);
  assert.equal(r.kills.length, 0);
});
test('breakers: eight fallback snapshots in a row mean risk is unmeasurable', async () => {
  const r = await runFirst('wf07-evaluate-breakers.js', { input: [{ c: baseCtx({ monitor: { fallback_streak: 7 } }) }], nodes: { 'Normalize snapshot': [{ snapshot: { source: 'db_fallback' } }] } });
  assert.deepEqual(acts(r), ['global:*:REDUCE_ONLY']);
});
test('breakers: stale marks beyond 60 s reduce globally', async () => {
  assert.deepEqual(acts(await breakers({ global: { max_mark_age_s: 90 } })), ['global:*:REDUCE_ONLY']);
});

// ------------------------------------------------------------------ dispatch
const dispatch = (decisions, { breaker = null, mode = 'NORMAL' } = {}) => runFirst('wf05-prepare-dispatch.js', {
  input: [{}], nodes: { 'Approved decisions in': decisions, 'EMS breaker state': [{ ems_breaker: breaker }], 'Global mode re-check': [{ redis_mode: mode }] } });
const dec = (o = {}) => ({ decision_id: 'd1', account_id: 'a', venue: 'binance', symbol: 'BTCUSDT', side: 'BUY', approved_qty: '0.1', mark_px: '60000', order_type: 'LIMIT', limit_px: '60010', urgency: 'normal', reduce_only: false, ...o });

test('dispatch: algorithm follows urgency and size', async () => {
  assert.equal((await dispatch([dec({ urgency: 'high' })])).dispatch[0].algo, 'IS');
  assert.equal((await dispatch([dec({ urgency: 'low' })])).dispatch[0].algo, 'PASSIVE_LIMIT');
  assert.equal((await dispatch([dec({ approved_qty: '1' })])).dispatch[0].algo, 'TWAP');
  assert.equal((await dispatch([dec({ approved_qty: '0.1' })])).dispatch[0].algo, 'LIMIT_LADDER');
});
test('dispatch: quantities and prices are numbers', async () => {
  const o = (await dispatch([dec()])).dispatch[0];
  assert.equal(typeof o.qty, 'number');
  assert.equal(o.qty, 0.1);
  assert.equal(o.limit_px, 60010);
});
test('dispatch: a global halt after the gate skips everything', async () => {
  const r = await dispatch([dec(), dec({ decision_id: 'd2' })], { mode: 'HALT' });
  assert.equal(r.dispatch.length, 0);
  assert.deepEqual(r.skipped_ids, ['d1', 'd2']);
  assert.match(r.skip_reason, /global_halt_after_gate/);
});
test('dispatch: an unknown mode value halts (fail closed)', async () => {
  assert.equal((await dispatch([dec()], { mode: 'WEIRD' })).dispatch.length, 0);
});
test('dispatch: reduce-only after the gate lets only reducing orders through', async () => {
  const r = await dispatch([dec({ decision_id: 'open', reduce_only: false }), dec({ decision_id: 'close', reduce_only: true })], { mode: 'REDUCE_ONLY' });
  assert.deepEqual(r.dispatch.map((d) => d.decision_id), ['close']);
  assert.deepEqual(r.skipped_ids, ['open']);
});
test('dispatch: an open EMS circuit skips dispatch', async () => {
  const r = await dispatch([dec()], { breaker: 'OPEN' });
  assert.equal(r.dispatch.length, 0);
  assert.match(r.skip_reason, /ems_circuit_open/);
});
test('dispatch: rows without a decision id are ignored', async () => {
  assert.equal((await dispatch([dec({ decision_id: null })])).dispatch.length, 0);
});

test('EMS breaker opens at the third failure', async () => {
  const run = (n) => runFirst('wf05-breaker.js', { input: [{ 'aqos:breaker:ems_fails': n }], nodes: { 'EMS batch': [{ ids: ['x', 'y'] }] } });
  assert.equal((await run(2)).open, false);
  const r = await run(3);
  assert.equal(r.open, true);
  assert.deepEqual(r.parent_order_ids, ['x', 'y']);
  assert.equal(r.severity, 'SEV1');
});

// -------------------------------------------------------------- compliance gate
const METRICS = { mode: 'LIVE', accounts: [{ account_id: 'acc_1', equity_usd: 100000, day_change_usd: -500.25, fees_usd: 12.5, risk_mode: 'NORMAL' }], breaker_events: [] };
const llm = (draft, extra = {}) => ({ statusCode: 200, body: { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(draft) }], ...extra } });
const gate = async (response) => (await runFirst('wf12-compliance-gate.js', { input: [response], nodes: { 'Build narrative request': [{ client_id: 'c1', period: '2026-10-01', metrics: METRICS, anthropic_request: {} }] } }));
const draft = (summary, extra = {}) => ({ subject: 'Your daily summary', summary_md: summary, highlights: [], risk_notes: [], ...extra });

test('compliance: a factual draft using only the client numbers passes', async () => {
  const r = await gate(llm(draft('Equity was USD 100000 and the day change was -500.25. Fees were 12.5.')));
  assert.equal(r.compliance.pass, true, JSON.stringify(r.compliance));
});
for (const [label, text] of [
  ['guarantee', 'Returns are guaranteed.'], ['risk-free', 'This is risk-free.'], ['risk free spaced', 'A risk free approach.'],
  ['advice', 'You should buy more BTC.'], ['recommend', 'We recommend increasing exposure.'], ['promise', 'You will earn more next week.'],
  ['passive income', 'A source of passive income.'], ['hype', 'To the moon.'], ['safe bet', 'A safe bet for you.'],
]) {
  test(`compliance: rejects "${label}"`, async () => {
    const r = await gate(llm(draft(text)));
    assert.equal(r.compliance.pass, false);
    assert.ok(r.compliance.issues.some((i) => i.startsWith('banned_phrase')), r.compliance.issues.join());
  });
}
test('compliance: rejects a number that is not in the client data', async () => {
  const r = await gate(llm(draft('Equity grew by 7345.5 today.')));
  assert.equal(r.compliance.pass, false);
  assert.ok(r.compliance.issues.some((i) => i.startsWith('unsupported_numbers')));
});
test('compliance: a hidden number in highlights is also checked', async () => {
  const r = await gate(llm(draft('All fine.', { highlights: ['Profit of 98765 today'] })));
  assert.equal(r.compliance.pass, false);
});
test('compliance: rejects links and over-long drafts', async () => {
  assert.equal((await gate(llm(draft('See https://example.com for more.')))).compliance.pass, false);
  assert.equal((await gate(llm(draft('x'.repeat(1300))))).compliance.pass, false);
});
test('compliance: a refusal, truncation, HTTP error or invalid JSON all fail closed', async () => {
  for (const resp of [
    { statusCode: 200, body: { stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [] } },
    { statusCode: 200, body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"subject":"x"' }] } },
    { statusCode: 529, body: { error: { type: 'overloaded_error' } } },
    { statusCode: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] } },
    { error: { message: 'ETIMEDOUT' } },
  ]) {
    const r = await gate(resp);
    assert.equal(r.compliance.pass, false);
    assert.equal(r.draft, null);
  }
});
test('report email: model text is HTML-escaped and the disclosure is always present', async () => {
  const [out] = await runCodeNode('wf12-render-email.js', { input: [{ client_id: 'c1', period: 'p', email: 'a@b.c', metrics: METRICS,
    draft: { subject: 'S', summary_md: '<script>alert(1)</script> **bold**', highlights: [], risk_notes: [] }, compliance: { pass: true, issues: [] } }] });
  assert.ok(!out.json.html.includes('<script>'));
  assert.match(out.json.html, /not investment advice/);
});
test('report email: a failed compliance gate uses the template narrative', async () => {
  const [out] = await runCodeNode('wf12-render-email.js', { input: [{ client_id: 'c1', period: 'p', email: 'a@b.c', metrics: METRICS,
    draft: { subject: 'GUARANTEED GAINS', summary_md: 'You will earn a lot', highlights: [], risk_notes: [] }, compliance: { pass: false, issues: ['banned_phrase'] } }] });
  assert.ok(!out.json.html.includes('earn a lot'));
  assert.ok(!out.json.subject.includes('GUARANTEED'));
});

// ----------------------------------------------------------- bounded autonomy
const bounded = (proposed, current) => runFirst('wf08-bounded-change.js', { input: [{ proposed_weights: proposed, current_weights: current }] });
test('allocation: a 5 pp move inside 15% turnover is within bounds', async () => {
  const r = await bounded({ a: 0.45, b: 0.55 }, { a: 0.4, b: 0.6 });
  assert.equal(r.within_bounds, true);
});
test('allocation: a 6 pp move is out of bounds', async () => {
  const r = await bounded({ a: 0.46, b: 0.54 }, { a: 0.4, b: 0.6 });
  assert.equal(r.within_bounds, false);
  assert.ok(r.violations.some((v) => v.startsWith('step_')));
});
test('allocation: weights that do not sum to one are out of bounds', async () => {
  assert.equal((await bounded({ a: 0.5, b: 0.6 }, { a: 0.5, b: 0.5 })).within_bounds, false);
});
test('allocation: negative weights and empty proposals are out of bounds', async () => {
  assert.equal((await bounded({ a: 1.1, b: -0.1 }, { a: 1, b: 0 })).within_bounds, false);
  assert.equal((await bounded({}, { a: 1 })).within_bounds, false);
});
test('allocation: turnover above 15% is out of bounds even with small steps', async () => {
  const cur = Object.fromEntries('abcdefgh'.split('').map((k) => [k, 0.125]));
  const prop = Object.fromEntries('abcdefgh'.split('').map((k, i) => [k, i < 4 ? 0.125 + 0.04 : 0.125 - 0.04]));
  const r = await bounded(prop, cur);
  assert.equal(r.within_bounds, false);
  assert.ok(r.violations.some((v) => v.startsWith('turnover_')));
});
test('allocation: a timed-out approval is never an approval', async () => {
  const r = await runFirst('wf08-approval-result.js', { input: [{ query: {} }], nodes: { 'Build approval message': [{ version_id: 7 }], 'Approval token': [{ token: 't'.repeat(64) }] } });
  assert.equal(r.decision, 'timeout');
  assert.equal(r.timed_out, true);
});

// ----------------------------------------------------------------- predictions
const validate = (resp, barTs = '2026-10-02T00:05:00.000Z') => runFirst('wf03-validate-predictions.js', { input: [resp], nodes: { 'Gate decision': [{ cycle_id: `core5m:${barTs}`, bar_ts: barTs, mode: 'NORMAL' }] } });
const pred = (o = {}) => ({ model_id: 'tsmom_v1@lgbm', model_version: '1', symbol: 'BTCUSDT', horizon: '1h', mu: 0.001, sigma: 0.01, p_up: 0.55, ...o });
test('predictions: a clean set passes', async () => {
  const r = await validate({ as_of: '2026-10-02T00:05:00Z', predictions: [pred(), pred({ symbol: 'ETHUSDT' })] });
  assert.equal(r.ok, true);
  assert.equal(r.kept.length, 2);
});
test('predictions: stale or missing as_of fails the cycle', async () => {
  assert.equal((await validate({ as_of: '2026-10-02T00:00:00Z', predictions: [pred()] })).ok, false);
  assert.equal((await validate({ predictions: [pred()] })).ok, false);
});
test('predictions: bad rows are dropped; too many bad rows fail the cycle', async () => {
  const good = Array.from({ length: 9 }, (_, i) => pred({ symbol: `S${i}` }));
  const r1 = await validate({ as_of: '2026-10-02T00:05:00Z', predictions: [...good, pred({ sigma: 0 })] });
  assert.equal(r1.ok, true);
  assert.equal(r1.kept.length, 9);
  const r2 = await validate({ as_of: '2026-10-02T00:05:00Z', predictions: [...good.slice(0, 5), pred({ sigma: 0 }), pred({ mu: NaN }), pred({ model_id: 'rogue' })] });
  assert.equal(r2.ok, false);
});
test('predictions: mu beyond 5 sigma, p_up out of range and unregistered models are rejected', async () => {
  const r = await validate({ as_of: '2026-10-02T00:05:00Z', predictions: [pred(), pred({ mu: 1 }), pred({ p_up: 1.5 }), pred({ model_id: 'x' })].concat(Array.from({ length: 20 }, (_, i) => pred({ symbol: `Q${i}` }))) });
  assert.equal(r.kept.length, 21);
  assert.equal(r.rejected_count, 3);
});
test('predictions: an empty set fails', async () => assert.equal((await validate({ as_of: '2026-10-02T00:05:00Z', predictions: [] })).ok, false));

// ---------------------------------------------------------- cycle gating and ids
const cycleCtx = (route, extra = {}) => runFirst('wf03-gate-decision.js', { input: [{ r: { claimed: route !== 'duplicate' } }], nodes: {
  'Cycle context': [{ cycle_id: 'c', bar_ts: 'b' }], 'Global mode': [{ redis_mode: extra.mode ?? 'NORMAL' }], 'Data quality': [{ dq_status: extra.dq ?? 'OK' }] } });
test('cycle gate: proceeds only when claimed, healthy and not halted', async () => {
  assert.equal((await cycleCtx('proceed')).route, 'proceed');
  assert.equal((await cycleCtx('duplicate')).route, 'duplicate');
  assert.equal((await cycleCtx('proceed', { dq: 'DEGRADED' })).route, 'skip');
  assert.equal((await cycleCtx('proceed', { mode: 'HALT' })).route, 'skip');
});
test('cycle gate: a missing data-quality flag is not OK (supervisor down fails closed)', async () => {
  const r = await runFirst('wf03-gate-decision.js', { input: [{ r: { claimed: true } }], nodes: { 'Cycle context': [{ cycle_id: 'c' }], 'Global mode': [{ redis_mode: 'NORMAL' }], 'Data quality': [{ dq_status: null }] } });
  assert.equal(r.route, 'skip');
});
test('cycle id: the event and the schedule backstop give the same id for the same bar', async () => {
  const viaEvent = await runFirst('wf03-cycle-context.js', { input: [{ r: { payload: { bar_ts: '2026-10-02T00:05:00Z' } } }], now: '2026-10-02T00:05:20Z' });
  const viaSchedule = await runFirst('wf03-cycle-context.js', { input: [{}], now: '2026-10-02T00:05:15Z' });
  assert.equal(viaEvent.cycle_id, viaSchedule.cycle_id);
  assert.equal(viaEvent.cycle_id, 'core5m:2026-10-02T00:05:00.000Z');
});
test('fan-out: every proposal is kept and the order varies with the seed', async () => {
  const props = Array.from({ length: 12 }, (_, i) => ({ proposal_id: `p${i}` }));
  const a = await runCodeNode('wf03-fan-out.js', { input: [{}], nodes: { 'Prepare cycle outputs': [{ proposals: props }] }, seed: 1 });
  const b = await runCodeNode('wf03-fan-out.js', { input: [{}], nodes: { 'Prepare cycle outputs': [{ proposals: props }] }, seed: 2 });
  assert.deepEqual(a.map((x) => x.json.proposal_id).sort(), props.map((p) => p.proposal_id).sort());
  assert.notDeepEqual(a.map((x) => x.json.proposal_id), b.map((x) => x.json.proposal_id));
});

// ---------------------------------------------------------- signed webhooks
const sigItem = (over = {}, ts = '2026-10-02T12:00:00Z') => ({ headers: { 'x-aqos-signature': 'sha256=abc123' }, computed_sig: 'abc123', body: { event_id: 'e1', type: 'bar_close', ts, payload: {} }, ...over });
const verifyAt = (item, now = '2026-10-02T12:00:10Z') => runFirst('common-verify-signed-webhook.js', { input: [item], now });
test('signature: a correct signature inside the replay window is accepted', async () => assert.equal((await verifyAt(sigItem())).valid, true));
test('signature: wrong, missing or different-length signatures are rejected', async () => {
  assert.equal((await verifyAt(sigItem({ computed_sig: 'zzz999' }))).reason, 'bad_signature');
  assert.equal((await verifyAt(sigItem({ headers: {} }))).reason, 'missing_signature');
  assert.equal((await verifyAt(sigItem({ computed_sig: 'abc' }))).valid, false);
});
test('signature: events older or newer than 30 s are rejected (replay protection)', async () => {
  assert.equal((await verifyAt(sigItem(), '2026-10-02T12:01:00Z')).reason, 'stale_or_missing_ts');
  assert.equal((await verifyAt(sigItem({}, '2026-10-02T12:05:00Z'))).reason, 'stale_or_missing_ts');
});
test('signature: events without an id or type are rejected, and no envelope leaks out', async () => {
  const r = await verifyAt(sigItem({ body: { type: 'bar_close', ts: '2026-10-02T12:00:00Z' } }));
  assert.equal(r.valid, false);
  assert.equal(r.envelope, null);
});

// ------------------------------------------------------------ supervisor and errors
const probes = (down = []) => ['stream-gateway', 'model-service', 'portfolio-service', 'risk-service', 'ems-primary', 'ems-standby'].map((name) => ({ json: { name, url: `http://${name}`, critical: true, statusCode: down.includes(name) ? 503 : 200 } }));
const supervisor = (down, fresh, mode = 'NORMAL') => runFirst('wf00-evaluate-state.js', { input: [{}], nodes: {
  'Service registry': probes().map((p) => ({ json: { name: p.json.name, url: p.json.url, critical: true } })),
  'Probe /healthz': probes(down).map((p) => ({ json: { statusCode: p.json.statusCode } })),
  'Freshness report': [{ r: { max_critical_bar_age_s: 20, max_mark_age_s: 2, quarantined_critical: 0, heartbeat_age_s: { risk_monitor: 5, reconciliation: 60 }, open_high_breaks: 0, unconfirmed_orders: 0, global_mode: 'NORMAL', ...fresh } }],
  'Current global mode': [{ global_mode: mode }] } });
test('supervisor: all healthy is OK with data quality OK', async () => {
  const r = await supervisor([], {});
  assert.equal(r.severity, 'OK');
  assert.equal(r.dq_status, 'OK');
  assert.equal(r.escalate_to, null);
});
test('supervisor: a stream-gateway outage is SEV1 and degrades data quality', async () => {
  const r = await supervisor(['stream-gateway'], {});
  assert.equal(r.severity, 'SEV1');
  assert.equal(r.dq_status, 'DEGRADED');
});
test('supervisor: stale critical feeds or a quarantined feed degrade data quality', async () => {
  assert.equal((await supervisor([], { max_critical_bar_age_s: 400 })).dq_status, 'DEGRADED');
  assert.equal((await supervisor([], { quarantined_critical: 1 })).dq_status, 'DEGRADED');
});
test('supervisor: a blind risk monitor escalates to reduce-only, once', async () => {
  assert.equal((await supervisor([], { heartbeat_age_s: { risk_monitor: 200, reconciliation: 10 } })).escalate_to, 'REDUCE_ONLY');
  assert.equal((await supervisor([], { heartbeat_age_s: { risk_monitor: 200, reconciliation: 10 } }, 'HALT')).escalate_to, null);
});
test('supervisor: EMS primary down is SEV2 with a standby and SEV1 without', async () => {
  assert.equal((await supervisor(['ems-primary'], {})).severity, 'SEV2');
  assert.equal((await supervisor(['ems-primary', 'ems-standby'], {})).severity, 'SEV1');
});
test('supervisor: orders stuck unconfirmed are SEV1', async () => assert.equal((await supervisor([], { unconfirmed_orders: 2 })).severity, 'SEV1'));
test('supervisor: it alerts on change only and announces recovery once', async () => {
  const cur = { fingerprint: 'fp2', severity: 'SEV2', issues: [{ sev: 'SEV2', code: 'x' }], dq_status: 'OK', global_mode: 'NORMAL', escalate_to: null, ts: 't' };
  const run = (last, c = cur) => runFirst('wf00-detect-change.js', { input: [{ last_fingerprint: last }], nodes: { 'Evaluate system state': [c] } });
  assert.equal((await run('fp1')).notify, true);
  assert.equal((await run('fp2')).notify, false);
  const ok = { ...cur, fingerprint: 'ok', severity: 'OK', issues: [] };
  assert.equal((await run('fp2', ok)).notify, true);
  assert.match((await run('fp2', ok)).text, /RECOVERED/);
  assert.equal((await run(null, ok)).notify, false);
});

const classify = (workflowId, message) => runFirst('wf13-classify-error.js', { input: [{ workflow: { id: workflowId, name: 'wf' }, execution: { id: '9', lastNodeExecuted: 'N', error: { message } } }] });
test('errors: transient network errors are recognised; permanent ones are not', async () => {
  assert.equal((await classify('AQOS05ExecDisptc', 'connect ETIMEDOUT 10.0.0.1:443')).transient, true);
  assert.equal((await classify('AQOS05ExecDisptc', 'Cannot read properties of undefined')).transient, false);
});
test('errors: fingerprints ignore uuids and numbers so recurrences group together', async () => {
  const a = await classify('AQOS05ExecDisptc', 'order 123 failed for 3f2a1c9e-1111-2222-3333-444455556666');
  const b = await classify('AQOS05ExecDisptc', 'order 987 failed for aaaaaaaa-1111-2222-3333-444455556666');
  assert.equal(a.fingerprint, b.fingerprint);
});
test('errors: a permanent SEV1 in a capital-guarding workflow triggers the reduce-only fail-safe', async () => {
  const c = await classify('AQOS04RiskGate00', 'TypeError: x is not a function');
  const r = await runFirst('wf13-severity-policy.js', { input: [{ r: { occurrences_window: 1, incident_id: 5 } }], nodes: { 'Classify error': [c] } });
  assert.equal(r.severity, 'SEV1');
  assert.equal(r.fail_safe_reduce_only, true);
});
test('errors: a one-off transient failure in a critical workflow is only SEV2 and does not fail safe', async () => {
  const c = await classify('AQOS04RiskGate00', 'socket hang up ETIMEDOUT');
  const r = await runFirst('wf13-severity-policy.js', { input: [{ r: { occurrences_window: 1 } }], nodes: { 'Classify error': [c] } });
  assert.equal(r.severity, 'SEV2');
  assert.equal(r.fail_safe_reduce_only, false);
});
test('errors: repeated transient failures escalate to SEV1', async () => {
  const c = await classify('AQOS05ExecDisptc', 'ECONNRESET');
  const r = await runFirst('wf13-severity-policy.js', { input: [{ r: { occurrences_window: 3 } }], nodes: { 'Classify error': [c] } });
  assert.equal(r.severity, 'SEV1');
});

// ------------------------------------------------------------------ kill switch
const norm = (b, viaWebhook = true) => runFirst('wf14-normalize-request.js', { input: [viaWebhook ? { headers: {}, body: b } : b], now: '2026-10-02T12:00:30Z' });
test('kill: a valid request is idempotent within the same minute', async () => {
  const a = await norm({ scope: 'global', action: 'halt_new', requested_by: 'ops.alice' });
  const b = await runFirst('wf14-normalize-request.js', { input: [{ headers: {}, body: { scope: 'global', action: 'halt_new', requested_by: 'ops.alice' } }], now: '2026-10-02T12:00:55Z' });
  assert.equal(a.valid, true);
  assert.equal(a.request_id, b.request_id);
});
test('kill: scoped requests need a scope id, webhook requests need a requester, unknown actions are invalid', async () => {
  assert.equal((await norm({ scope: 'account', action: 'flatten', requested_by: 'x' })).valid, false);
  assert.equal((await norm({ scope: 'global', action: 'halt_new' })).valid, false);
  assert.equal((await norm({ scope: 'global', action: 'explode', requested_by: 'x' })).valid, false);
  assert.equal((await norm({ scope: 'account', scope_id: 'a1', action: 'flatten', requested_by: 'x' })).valid, true);
});
test('kill: internal callers need no requester', async () => assert.equal((await norm({ scope: 'global', action: 'cancel_all', reason: 'es' }, false)).valid, true));
test('kill: reset needs two distinct approvers', async () => {
  const run = (ids) => runFirst('wf14-four-eyes.js', { input: [{}], nodes: { 'Normalize request': [{ request_id: 'r', approver_ids: ids }] } });
  assert.equal((await run(['a'])).four_eyes_ok, false);
  assert.equal((await run(['a', 'a'])).four_eyes_ok, false);
  assert.equal((await run(['a', 'b'])).four_eyes_ok, true);
});
test('kill: exposure verification needs no open orders, and for a flatten, dust-level residual', async () => {
  const run = (action, x) => runFirst('wf14-verify-exposure.js', { input: [x], nodes: { 'Normalize request': [{ action, scope: 'account', scope_id: 'a', reason: 'r', request_id: 'q' }] } });
  assert.equal((await run('cancel_all', { open_orders: 0 })).clean, true);
  assert.equal((await run('cancel_all', { open_orders: 2 })).clean, false);
  assert.equal((await run('flatten', { open_orders: 0, gross_notional_usd: 10 })).clean, true);
  assert.equal((await run('flatten', { open_orders: 0, gross_notional_usd: 5000 })).clean, false);
  assert.equal((await run('flatten', { open_orders: 0 })).clean, false);
  assert.equal((await run('cancel_all', {})).clean, false);
});
test('kill: three attempts, then stop', async () => {
  const at = (i) => runFirst('wf14-retry-budget.js', { input: [{}], runIndex: i });
  assert.equal((await at(0)).retry, true);
  assert.equal((await at(1)).retry, true);
  assert.equal((await at(2)).retry, false);
});

// ------------------------------------------------------------------ alert routing
test('alerts: severity mapping, truncation and default dedup keys', async () => {
  const run = (j) => runFirst('wf16-route-alert.js', { input: [j] });
  assert.equal((await run({ severity: 'ACT', text: 'x' })).severity, 'SEV1');
  assert.equal((await run({ severity: 'WARN', text: 'x' })).severity, 'SEV2');
  assert.equal((await run({ severity: 'weird', text: 'x' })).severity, 'INFO');
  assert.equal((await run({ severity: 'SEV1', text: 'y'.repeat(5000) })).text.length, 3900);
  assert.ok((await run({ severity: 'SEV2', text: 'line1\nline2' })).dedup_key.startsWith('SEV2:line1'));
});

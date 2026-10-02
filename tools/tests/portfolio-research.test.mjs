// Unit tests for the portfolio rebalance, research and report-request Code-node
// scripts. Every assertion pins an exact value (ids, URLs, model, counts) so
// that a small change to a script under test fails a test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFirst, runCodeNode } from '../lib/sandbox.mjs';

// ------------------------------------------------------------- rebalance request
const rebalance = (input, now = '2026-10-02T00:10:00Z') =>
  runCodeNode('wf08-rebalance-request.js', { input, now });

test('rebalance request: drifted accounts become exactly one request', async () => {
  const out = await rebalance([
    { account_id: 'acc_1', max_abs_drift: '0.031', drifted: ['BTCUSDT'] },
    { account_id: 'acc_2', max_abs_drift: -0.02 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].json.reason, 'drift');
  assert.equal(out[0].json.as_of, '2026-10-02T00:10:00.000Z');
  assert.deepEqual(out[0].json.accounts, [
    { account_id: 'acc_1', max_abs_drift: 0.031, drifted: ['BTCUSDT'] },
    { account_id: 'acc_2', max_abs_drift: -0.02, drifted: [] },
  ]);
});
test('rebalance request: drift is numeric, not a string', async () => {
  const out = await rebalance([{ account_id: 'acc_1', max_abs_drift: '0.25' }]);
  assert.equal(typeof out[0].json.accounts[0].max_abs_drift, 'number');
  assert.equal(out[0].json.accounts[0].max_abs_drift, 0.25);
});
test('rebalance request: empty input still yields a request with no accounts', async () => {
  const out = await rebalance([]);
  assert.equal(out.length, 1);
  assert.equal(out[0].json.reason, 'drift');
  assert.deepEqual(out[0].json.accounts, []);
});
test('rebalance request: rows without an account id are dropped', async () => {
  const out = await rebalance([{ max_abs_drift: 0.1 }, { account_id: 'acc_1', max_abs_drift: 0.1 }]);
  assert.deepEqual(out[0].json.accounts.map((a) => a.account_id), ['acc_1']);
});
test('rebalance request: drifted symbols already on the list are kept as given', async () => {
  const out = await rebalance([{ account_id: 'acc_1', max_abs_drift: 0.01, drifted: ['ETHUSDT', 'SOLUSDT'] }]);
  assert.deepEqual(out[0].json.accounts[0].drifted, ['ETHUSDT', 'SOLUSDT']);
});

// -------------------------------------------------------------- prepare proposals
const HOUR0 = '2026-10-02T00:10:00Z';
const HOUR0_BUCKET = '2026-10-02T00:00:00.000Z';
const valid = (o = {}) => ({ account_id: 'acc_1', strategy_id: 'stg_a', symbol: 'BTCUSDT', venue: 'binance', side: 'BUY', qty: '0.5', ...o });
const prepare = (proposals, { now = HOUR0, seed } = {}) =>
  runCodeNode('wf08-prepare-proposals.js', { input: [{ proposals }], now, seed });
const ids = (out) => out.map((o) => o.json.proposal_id);

test('proposals: a valid proposal is normalised into one item', async () => {
  const out = await prepare([valid()]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].json, {
    proposal_id: `rebal:${HOUR0_BUCKET}:acc_1:stg_a:binance:BTCUSDT:BUY`,
    cycle_id: null,
    account_id: 'acc_1',
    strategy_id: 'stg_a',
    symbol: 'BTCUSDT',
    venue: 'binance',
    side: 'BUY',
    qty: 0.5,
    order_type: 'LIMIT',
    limit_px: null,
    urgency: 'low',
    pair_id: null,
    source: 'rebalance',
  });
});
test('proposals: the id is deterministic inside the hour bucket', async () => {
  const a = await prepare([valid()], { now: '2026-10-02T00:10:00Z' });
  const b = await prepare([valid()], { now: '2026-10-02T00:59:59Z' });
  assert.equal(ids(a)[0], ids(b)[0]);
});
test('proposals: the id changes with the hour bucket', async () => {
  const a = await prepare([valid()], { now: '2026-10-02T00:59:59Z' });
  const b = await prepare([valid()], { now: '2026-10-02T01:00:00Z' });
  assert.notEqual(ids(a)[0], ids(b)[0]);
  assert.equal(ids(b)[0], 'rebal:2026-10-02T01:00:00.000Z:acc_1:stg_a:binance:BTCUSDT:BUY');
});
test('proposals: sides are upper-cased', async () => {
  const out = await prepare([valid({ side: 'buy' }), valid({ side: 'SeLl', symbol: 'ETHUSDT' })]);
  assert.deepEqual(out.map((o) => o.json.side).sort(), ['BUY', 'SELL']); // the script shuffles; order is not part of the contract
  assert.ok(ids(out).every((i) => i.endsWith(':BUY') || i.endsWith(':SELL')), ids(out).join());
});
test('proposals: rows missing an id, symbol or venue are dropped', async () => {
  const out = await prepare([
    valid({ account_id: null }),
    valid({ strategy_id: undefined }),
    valid({ symbol: '' }),
    valid({ venue: null }),
    valid({ symbol: 'ETHUSDT' }),
  ]);
  assert.deepEqual(out.map((o) => o.json.symbol), ['ETHUSDT']);
});
test('proposals: a side that is not buy or sell is dropped', async () => {
  const out = await prepare([valid({ side: 'LONG' }), valid({ side: 'buy', symbol: 'ETHUSDT' })]);
  assert.deepEqual(out.map((o) => o.json.symbol), ['ETHUSDT']);
});
test('proposals: a quantity of zero or less is dropped', async () => {
  const out = await prepare([valid({ qty: 0 }), valid({ qty: '-1' }), valid({ symbol: 'ETHUSDT' })]);
  assert.deepEqual(out.map((o) => o.json.symbol), ['ETHUSDT']);
});
test('proposals: defaults fill order_type, urgency, source, limit_px and pair_id', async () => {
  const p = (await prepare([valid()]))[0].json;
  assert.equal(p.order_type, 'LIMIT');
  assert.equal(p.urgency, 'low');
  assert.equal(p.source, 'rebalance');
  assert.equal(p.limit_px, null);
  assert.equal(p.pair_id, null);
  assert.equal(p.cycle_id, null);
});
test('proposals: explicit order_type, urgency and prices survive normalisation', async () => {
  const p = (await prepare([valid({ order_type: 'MARKET', urgency: 'high', limit_px: '61000', pair_id: 'p1' })]))[0].json;
  assert.equal(p.order_type, 'MARKET');
  assert.equal(p.urgency, 'high');
  assert.equal(p.limit_px, '61000');
  assert.equal(p.pair_id, 'p1');
});
test('proposals: a fixed seed gives a deterministic order and keeps every valid proposal', async () => {
  const many = Array.from({ length: 8 }, (_, i) => valid({ strategy_id: `stg_${i}` }));
  const a = await prepare(many, { seed: 7 });
  const b = await prepare(many, { seed: 7 });
  assert.deepEqual(ids(a), ids(b));
  assert.deepEqual(ids(a).slice().sort(), ids(b).slice().sort());
  assert.equal(a.length, 8);
  assert.deepEqual(
    ids(a).slice().sort(),
    many.map((m) => `rebal:${HOUR0_BUCKET}:acc_1:${m.strategy_id}:binance:BTCUSDT:BUY`).sort(),
  );
});
test('proposals: a different seed changes the order but not the set', async () => {
  const many = Array.from({ length: 8 }, (_, i) => valid({ strategy_id: `stg_${i}` }));
  const a = await prepare(many, { seed: 7 });
  const c = await prepare(many, { seed: 8 });
  assert.notDeepEqual(ids(a), ids(c));
  assert.deepEqual(ids(a).slice().sort(), ids(c).slice().sort());
});
test('proposals: a proposals value that is not an array yields no items', async () => {
  assert.deepEqual(await prepare(null), []);
  assert.deepEqual(await prepare('nope'), []);
  assert.deepEqual(await prepare({ a: 1 }), []);
});

// ------------------------------------------------------------------ review request
const reviewReq = (body = {}) => runFirst('wf08-review-request.js', { input: [body] });
const schemaOf = (req) => req.anthropic_request.output_config.format.schema;

test('review request: uses the one model with server-side fallbacks', async () => {
  const req = await reviewReq({ within_bounds: true });
  assert.equal(req.anthropic_request.model, 'claude-opus-5-5');
  assert.equal(req.anthropic_request.fallbacks, 'default');
  assert.equal(req.anthropic_request.max_tokens, 6000);
  assert.equal(req.anthropic_request.output_config.effort, 'medium');
});
test('review request: the output format is a json_schema that forbids extra keys', async () => {
  const req = await reviewReq({ within_bounds: true });
  assert.equal(req.anthropic_request.output_config.format.type, 'json_schema');
  const s = schemaOf(req);
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['summary', 'concerns', 'recommend_human_review']);
  assert.deepEqual(Object.keys(s.properties).sort(), ['concerns', 'recommend_human_review', 'summary']);
  assert.deepEqual(Object.keys(s.properties), s.required);
  assert.equal(s.properties.concerns.type, 'array');
  assert.deepEqual(s.properties.concerns.items, { type: 'string' });
  assert.equal(s.properties.recommend_human_review.type, 'boolean');
});
test('review request: the system prompt forbids approving and carries the policy result', async () => {
  const req = await reviewReq({ within_bounds: false, violations: ['turnover_0.21'] });
  assert.ok(req.anthropic_request.system.includes('You cannot approve changes'), req.anthropic_request.system);
  assert.deepEqual(JSON.parse(req.anthropic_request.messages[0].content), { within_bounds: false, violations: ['turnover_0.21'] });
  assert.equal(req.anthropic_request.messages[0].role, 'user');
});

// ------------------------------------------------------------------- decide path
const policy = (over = {}) => ({ within_bounds: true, violations: [], deltas: [], ...over });
const decide = (response, pol = policy(), node = pol) =>
  runFirst('wf08-decide-path.js', { input: [response], nodes: { 'Bounded-change policy': [node] } });
const llm = (draft) => ({ statusCode: 200, body: { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(draft) }] } });

test('decide path: inside the envelope with no review request applies', async () => {
  const r = await decide(llm({ summary: 'A small shift.', concerns: [], recommend_human_review: false }));
  assert.equal(r.path, 'apply');
  assert.equal(r.review_error, null);
  assert.equal(r.review.summary, 'A small shift.');
  assert.equal(r.rationale, 'A small shift.');
  assert.equal(r.within_bounds, true);
});
test('decide path: a recommendation for human review stages', async () => {
  const r = await decide(llm({ summary: 'Concentration is high.', concerns: ['crowding'], recommend_human_review: true }));
  assert.equal(r.path, 'stage');
  assert.equal(r.review_error, null);
  assert.deepEqual(r.review.concerns, ['crowding']);
  assert.equal(r.rationale, 'Concentration is high.');
});
test('decide path: out of bounds stages even when the agent is happy', async () => {
  const pol = policy({ within_bounds: false, violations: ['step_0.06'] });
  const r = await decide(llm({ summary: 'Fine by me.', concerns: [], recommend_human_review: false }), pol);
  assert.equal(r.path, 'stage');
  assert.equal(r.within_bounds, false);
  assert.deepEqual(r.violations, ['step_0.06']);
  assert.equal(r.review_error, null);
});
test('decide path: out of bounds without an agent summary explains the violations', async () => {
  const pol = policy({ within_bounds: false, violations: ['step_0.06', 'turnover_0.21'] });
  const r = await decide(llm({ concerns: [], recommend_human_review: false }), pol);
  assert.equal(r.path, 'stage');
  assert.equal(r.rationale, 'bounded-change policy: step_0.06, turnover_0.21');
});
test('decide path: inside the envelope with no summary still explains the policy', async () => {
  const r = await decide(llm({ concerns: [], recommend_human_review: false }));
  assert.equal(r.path, 'apply');
  assert.equal(r.rationale, 'bounded-change policy: within envelope');
});
test('decide path: a refusal falls back to the policy alone', async () => {
  const r = await decide({ statusCode: 200, body: { stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [] } });
  assert.equal(r.path, 'apply');
  assert.equal(r.review, null);
  assert.equal(r.review_error, 'refusal');
  assert.equal(r.rationale, 'bounded-change policy: within envelope');
});
test('decide path: an HTTP error falls back to the policy alone', async () => {
  const r = await decide({ statusCode: 529, body: { error: { type: 'overloaded_error' } } });
  assert.equal(r.path, 'apply');
  assert.equal(r.review, null);
  assert.equal(r.review_error, 'http_529');
});
test('decide path: invalid JSON falls back to the policy alone', async () => {
  const r = await decide({ statusCode: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] } });
  assert.equal(r.path, 'apply');
  assert.equal(r.review, null);
  assert.equal(r.review_error, 'invalid_json');
  assert.equal(r.rationale, 'bounded-change policy: within envelope');
});
test('decide path: an out-of-bounds change is staged even when the review call fails', async () => {
  const pol = policy({ within_bounds: false, violations: ['turnover_0.31'] });
  const r = await decide({ error: { message: 'ETIMEDOUT' } }, pol);
  assert.equal(r.path, 'stage');
  assert.equal(r.review_error, 'http_error');
  assert.equal(r.rationale, 'bounded-change policy: turnover_0.31');
});
test('decide path: a truncated response is not a review either', async () => {
  const r = await decide({ statusCode: 200, body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"summary":"x"' }] } });
  assert.equal(r.path, 'apply');
  assert.equal(r.review_error, 'max_tokens');
  assert.equal(r.review, null);
});
test('decide path: the whole policy row is passed through to the next node', async () => {
  const node = policy({ within_bounds: false, violations: ['step_0.06'], deltas: [{ strategy: 'a', from: 0.4, to: 0.46 }], proposal_id: 'p1' });
  const r = await decide(llm({ summary: 's', concerns: [], recommend_human_review: false }), node, node);
  assert.equal(r.proposal_id, 'p1');
  assert.deepEqual(r.deltas, [{ strategy: 'a', from: 0.4, to: 0.46 }]);
});

// --------------------------------------------------------------- approval message
const RESUME = 'http://n8n/wait/1';
const TOKEN = 'a'.repeat(64);
const approval = (d, { version_id = 42, token = TOKEN, resumeUrl = RESUME } = {}) =>
  runFirst('wf08-approval-message.js', {
    input: [{ execution: { resumeUrl } }],
    execution: { resumeUrl },
    nodes: {
      'Approval token': [{ token }],
      'Stage allocation': [{ r: { version_id } }],
      'Decide path': [d],
    },
  });

test('approval: both one-time links carry the resume url, decision, version and token', async () => {
  const r = await approval({ deltas: [{ strategy: 'a', from: 0.4, to: 0.45, delta: 0.05 }], violations: [], review: { summary: 'ok' } });
  const approve = `Approve: ${RESUME}?decision=approve&v=42&token=${TOKEN}&approver=YOUR_ID`;
  const reject = `Reject: ${RESUME}?decision=reject&v=42&token=${TOKEN}&approver=YOUR_ID`;
  assert.ok(r.text.includes(approve), r.text);
  assert.ok(r.text.includes(reject), r.text);
  assert.equal(r.version_id, 42);
});
test('approval: only moves with a non-zero delta are listed', async () => {
  const r = await approval({
    deltas: [
      { strategy: 'alpha', from: 0.4, to: 0.45, delta: 0.05 },
      { strategy: 'beta', from: 0.2, to: 0.2, delta: 0 },
      { strategy: 'gamma', from: 0.1, to: 0.095, delta: -0.005 },
    ],
    violations: [],
    review: { summary: 'ok' },
  });
  assert.ok(r.text.includes('alpha: 40.0% -> 45.0%'), r.text);
  assert.ok(r.text.includes('gamma: 10.0% -> 9.5%'), r.text);
  assert.ok(!r.text.includes('beta'), r.text);
});
test('approval: the policy violations are shown as the reason for staging', async () => {
  const r = await approval({ deltas: [], violations: ['step_0.06', 'turnover_0.21'], review: null });
  assert.ok(r.text.includes('Why staged: step_0.06, turnover_0.21'), r.text);
});
test('approval: without violations the reason is the agent review request', async () => {
  const r = await approval({ deltas: [], violations: [], review: { summary: 'crowding' } });
  assert.ok(r.text.includes('Why staged: portfolio agent requested human review'), r.text);
  assert.ok(r.text.includes('Agent notes: crowding'), r.text);
});
test('approval: a missing agent note reads n/a and the expiry is four hours', async () => {
  const r = await approval({ deltas: [], violations: ['step_0.06'], review: null });
  assert.ok(r.text.includes('Agent notes: n/a'), r.text);
  assert.ok(r.text.includes('[APPROVAL] Strategy allocation v42 (expires in 4 h)'), r.text);
});
test('approval: a different execution gets its own resume url and version', async () => {
  const r = await approval({ deltas: [], violations: [], review: null }, { resumeUrl: 'http://n8n/wait/9', version_id: 7 });
  assert.ok(r.text.includes('http://n8n/wait/9?decision=approve&v=7'), r.text);
  assert.ok(!r.text.includes(RESUME), r.text);
  assert.equal(r.version_id, 7);
});

// ---------------------------------------------------------------- research prompt
const prompt = (json, now = '2026-10-02T09:00:00Z') =>
  runFirst('wf09-research-prompt.js', { input: [json], now });

test('research prompt: research_input is JSON holding the brief and four tasks', async () => {
  const brief = { model_health: [{ model_id: 'tsmom_v1@lgbm', live_vs_backtest_z: 3.1, psi_max: 0.02 }], pending_approvals: 2 };
  const out = await prompt({ brief });
  assert.equal(typeof out.research_input, 'string');
  const parsed = JSON.parse(out.research_input);
  assert.deepEqual(Object.keys(parsed), ['date', 'brief', 'tasks']);
  assert.deepEqual(parsed.brief, brief);
  assert.equal(parsed.tasks.length, 4);
  assert.ok(parsed.tasks.every((t) => typeof t === 'string'));
});
test('research prompt: the tasks name the demotion, DSR/PBO, experiment limit and promotion rules', async () => {
  const { tasks } = JSON.parse((await prompt({ brief: {} })).research_input);
  assert.ok(tasks[0].includes('|live_vs_backtest_z| >= 2.5') && tasks[0].includes('psi_max >= 0.25'), tasks[0]);
  assert.ok(tasks[1].includes('deflated Sharpe') && tasks[1].includes('PBO'), tasks[1]);
  assert.ok(tasks[2].includes('at most 3 new experiments'), tasks[2]);
  assert.ok(tasks[3].includes('goes to humans'), tasks[3]);
});
test('research prompt: the date is the run date and a missing brief becomes empty', async () => {
  const parsed = JSON.parse((await prompt({}, '2026-10-02T09:00:00Z')).research_input);
  assert.equal(parsed.date, '2026-10-02');
  assert.deepEqual(parsed.brief, {});
});

// ----------------------------------------------------------------- research digest
const digest = (output) => runFirst('wf09-digest.js', { input: [{}], nodes: { 'Research Agent': [{ output }] } });
const MEMO = {
  date: '2026-10-02',
  summary: 'Two models need attention.',
  decay_findings: [{ model_id: 'tsmom_v1@lgbm', finding: 'live_vs_backtest_z = 3.1' }],
  results_reviewed: [{ experiment_id: 'exp_7', deflated_sharpe: 1.2, pbo: 0.41, verdict: 'reject' }],
  transitions_proposed: [{ model_id: 'tsmom_v1@lgbm', to_stage: 'paper', status: 'approved' }],
};

test('digest: a normal memo renders every section', async () => {
  const r = await digest(MEMO);
  assert.equal(r.severity, 'INFO');
  assert.ok(r.text.startsWith('[RESEARCH] 2026-10-02\nTwo models need attention.'), r.text);
  assert.ok(r.text.includes('Model health:\n- tsmom_v1@lgbm: live_vs_backtest_z = 3.1'), r.text);
  assert.ok(r.text.includes('Experiments reviewed:\n- exp_7: DSR 1.2, PBO 0.41 -> reject'), r.text);
  assert.ok(r.text.includes('Transitions proposed:\n- tsmom_v1@lgbm -> paper (approved)'), r.text);
  assert.deepEqual(r.memo, MEMO);
});
test('digest: missing numbers print n/a and a missing status prints submitted', async () => {
  const r = await digest({
    results_reviewed: [{ experiment_id: 'exp_8', verdict: 'fail' }],
    transitions_proposed: [{ model_id: 'm2', to_stage: 'retired' }],
  });
  assert.ok(r.text.includes('- exp_8: DSR n/a, PBO n/a -> fail'), r.text);
  assert.ok(r.text.includes('- m2 -> retired (submitted)'), r.text);
});
test('digest: empty or absent lists print - none and no summary prints a placeholder', async () => {
  const r = await digest({ decay_findings: [], results_reviewed: [], transitions_proposed: [] });
  assert.ok(r.text.includes('Model health:\n- none'), r.text);
  assert.ok(r.text.includes('Experiments reviewed:\n- none'), r.text);
  assert.ok(r.text.includes('Transitions proposed:\n- none'), r.text);
  assert.ok(r.text.includes('\n(no summary)\n'), r.text);
  assert.ok(r.text.includes(`[RESEARCH] ${new Date().toISOString().slice(0, 10)}`), r.text);
});
test('digest: an entirely empty memo still renders three placeholders', async () => {
  const r = await digest(undefined);
  assert.equal(r.severity, 'INFO');
  assert.deepEqual(r.memo, {});
  assert.equal(r.text.match(/- none/g).length, 3);
});
test('digest: at most six items per list are shown', async () => {
  const r = await digest({
    decay_findings: Array.from({ length: 9 }, (_, i) => ({ model_id: `m${i}`, finding: `finding ${i}` })),
  });
  assert.ok(r.text.includes('- m5: finding 5'), r.text);
  assert.ok(!r.text.includes('- m6: finding 6'), r.text);
  assert.ok(!r.text.includes('finding 7'), r.text);
});
test('digest: the text is capped at 3900 characters', async () => {
  const r = await digest({
    summary: 'x'.repeat(9000),
    decay_findings: [{ model_id: 'm0', finding: 'y'.repeat(9000) }],
  });
  assert.equal(r.text.length, 3900);
  assert.equal(r.severity, 'INFO');
});
test('digest: a list that is not an array prints - none', async () => {
  const r = await digest({ decay_findings: 'not-a-list' });
  assert.ok(r.text.includes('Model health:\n- none'), r.text);
});

// ------------------------------------------------------------- narrative request
const METRICS = { mode: 'LIVE', accounts: [{ account_id: 'acc_1', equity_usd: 100000, day_change_usd: -500.25, fees_usd: 12.5 }] };
const narrative = (items) => runCodeNode('wf12-narrative-request.js', { input: items });

test('narrative: one request per input item, client fields passed through', async () => {
  const out = await narrative([
    { client_id: 'c1', period: '2026-10-01', email: 'a@b.c', metrics: METRICS },
    { client_id: 'c2', period: '2026-10-01', email: 'd@e.f', metrics: METRICS },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((o) => o.json.client_id), ['c1', 'c2']);
  assert.deepEqual(out[1].json.metrics, METRICS);
  assert.equal(out[1].json.period, '2026-10-01');
  assert.ok(out.every((o) => o.json.anthropic_request));
});
test('narrative: the user message carries only the period and the metrics', async () => {
  const out = await narrative([{ client_id: 'c1', period: '2026-10-01', email: 'a@b.c', metrics: METRICS }]);
  assert.deepEqual(JSON.parse(out[0].json.anthropic_request.messages[0].content), { period: '2026-10-01', metrics: METRICS });
});
test('narrative: uses the one model, default fallbacks and medium effort', async () => {
  const req = (await narrative([{ period: 'p', metrics: METRICS }]))[0].json.anthropic_request;
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.max_tokens, 6000);
  assert.equal(req.output_config.effort, 'medium');
});
test('narrative: the output format is a json_schema that forbids extra keys', async () => {
  const req = (await narrative([{ period: 'p', metrics: METRICS }]))[0].json.anthropic_request;
  assert.equal(req.output_config.format.type, 'json_schema');
  const s = req.output_config.format.schema;
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['subject', 'summary_md', 'highlights', 'risk_notes']);
  assert.deepEqual(Object.keys(s.properties), s.required);
  assert.deepEqual(s.properties.highlights, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(s.properties.risk_notes, { type: 'array', items: { type: 'string' } });
});
test('narrative: the system prompt forbids advice, predictions and guarantees', async () => {
  const req = (await narrative([{ period: 'p', metrics: METRICS }]))[0].json.anthropic_request;
  const s = req.system;
  assert.ok(s.includes('do not predict, promise or imply future results'), s);
  assert.ok(s.includes('Never recommend buying, selling, holding or changing allocations'), s);
  assert.ok(s.includes('safe, guaranteed or low-risk'), s);
  assert.ok(s.includes('under 120 words'), s);
  assert.ok(s.includes('no links and no headings'), s);
});

// -------------------------------------------------------------------- run summary
const summary = (json) => runFirst('wf12-run-summary.js', { input: [json] });

test('run summary: the sent and fallback counts are rendered', async () => {
  const r = await summary({ sent: 12, fallback: 3 });
  assert.equal(r.severity, 'INFO');
  assert.equal(r.text, '[REPORTS] 12 report(s) recorded in this run, 3 used the template fallback');
});
test('run summary: missing counts default to zero', async () => {
  assert.equal((await summary({})).text, '[REPORTS] 0 report(s) recorded in this run, 0 used the template fallback');
  assert.equal((await summary({ sent: '5' })).text, '[REPORTS] 5 report(s) recorded in this run, 0 used the template fallback');
});

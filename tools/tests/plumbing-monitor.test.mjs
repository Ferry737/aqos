// Unit tests for the risk-monitor plumbing scripts: snapshot normalization,
// follow-up planning, alert de-duplication and the analyst hand-off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFirst, runCodeNode } from '../lib/sandbox.mjs';

// ------------------------------------------------------- normalize snapshot
const stressNode = { 'Market stress event': [{ payload: { reason: 'spread', severity: 'WARN' } }] };
const normalize = (input, nodes) => runFirst('wf07-normalize-snapshot.js', { input: [input], nodes });

test('normalize: a DB fallback input is flagged db_fallback even if the stored row claims risk_svc', async () => {
  const snap = { source: 'risk_svc', global: { var_limit_usd: 100 }, accounts: [{ account_id: 'a1' }] };
  const r = await normalize({ s: snap });
  assert.equal(r.snapshot.source, 'db_fallback');
  assert.deepEqual(r.snapshot.global, { var_limit_usd: 100 });
  assert.deepEqual(r.snapshot.accounts, [{ account_id: 'a1' }]);
});
test('normalize: a risk-service body keeps the source it came with', async () => {
  const r = await normalize({ source: 'risk_svc_cached', ts: '2026-10-02T00:00:00Z', global: {} });
  assert.equal(r.snapshot.source, 'risk_svc_cached');
  assert.equal(r.snapshot.ts, '2026-10-02T00:00:00Z');
});
test('normalize: a body without a source defaults to risk_svc', async () => {
  const r = await normalize({ global: { var_limit_usd: 100 } });
  assert.equal(r.snapshot.source, 'risk_svc');
  assert.equal(r.snapshot.global.var_limit_usd, 100);
});
test('normalize: an executed market stress node makes the run an event trigger', async () => {
  assert.equal((await normalize({ global: {} }, stressNode)).trigger, 'event');
});
test('normalize: without the stress node the trigger is the schedule', async () => {
  assert.equal((await normalize({ global: {} })).trigger, 'schedule');
});

// ------------------------------------------------------------ plan follow-ups
const EVAL = { severity: 'ACT', actions: [{ scope: 'global', mode: 'REDUCE_ONLY' }], kills: [{ request_id: 'k1' }] };
const plan = (r) => runFirst('wf07-plan-followups.js', { input: [{ r }], nodes: { 'Evaluate breakers': [EVAL] } });

test('follow-ups: the global change mode is mirrored into the fast flag', async () => {
  const changed = [
    { scope: 'account', scope_id: 'a1', mode: 'HALT' },
    { scope: 'global', scope_id: '*', mode: 'REDUCE_ONLY' },
  ];
  const out = await plan({ changed });
  assert.equal(out.mirror_global_mode, 'REDUCE_ONLY');
  assert.deepEqual(out.changed, changed);
});
test('follow-ups: without a global change nothing is mirrored but the account change still passes through', async () => {
  const changed = [{ scope: 'account', scope_id: 'a1', mode: 'HALT' }];
  const out = await plan({ changed });
  assert.equal(out.mirror_global_mode, null);
  assert.deepEqual(out.changed, changed);
});
test('follow-ups: the breaker fields pass through and a missing result means no changes', async () => {
  const out = await runFirst('wf07-plan-followups.js', { input: [{}], nodes: { 'Evaluate breakers': [EVAL] } });
  assert.equal(out.mirror_global_mode, null);
  assert.deepEqual(out.changed, []);
  assert.deepEqual(out.actions, EVAL.actions);
  assert.deepEqual(out.kills, EVAL.kills);
});

// ---------------------------------------------------------------- dedupe alert
const dedupe = (planOut, input) => runCodeNode('wf07-dedupe-alert.js', { input: [input], nodes: { 'Plan follow-ups': [planOut] } });

test('dedupe: a healthy snapshot pages nobody even with an unseen fingerprint', async () => {
  const out = await dedupe({ severity: 'OK', fingerprint: 'fp-1' }, {});
  assert.equal(out.length, 0);
});
test('dedupe: a fingerprint already alerted on pages nobody', async () => {
  const out = await dedupe({ severity: 'ACT', fingerprint: 'fp-1' }, { last_alert_fp: 'fp-1' });
  assert.equal(out.length, 0);
});
test('dedupe: a new fingerprint pages once with a risk- prefixed key and the plan payload', async () => {
  const planOut = { severity: 'ACT', fingerprint: 'fp-2', text: 'Var breach' };
  const out = await dedupe(planOut, { last_alert_fp: 'fp-1' });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].json, { severity: 'ACT', fingerprint: 'fp-2', text: 'Var breach', dedup_key: 'risk-fp-2' });
});
test('dedupe: the dedup key is capped at 250 characters', async () => {
  const fingerprint = 'g'.repeat(400);
  const [item] = await dedupe({ severity: 'ACT', fingerprint }, {});
  assert.equal(item.json.dedup_key, `risk-${fingerprint}`.slice(0, 250));
  assert.equal(item.json.dedup_key.length, 250);
  assert.ok(item.json.dedup_key.startsWith('risk-'));
});

// -------------------------------------------------------------- analyst prompt
const prompt = (breach) => runFirst('wf15-analyst-prompt.js', { input: [breach] });

test('analyst: analyst_input is valid JSON carrying the breach fields and the read-only instruction', async () => {
  const breach = {
    severity: 'ACT', snapshot_source: 'risk_svc', actions: [{ scope: 'global', mode: 'REDUCE_ONLY' }],
    warnings: [{ code: 'var_limit' }], text: 'VaR at limit', dedup_key: 'risk-fp-2',
  };
  const parsed = JSON.parse((await prompt(breach)).analyst_input);
  assert.deepEqual(parsed.breach, {
    severity: 'ACT', source: 'risk_svc', actions: breach.actions, warnings: breach.warnings, text: 'VaR at limit',
  });
  assert.match(parsed.note, /Breakers already acted/);
  assert.match(parsed.note, /tighten limits only if clearly warranted/);
});
test('analyst: the dedup key is carried over, and is null when the alert had none', async () => {
  assert.equal((await prompt({ severity: 'WARN', dedup_key: 'risk-fp-3' })).dedup_key, 'risk-fp-3');
  assert.equal((await prompt({ severity: 'WARN' })).dedup_key, null);
});

// ---------------------------------------------------------- format analysis
const format = (output) => runFirst('wf15-format-analysis.js', { input: [output === undefined ? {} : { output }] });

test('format: every section is rendered and empty lists read "- none"', async () => {
  const r = await format({ severity_assessment: 'VaR breach', confidence: 0.8, summary: 'Reduced sizing.' });
  assert.equal(r.severity, 'INFO');
  assert.equal(r.text, [
    '[RISK ANALYSIS] VaR breach (confidence: 0.8)',
    'Reduced sizing.',
    'Probable causes:',
    '- none',
    'Limits tightened by the agent:',
    '- none',
    'Recommended human actions:',
    '- none',
  ].join('\n'));
});
test('format: each list shows at most 6 items and JSON-encodes objects', async () => {
  const r = await format({
    severity_assessment: 'ES breach', confidence: 'low', summary: 'Halted.',
    probable_causes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    limits_tightened: [{ scope: 'account', scope_id: 'a1' }],
    recommended_human_actions: ['check the venue', 'review the funding rate'],
  });
  assert.equal(r.text, [
    '[RISK ANALYSIS] ES breach (confidence: low)',
    'Halted.',
    'Probable causes:',
    '- a', '- b', '- c', '- d', '- e', '- f',
    'Limits tightened by the agent:',
    '- {"scope":"account","scope_id":"a1"}',
    'Recommended human actions:',
    '- check the venue', '- review the funding rate',
  ].join('\n'));
});
test('format: the ops text is capped at 3900 characters', async () => {
  const r = await format({ severity_assessment: 'long', summary: 'y'.repeat(5000), probable_causes: ['z'.repeat(1000)] });
  assert.equal(r.text.length, 3900);
});
test('format: a missing analysis output still renders a complete report', async () => {
  const r = await format(undefined);
  assert.equal(r.severity, 'INFO');
  assert.equal(r.text, [
    '[RISK ANALYSIS]  (confidence: n/a)',
    '(no summary)',
    'Probable causes:',
    '- none',
    'Limits tightened by the agent:',
    '- none',
    'Recommended human actions:',
    '- none',
  ].join('\n'));
});
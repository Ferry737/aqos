// The last scripts without a direct test: service registry, cycle summary, Claude helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCodeNode, runFirst } from '../lib/sandbox.mjs';

test('service registry: six services, each with name, url and critical flag; the gateway, risk service and EMS are critical', async () => {
  const out = await runCodeNode('wf00-service-registry.js', { input: [{}] });
  assert.equal(out.length, 6);
  for (const { json } of out) { assert.ok(json.name && json.url.startsWith('http://') && typeof json.critical === 'boolean'); }
  const crit = out.filter((o) => o.json.critical).map((o) => o.json.name).sort();
  assert.deepEqual(crit, ['ems-primary', 'risk-service', 'stream-gateway']);
});

const summary = (r) => runFirst('wf03-cycle-summary.js', { input: [{ r }] });
test('cycle summary: quiet by default', async () => {
  const s = await summary({ cycle_id: 'c', proposals: 3, approved: 3, resized: 0, rejected: 0, escalations: 0, orders_registered: 3 });
  assert.equal(s.notify, false);
  assert.equal(s.severity, 'SEV3');
  assert.match(s.text, /3 proposals, 3 approved/);
});
test('cycle summary: any escalation notifies at SEV2', async () => {
  const s = await summary({ cycle_id: 'c', proposals: 1, rejected: 0, escalations: 1 });
  assert.equal(s.notify, true);
  assert.equal(s.severity, 'SEV2');
});
test('cycle summary: a majority of rejects notifies only from 5 proposals up', async () => {
  assert.equal((await summary({ proposals: 5, rejected: 3, escalations: 0 })).notify, true);
  assert.equal((await summary({ proposals: 4, rejected: 4, escalations: 0 })).notify, false);
  assert.equal((await summary({ proposals: 5, rejected: 2, escalations: 0 })).notify, false);
  assert.equal((await summary({ proposals: 0, rejected: 0, escalations: 0 })).reject_ratio, 0);
});

// common-claude.js is inlined into the LLM scripts; exercise it through one of them.
test('claude helper: every request uses Opus 5.5, default fallbacks, structured output, no forced tool and no sampling params', async () => {
  const [{ json }] = await runCodeNode('wf12-narrative-request.js', { input: [{ period: 'p', metrics: {} }] });
  const r = json.anthropic_request;
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.fallbacks, 'default');
  assert.equal(r.output_config.format.type, 'json_schema');
  assert.ok(!('tool_choice' in r) && !('temperature' in r) && !('thinking' in r) && !('top_p' in r));
  assert.equal(r.messages[0].role, 'user');
});
test('claude helper: a response with no content array is not valid', async () => {
  const requests = [{ json: { anthropic_request: {}, client_id: 'c', period: 'p', metrics: {} } }];
  const [{ json }] = await runCodeNode('wf12-compliance-gate.js', { input: [{ statusCode: 200, body: { stop_reason: 'end_turn' } }], nodes: { 'Build narrative request': requests } });
  assert.equal(json.compliance.pass, false);
  assert.equal(json.draft, null);
});

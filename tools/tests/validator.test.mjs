// The validator must fail on broken workflows; otherwise "0 errors" means nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const good = JSON.parse(readFileSync(new URL('../../n8n/workflows/AQOS14KillSwitch.json', import.meta.url), 'utf8'));
const notifier = JSON.parse(readFileSync(new URL('../../n8n/workflows/AQOS16Notifier00.json', import.meta.url), 'utf8'));
const errwf = JSON.parse(readFileSync(new URL('../../n8n/workflows/AQOS13ErrorHandl.json', import.meta.url), 'utf8'));

function run(mutate) {
  const wf = structuredClone(good);
  mutate(wf);
  const dir = mkdtempSync(join(tmpdir(), 'aqos-val-'));
  for (const w of [wf, notifier, errwf]) writeFileSync(join(dir, `${w.id}.json`), JSON.stringify(w));
  const r = spawnSync(process.execPath, ['tools/validate-workflows.mjs'], { env: { ...process.env, AQOS_WF_DIR: dir }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}
const node = (wf, name) => wf.nodes.find((n) => n.name === name);

test('unmodified workflow passes', () => assert.equal(run(() => {}).code, 0));
test('unknown node type fails', () => { const r = run((w) => { node(w, 'Verify exposure').type = 'n8n-nodes-base.doesNotExist'; }); assert.equal(r.code, 1); assert.match(r.out, /not in catalog/); });
test('unavailable typeVersion fails', () => { const r = run((w) => { node(w, 'Valid?').typeVersion = 99; }); assert.equal(r.code, 1); assert.match(r.out, /typeVersion 99/); });
test('undeclared parameter fails', () => { const r = run((w) => { node(w, 'Backoff').parameters.bogusParam = 1; }); assert.equal(r.code, 1); assert.match(r.out, /bogusParam: parameter not declared/); });
test('invalid option value fails', () => { const r = run((w) => { node(w, 'Backoff').parameters.unit = 'fortnights'; }); assert.equal(r.code, 1); assert.match(r.out, /fortnights/); });
test('HTTP node without timeout fails', () => { const r = run((w) => { delete node(w, 'Call EMS kill').parameters.options.timeout; }); assert.equal(r.code, 1); assert.match(r.out, /without explicit timeout/); });
test('unknown SQL function fails', () => { const r = run((w) => { node(w, 'Record kill request').parameters.query = 'SELECT ops.no_such_fn($1::jsonb) AS r'; }); assert.equal(r.code, 1); assert.match(r.out, /unknown SQL function/); });
test('SQL with an expression fails', () => { const r = run((w) => { node(w, 'Record kill request').parameters.query = "SELECT ops.record_kill_request('{{ $json.x }}'::jsonb) AS r"; }); assert.equal(r.code, 1); assert.match(r.out, /contains an expression/); });
test('Code node syntax error fails', () => { const r = run((w) => { node(w, 'Retry budget').parameters.jsCode = 'return [{ json: ]'; }); assert.equal(r.code, 1); assert.match(r.out, /syntax/); });
test('Code node referencing a non-upstream node fails', () => { const r = run((w) => { node(w, 'Normalize request').parameters.jsCode = "return [{ json: $('Notify').first().json }];"; }); assert.equal(r.code, 1); assert.match(r.out, /not upstream/); });
test('Code node using require fails', () => { const r = run((w) => { node(w, 'Retry budget').parameters.jsCode = "const fs = require('fs'); return [{ json: {} }];"; }); assert.equal(r.code, 1); assert.match(r.out, /require/); });
test('connection to missing node fails', () => { const r = run((w) => { w.connections['Backoff'].main[0].push({ node: 'Ghost', type: 'main', index: 0 }); }); assert.equal(r.code, 1); assert.match(r.out, /unknown node Ghost/); });
test('IF output beyond 2 fails', () => { const r = run((w) => { w.connections['Valid?'].main.push([], [{ node: 'Notify', type: 'main', index: 0 }]); }); assert.equal(r.code, 1); assert.match(r.out, /uses output 2/); });
test('unreachable node fails', () => { const r = run((w) => { w.nodes.push({ id: 'x', name: 'Orphan', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {} }); }); assert.equal(r.code, 1); assert.match(r.out, /not reachable/); });
test('wrong credential type for a node fails', () => { const r = run((w) => { node(w, 'Record kill request').credentials = { redis: { id: 'a', name: 'b' } }; }); assert.equal(r.code, 1); assert.match(r.out, /does not accept credential redis/); });
test('missing sub-workflow target fails', () => { const r = run((w) => { node(w, 'Notify').parameters.workflowId.value = 'AQOS99Nothing000'; }); assert.equal(r.code, 1); assert.match(r.out, /unknown workflow/); });

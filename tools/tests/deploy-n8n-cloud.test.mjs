// The deploy tool against a mock n8n API that rejects what the real public API rejects
// (unknown body properties) and assigns its own ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWED = new Set(['name', 'nodes', 'connections', 'settings']);

function mockApi() {
  const store = new Map();
  const log = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers['x-n8n-api-key'] !== 'test-key') return send(401, { message: 'unauthorized' });
      const url = new URL(req.url, 'http://x');
      log.push(`${req.method} ${url.pathname}`);
      const body = raw ? JSON.parse(raw) : null;
      if (req.method === 'GET' && url.pathname === '/api/v1/workflows') return send(200, { data: [...store.values()].map(({ id, name }) => ({ id, name })), nextCursor: null });
      if (req.method === 'POST' && url.pathname === '/api/v1/workflows') {
        const extra = Object.keys(body).filter((k) => !ALLOWED.has(k));
        if (extra.length) return send(400, { message: `request/body must NOT have additional properties: ${extra.join(', ')}` });
        const id = `srv${++seq}`; store.set(id, { id, ...body }); return send(200, { id, name: body.name });
      }
      const m = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)$/);
      if (req.method === 'PUT' && m) {
        const extra = Object.keys(body).filter((k) => !ALLOWED.has(k));
        if (extra.length) return send(400, { message: `additional properties: ${extra.join(', ')}` });
        if (!store.has(m[1])) return send(404, { message: 'not found' });
        store.set(m[1], { id: m[1], ...body }); return send(200, { id: m[1], name: body.name });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/v1/credentials/schema/')) return send(200, { required: ['host', 'port'], properties: { host: { type: 'string' }, port: { type: 'number', default: 5432 } } });
      if (req.method === 'POST' && url.pathname === '/api/v1/credentials') return send(200, { id: `cred${++seq}`, name: body.name });
      return send(404, { message: 'no route' });
    });
  });
  return { server, store, log };
}

const run = (base, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['tools/deploy-n8n-cloud.mjs', ...args], { cwd: ROOT, env: { ...process.env, N8N_BASE_URL: base, N8N_API_KEY: 'test-key' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

test('deploys 17 workflows, rewrites sub-workflow links and credentials, and is idempotent', async () => {
  const mapFile = join(ROOT, 'deploy', 'credential-ids.json');
  const hadMap = existsSync(mapFile);
  const { server, store, log } = mockApi();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await run(base, ['--credentials']);
    assert.equal(first.code, 0, first.out);
    assert.equal(store.size, 17);
    // no stale AQOS ids survive: every executeWorkflow target and the error workflow are server ids
    for (const w of store.values()) {
      for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.executeWorkflow')) assert.match(n.parameters.workflowId.value, /^srv\d+$/, `${w.name}: ${n.name}`);
      if (w.settings.errorWorkflow) assert.match(w.settings.errorWorkflow, /^srv\d+$/);
      for (const n of w.nodes) for (const ref of Object.values(n.credentials ?? {})) assert.match(ref.id, /^cred\d+$/, `${w.name}: ${n.name} credential ${ref.name}`);
    }
    assert.ok([...store.values()].filter((w) => w.settings.errorWorkflow).length >= 15);
    const created = log.filter((l) => l === 'POST /api/v1/workflows').length;
    assert.equal(created, 17);
    // second run updates, never duplicates
    log.length = 0;
    const second = await run(base, []);
    assert.equal(second.code, 0, second.out);
    assert.equal(store.size, 17);
    assert.equal(log.filter((l) => l === 'POST /api/v1/workflows').length, 0);
    assert.equal(log.filter((l) => l.startsWith('PUT')).length, 34);
    assert.match(second.out, /updated/);
  } finally {
    server.close();
    if (!hadMap && existsSync(mapFile)) rmSync(mapFile);
  }
});

test('a wrong API key stops with a clear error and creates nothing', async () => {
  const { server, store } = mockApi();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const p = spawn(process.execPath, ['tools/deploy-n8n-cloud.mjs'], { cwd: ROOT, env: { ...process.env, N8N_BASE_URL: base, N8N_API_KEY: 'wrong' } });
  let out = '';
  p.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((r) => p.on('close', r));
  server.close();
  assert.equal(code, 1);
  assert.match(out, /401|unauthorized/);
  assert.equal(store.size, 0);
});

test('dry run needs no network or key and sends nothing', async () => {
  const p = spawn(process.execPath, ['tools/deploy-n8n-cloud.mjs', '--dry'], { cwd: ROOT, env: { ...process.env, N8N_BASE_URL: '', N8N_API_KEY: '' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => p.on('close', r));
  assert.equal(code, 0);
  assert.match(out, /17 workflows/);
  assert.match(out, /nothing was sent/);
});

test('the API key is never written to the credential map file', () => {
  const f = join(ROOT, 'deploy', 'credential-ids.json');
  if (existsSync(f)) assert.ok(!readFileSync(f, 'utf8').includes('test-key'));
});

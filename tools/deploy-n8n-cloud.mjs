#!/usr/bin/env node
// Deploys n8n/workflows/*.json to an n8n instance (Cloud or self-hosted) through the
// public REST API, then repairs what an API import breaks: workflow ids are assigned
// by the server, so Execute Workflow links and the error-workflow setting are rewritten
// to the new ids. Idempotent: workflows are matched by name and updated, not duplicated.
//
//   N8N_BASE_URL=https://<you>.app.n8n.cloud N8N_API_KEY=<key> node tools/deploy-n8n-cloud.mjs [flags]
//
//   --dry            offline: validate files and print the plan (no network, no key needed)
//   --credentials    create the 19 AQOS credentials with PLACEHOLDER data (edit secrets in the n8n UI)
//   --activate       publish workflows that are marked active in the spec
//   --dir <path>     workflow folder (default n8n/workflows)
//
// Credential ids are kept in deploy/credential-ids.json ({ "<credential name>": "<n8n id>" });
// create credentials by hand in the UI and list their ids there if --credentials cannot.
// The API key is read from the environment only; it is never written to disk or logged.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const DRY = flag('--dry');
const DIR = join(ROOT, opt('--dir', 'n8n/workflows'));
const BASE = (process.env.N8N_BASE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.N8N_API_KEY ?? '';
const MAP_FILE = join(ROOT, 'deploy', 'credential-ids.json');

const workflows = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
const credTemplate = JSON.parse(readFileSync(join(ROOT, 'deploy', 'credentials.template.json'), 'utf8'));
let credMap = existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf8')) : {};

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': KEY, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${data.message ?? JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// The public API rejects unknown properties, so send only what it accepts.
const SETTINGS_OK = ['executionOrder', 'timezone', 'saveDataErrorExecution', 'saveDataSuccessExecution', 'saveManualExecutions', 'saveExecutionProgress', 'executionTimeout', 'errorWorkflow'];
export function toApiBody(wf, idMap, credByName) {
  const nodes = wf.nodes.map((n) => {
    const out = structuredClone(n);
    for (const ref of Object.values(out.credentials ?? {})) if (credByName[ref.name]) ref.id = credByName[ref.name];
    const wid = out.parameters?.workflowId;
    if (out.type === 'n8n-nodes-base.executeWorkflow' && wid?.value && idMap[wid.value]) out.parameters.workflowId = { ...wid, value: idMap[wid.value] };
    return out;
  });
  const settings = Object.fromEntries(Object.entries(wf.settings ?? {}).filter(([k]) => SETTINGS_OK.includes(k)));
  if (settings.errorWorkflow) { if (idMap[settings.errorWorkflow]) settings.errorWorkflow = idMap[settings.errorWorkflow]; else delete settings.errorWorkflow; }
  return { name: wf.name, nodes, connections: wf.connections, settings };
}

function placeholderFromSchema(schema) {
  const data = {};
  for (const k of schema.required ?? []) {
    const p = schema.properties?.[k] ?? {};
    if (p.default !== undefined) data[k] = p.default;
    else if (Array.isArray(p.enum)) data[k] = p.enum[0];
    else if (p.type === 'number' || p.type === 'integer') data[k] = 1;
    else if (p.type === 'boolean') data[k] = false;
    else data[k] = 'REPLACE_ME';
  }
  return data;
}

function plan() {
  const external = new Set();
  for (const w of workflows) for (const n of w.nodes) {
    const m = String(n.parameters?.url ?? '').match(/^https?:\/\/([a-z0-9-]+)(?::\d+)?\//i);
    if (m && /^(stream-gw|model-svc|portfolio-svc|risk-svc|ems|ems-standby|data-adapter)$/.test(m[1])) external.add(m[1]);
  }
  console.log(`${workflows.length} workflows, ${workflows.reduce((a, w) => a + w.nodes.length, 0)} nodes, ${credTemplate.length} credentials`);
  console.log('Needs reachable from n8n Cloud: a hosted PostgreSQL (db/schema.sql loaded) and Redis; ' + (external.size ? `service hostnames [${[...external].join(', ')}] only resolve inside Docker, so use public URLs or skip those paths.` : ''));
}

export async function deploy() {
  const idMap = {};
  const results = [];
  // credentials
  if (flag('--credentials')) {
    for (const c of credTemplate) {
      if (credMap[c.name]) continue;
      try {
        const schema = await api('GET', `/credentials/schema/${c.type}`);
        const created = await api('POST', '/credentials', { name: c.name, type: c.type, data: placeholderFromSchema(schema) });
        credMap[c.name] = created.id;
        console.log(`credential created: ${c.name} (${c.type})`);
      } catch (e) { console.log(`credential FAILED: ${c.name} (${c.type}): ${e.message}\n  create it in the UI with this exact name and add its id to deploy/credential-ids.json`); }
    }
    writeFileSync(MAP_FILE, `${JSON.stringify(credMap, null, 2)}\n`);
  }
  // existing workflows by name
  const existing = {};
  let cursor;
  do {
    const page = await api('GET', `/workflows?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const w of page.data ?? []) existing[w.name] = w.id;
    cursor = page.nextCursor;
  } while (cursor);
  // pass 1: create or update without cross-links
  for (const wf of workflows) {
    const body = toApiBody(wf, {}, credMap);
    const had = existing[wf.name];
    const res = had ? await api('PUT', `/workflows/${had}`, body) : await api('POST', '/workflows', body);
    idMap[wf.id] = res.id;
    results.push({ name: wf.name, id: res.id, action: had ? 'updated' : 'created' });
  }
  // pass 2: rewrite Execute Workflow links and the error workflow to the real ids
  for (const wf of workflows) await api('PUT', `/workflows/${idMap[wf.id]}`, toApiBody(wf, idMap, credMap));
  if (flag('--activate')) {
    for (const wf of workflows.filter((w) => w.active)) {
      try { await api('POST', `/workflows/${idMap[wf.id]}/activate`, {}); console.log(`activated: ${wf.name}`); }
      catch (e) { console.log(`not activated: ${wf.name}: ${e.message}`); }
    }
  }
  console.log('');
  for (const r of results) console.log(`${r.action.padEnd(8)} ${r.name.padEnd(42)} ${BASE}/workflow/${r.id}`);
  return { idMap, results };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  plan();
  if (DRY) { console.log('dry run: nothing was sent'); process.exit(0); }
  if (!BASE || !KEY) { console.error('Set N8N_BASE_URL and N8N_API_KEY (n8n: Settings > n8n API > Create an API key).'); process.exit(2); }
  await deploy().catch((e) => { console.error(`deploy failed: ${e.message}`); process.exit(1); });
}

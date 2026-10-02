#!/usr/bin/env node
// Builds n8n/workflows/*.json from n8n/specs/*.spec.mjs.
//   * inlines Code-node scripts from n8n/code/ (//@include supported)
//   * assigns deterministic node ids, lays nodes out left to right
//   * resolves connection shorthands (IF/Switch/batch outputs, AI sub-nodes)
//   * replaces @@TOKENS@@ from deploy/config.json (defaults are placeholders)
// Import: n8n import:workflow --separate --input=n8n/workflows
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readScript } from './lib/code.mjs';
import { ERROR_WORKFLOW_ID } from './lib/dsl.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = join(ROOT, 'n8n', 'specs');
const OUT = join(ROOT, 'n8n', 'workflows');
const cfgPath = join(ROOT, 'deploy', 'config.json');
const CONFIG = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
const DEFAULTS = {
  SLACK_OPS_CHANNEL: 'aqos-ops', PAGERDUTY_SERVICE_ID: 'REPLACE_PAGERDUTY_SERVICE_ID',
  PAGERDUTY_FROM_EMAIL: 'oncall@example.com', MAIL_FROM: 'AQOS <no-reply@example.com>',
  SCREENING_URL: 'https://screening.example.com/v1/check', DEADMAN_URL: 'https://hc-ping.example.com/REPLACE',
  DASHBOARD_URL: 'https://app.example.com',
};
const CFG = { ...DEFAULTS, ...CONFIG };

const uuid = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const subTokens = (v) => {
  if (typeof v === 'string') return v.replace(/@@([A-Z0-9_]+)@@/g, (m, k) => (k in CFG ? CFG[k] : m));
  if (Array.isArray(v)) return v.map(subTokens);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subTokens(x)]));
  return v;
};
const fillFilterIds = (v, seed) => {
  if (Array.isArray(v)) return v.map((x, i) => fillFilterIds(x, `${seed}.${i}`));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = fillFilterIds(x, `${seed}.${k}`);
    if ('leftValue' in out && 'operator' in out && !out.id) out.id = uuid(`${seed}:cond`);
    return out;
  }
  return v;
};

function outputIndex(n, out) {
  if (out === undefined) return 0;
  if (typeof out === 'number') return out;
  const i = (n.__outputs ?? []).indexOf(out);
  if (i < 0) throw new Error(`node "${n.name}" has no output "${out}" (has: ${(n.__outputs ?? []).join(', ') || 'single output'})`);
  return i;
}

export function buildWorkflow(spec) {
  const byName = new Map();
  for (const n of spec.nodes) {
    if (byName.has(n.name)) throw new Error(`${spec.id}: duplicate node name "${n.name}"`);
    byName.set(n.name, n);
  }
  const connections = {};
  const edges = [];
  for (const c of spec.connections) {
    const [from, to, opt = {}] = c;
    const a = byName.get(from);
    const b = byName.get(to);
    if (!a) throw new Error(`${spec.id}: connection from unknown node "${from}"`);
    if (!b) throw new Error(`${spec.id}: connection to unknown node "${to}"`);
    const type = opt.type ?? 'main';
    const idx = type === 'main' ? outputIndex(a, opt.out) : 0;
    connections[from] ??= {};
    connections[from][type] ??= [];
    while (connections[from][type].length <= idx) connections[from][type].push([]);
    connections[from][type][idx].push({ node: to, type, index: opt.in ?? 0 });
    edges.push([from, to, type]);
  }

  // Layout: x by longest-path depth from triggers, AI sub-nodes sit below their parent.
  const depth = new Map();
  const mainEdges = edges.filter((e) => e[2] === 'main');
  const indeg = new Map(spec.nodes.map((n) => [n.name, 0]));
  for (const [, to] of mainEdges) indeg.set(to, indeg.get(to) + 1);
  const queue = spec.nodes.filter((n) => indeg.get(n.name) === 0).map((n) => n.name);
  for (const q of queue) depth.set(q, 0);
  const seen = new Set();
  for (let i = 0; i < queue.length && i < 5000; i++) {
    const cur = queue[i];
    for (const [f, t] of mainEdges) {
      if (f !== cur) continue;
      const d = (depth.get(cur) ?? 0) + 1;
      if (!depth.has(t) || (d > depth.get(t) && d < 60)) { depth.set(t, d); queue.push(t); }
    }
    seen.add(cur);
  }
  for (const [f, t, ty] of edges) if (ty !== 'main') depth.set(f, depth.get(t) ?? 0);
  const rows = new Map();
  const nodes = spec.nodes.map((n) => {
    const d = depth.get(n.name) ?? 0;
    const isAi = edges.some(([f, , ty]) => f === n.name && ty !== 'main');
    const rowKey = `${d}:${isAi}`;
    const r = rows.get(rowKey) ?? 0;
    rows.set(rowKey, r + 1);
    const out = {
      id: uuid(`${spec.id}:${n.name}`),
      name: n.name,
      type: n.type,
      typeVersion: n.typeVersion,
      position: [d * 280, (isAi ? 420 : 0) + r * 150],
      parameters: structuredClone(n.parameters),
    };
    if (n.credentials) out.credentials = structuredClone(n.credentials);
    for (const k of ['retryOnFail', 'maxTries', 'waitBetweenTries', 'onError', 'alwaysOutputData', 'executeOnce', 'notes', 'notesInFlow']) if (n[k] !== undefined) out[k] = n[k];
    if (n.type === 'n8n-nodes-base.code') {
      let js = readScript(out.parameters.__script);
      for (const [k, v] of Object.entries(out.parameters.__replace ?? {})) js = js.split(k).join(v);
      delete out.parameters.__script;
      delete out.parameters.__replace;
      out.parameters.jsCode = js;
    }
    out.parameters = subTokens(fillFilterIds(out.parameters, `${spec.id}:${n.name}`));
    return out;
  });

  const settings = {
    executionOrder: 'v1', timezone: 'UTC', saveDataErrorExecution: 'all', saveManualExecutions: false,
    ...(spec.id === ERROR_WORKFLOW_ID ? {} : { errorWorkflow: ERROR_WORKFLOW_ID }),
    ...(spec.settings ?? {}),
  };
  return { id: spec.id, name: spec.name, active: spec.active === true, nodes, connections, settings, pinData: {}, tags: [{ name: 'aqos' }], meta: { templateCredsSetupCompleted: true } };
}

export async function loadSpecs() {
  const files = readdirSync(SPECS).filter((f) => f.endsWith('.spec.mjs')).sort();
  const specs = [];
  for (const f of files) specs.push((await import(pathToFileURL(join(SPECS, f)).href)).default);
  return specs;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const specs = await loadSpecs();
  const ids = new Set();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const s of specs) {
    if (ids.has(s.id)) throw new Error(`duplicate workflow id ${s.id}`);
    ids.add(s.id);
    const wf = buildWorkflow(s);
    writeFileSync(join(OUT, `${s.id}.json`), `${JSON.stringify(wf, null, 2)}\n`);
    console.log(`built ${s.id}  ${wf.nodes.length.toString().padStart(3)} nodes  ${s.name}`);
  }
  console.log(`\n${specs.length} workflows -> ${OUT}`);
}

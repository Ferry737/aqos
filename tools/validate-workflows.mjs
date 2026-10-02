#!/usr/bin/env node
// Validates n8n/workflows/*.json against the n8n 2.41 node catalog snapshot,
// the database schema and AQOS policy. Exit code 1 on any ERROR.
//   ERROR  : would fail to import/run, or violates a safety policy
//   WARN   : worth a look
// Also writes docs/feasibility.json: every external dependency that needs
// custom development (n8n core nodes and generic HTTP/Code are native).
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntaxCheck, nodeRefs } from './lib/code.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAT = JSON.parse(readFileSync(join(ROOT, 'tools/catalog/n8n-2.41.4.json'), 'utf8'));
const SQL = readFileSync(join(ROOT, 'db/schema.sql'), 'utf8');
const WF_DIR = process.env.AQOS_WF_DIR ?? join(ROOT, 'n8n/workflows');
const wfs = readdirSync(WF_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(WF_DIR, f), 'utf8')));
const wfIds = new Set(wfs.map((w) => w.id));

const FUNCS = new Set([...SQL.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z_]+\.[a-z_]+)\(/g)].map((m) => m[1]));
const TRIGGERS = new Set(['n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.stripeTrigger', 'n8n-nodes-base.manualTrigger']);
const SUB_TYPES = { ai_languageModel: ['@n8n/n8n-nodes-langchain.lmChatAnthropic'], ai_outputParser: ['@n8n/n8n-nodes-langchain.outputParserStructured'], ai_tool: null };

let errors = 0;
let warns = 0;
const err = (w, n, m) => { errors++; console.log(`  ERROR [${w.id}] ${n ? `"${n}": ` : ''}${m}`); };
const warn = (w, n, m) => { warns++; console.log(`  WARN  [${w.id}] ${n ? `"${n}": ` : ''}${m}`); };

// catalog lookup with runtime-generated Tool variants (postgresTool etc.)
function entryFor(type, version) {
  let base = type;
  let tool = false;
  if (!CAT.nodes[type] && type.endsWith('Tool') && CAT.nodes[type.slice(0, -4)]?.[0]) { base = type.slice(0, -4); tool = true; }
  const list = CAT.nodes[base];
  if (!list) return { error: `node type not in catalog: ${type}` };
  const e = list.find((x) => [].concat(x.version).includes(version));
  if (!e) return { error: `typeVersion ${version} not available for ${base} (have ${list.map((x) => JSON.stringify(x.version)).join(' | ')})` };
  if (tool && !e.usableAsTool) return { error: `${base} cannot be used as an AI tool` };
  return { e, tool };
}

// Walk declared properties; flag parameter keys the node does not declare and
// invalid option values. Expressions ("=...") are not value-checked.
function checkParams(props, params, path, report) {
  const byName = new Map();
  for (const p of props) { if (!byName.has(p.name)) byName.set(p.name, []); byName.get(p.name).push(p); }
  for (const [k, v] of Object.entries(params ?? {})) {
    if (k.startsWith('__')) continue;
    const decls = byName.get(k);
    if (!decls) { report(`${path}${k}: parameter not declared by this node/version`); continue; }
    const first = decls[0];
    if (typeof v === 'string' && v.startsWith('=')) continue;
    if (first.type === 'options' && typeof v === 'string' && v !== '') {
      const allowed = new Set(decls.flatMap((d) => (d.options ?? []).map((o) => o.value)));
      if (allowed.size && !allowed.has(v)) report(`${path}${k}: "${v}" is not one of [${[...allowed].slice(0, 12).join(', ')}]`);
    }
    if (first.type === 'collection' && v && typeof v === 'object') {
      const sub = decls.flatMap((d) => d.options ?? []);
      checkParams(sub, v, `${path}${k}.`, report);
    }
    if (first.type === 'fixedCollection' && v && typeof v === 'object') {
      const groups = new Map(decls.flatMap((d) => d.options ?? []).map((g) => [g.name, g.values ?? []]));
      for (const [gk, gv] of Object.entries(v)) {
        if (!groups.has(gk)) { report(`${path}${k}.${gk}: group not declared`); continue; }
        for (const row of [].concat(gv)) if (row && typeof row === 'object') checkParams(groups.get(gk), row, `${path}${k}.${gk}.`, report);
      }
    }
  }
  for (const [name, decls] of byName) {
    const req = decls.filter((d) => d.required && !d.displayOptions);
    if (req.length && !(name in (params ?? {})) && req[0].default === '') report(`${path}${name}: required parameter missing`);
  }
}

function outputCount(n, entry) {
  const out = entry.outputs;
  if (n.type === 'n8n-nodes-base.if') return 2;
  if (n.type === 'n8n-nodes-base.switch') return (n.parameters.rules?.values?.length ?? 0) + (n.parameters.options?.fallbackOutput === 'extra' ? 1 : 0);
  if (n.type === 'n8n-nodes-base.splitInBatches') return 2;
  if (n.onError === 'continueErrorOutput') return 2;
  if (Array.isArray(out)) return out.length;
  return 1;
}

function ancestors(w, name) {
  const rev = new Map();
  for (const [from, types] of Object.entries(w.connections)) for (const outs of types.main ?? []) for (const c of outs ?? []) { if (!rev.has(c.node)) rev.set(c.node, []); rev.get(c.node).push(from); }
  const seen = new Set();
  const stack = [name];
  while (stack.length) {
    const cur = stack.pop();
    for (const p of rev.get(cur) ?? []) if (!seen.has(p)) { seen.add(p); stack.push(p); }
  }
  return seen;
}

const external = new Set();
const nativeTypes = new Set();
console.log(`Validating ${wfs.length} workflows against n8n ${CAT.n8nNodesBase} (nodes) / ${CAT.langchain} (langchain), ${FUNCS.size} SQL functions\n`);

for (const w of wfs) {
  console.log(`${w.id}  ${w.name}`);
  const names = new Set(w.nodes.map((n) => n.name));
  const triggers = w.nodes.filter((n) => TRIGGERS.has(n.type));
  if (!triggers.length) err(w, null, 'no trigger node');
  if (w.settings?.errorWorkflow && !wfIds.has(w.settings.errorWorkflow)) err(w, null, `errorWorkflow ${w.settings.errorWorkflow} does not exist`);
  if (w.id !== 'AQOS13ErrorHandl' && w.settings?.errorWorkflow !== 'AQOS13ErrorHandl') warn(w, null, 'does not use the AQOS error workflow');

  for (const n of w.nodes) {
    nativeTypes.add(n.type);
    const { e, error, tool } = entryFor(n.type, n.typeVersion);
    if (error) { err(w, n.name, error); continue; }
    const props = tool ? [...e.properties, { name: 'descriptionType', type: 'options', options: [{ value: 'auto' }, { value: 'manual' }] }, { name: 'toolDescription', type: 'string' }] : e.properties;
    checkParams(props, n.parameters, '', (m) => err(w, n.name, m));

    // credentials
    for (const [ctype, ref] of Object.entries(n.credentials ?? {})) {
      if (!CAT.credentials[ctype]) err(w, n.name, `credential type ${ctype} unknown`);
      const accepted = e.credentials.map((c) => c.name);
      const generic = n.type === 'n8n-nodes-base.httpRequest' && ['httpHeaderAuth', 'anthropicApi'].includes(ctype);
      if (!accepted.includes(ctype) && !generic) err(w, n.name, `node does not accept credential ${ctype} (accepts ${accepted.join(', ') || 'none'})`);
      if (!ref?.id || !ref?.name) err(w, n.name, 'credential reference needs id and name');
    }
    const needsCred = e.credentials.filter((c) => c.required && !c.displayOptions).map((c) => c.name);
    for (const c of needsCred) if (!n.credentials?.[c]) err(w, n.name, `required credential ${c} not set`);

    // HTTP policy
    if (n.type === 'n8n-nodes-base.httpRequest') {
      const url = String(n.parameters.url ?? '');
      if (!n.parameters.options?.timeout) err(w, n.name, 'HTTP node without explicit timeout');
      const m = url.match(/^https?:\/\/([a-z0-9.-]+)/i);
      if (m && !/anthropic\.com$|binance|bybit/.test(m[1]) && /^(stream-gw|model-svc|portfolio-svc|risk-svc|ems|ems-standby|data-adapter)$/.test(m[1])) external.add(`${m[1]}${url.slice(m[0].length).split('?')[0]}`);
      if (/anthropic\.com/.test(url)) {
        const hdr = (n.parameters.headerParameters?.parameters ?? []).map((p) => p.name);
        if (!hdr.includes('anthropic-version')) err(w, n.name, 'Anthropic call without anthropic-version header');
        if (n.onError !== 'continueRegularOutput') err(w, n.name, 'Anthropic call must continue on error (deterministic fallback)');
      }
      if (n.parameters.method !== 'GET' && !n.retryOnFail && !/anthropic|screening|@@/.test(url)) warn(w, n.name, 'non-GET without retry (ok if the callee is not idempotent)');
    }
    // Postgres policy
    if (n.type === 'n8n-nodes-base.postgres' || n.type === 'n8n-nodes-base.postgresTool') {
      const q = String(n.parameters.query ?? '');
      if (/\{\{/.test(q)) err(w, n.name, 'SQL contains an expression; pass data via queryReplacement');
      const call = q.match(/(?:SELECT\s+\*\s+FROM|SELECT)\s+([a-z_]+\.[a-z_]+)\(/i);
      if (call && !FUNCS.has(call[1])) err(w, n.name, `calls unknown SQL function ${call[1]}`);
      if (call && !/\$1::jsonb/.test(q) && !/\(\)/.test(q)) err(w, n.name, `function call ${call[1]} must pass its argument as $1::jsonb`);
      if (n.type === 'n8n-nodes-base.postgresTool' && /\b(insert|update|delete|drop|alter|truncate)\b/i.test(q)) err(w, n.name, 'AI tool SQL must be read-only or a SECURITY DEFINER function call');
      if (n.type === 'n8n-nodes-base.postgresTool' && n.credentials?.postgres?.id !== 'aqosCredPgAgent00') err(w, n.name, 'AI tools must use the read-only agent credential');
      if (n.type === 'n8n-nodes-base.postgres' && n.credentials?.postgres?.id === 'aqosCredPgAgent00') err(w, n.name, 'workflow nodes must not use the agent credential');
      const fromView = [...q.matchAll(/\bFROM\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]);
      for (const v of fromView) if (n.type === 'n8n-nodes-base.postgresTool' && !/\.v_/.test(v)) err(w, n.name, `AI tool reads ${v}; agents may only read v_* views`);
    }
    // sub-workflow targets
    if (n.type === 'n8n-nodes-base.executeWorkflow') {
      const id = n.parameters.workflowId?.value;
      if (!wfIds.has(id)) err(w, n.name, `executes unknown workflow ${id}`);
    }
    // Code node checks
    if (n.type === 'n8n-nodes-base.code') {
      const js = n.parameters.jsCode ?? '';
      const se = syntaxCheck(js, n.name);
      if (se) err(w, n.name, `syntax: ${se}`);
      if (/\brequire\s*\(|\bprocess\.|\bfetch\s*\(|\$env\b|\bsetTimeout\b|\bimport\s/.test(js.replace(/\/\/.*$/gm, ''))) err(w, n.name, 'uses require/process/fetch/$env/timers (not available or blocked in n8n Code nodes)');
      const anc = ancestors(w, n.name);
      for (const ref of nodeRefs(js)) {
        if (!names.has(ref)) err(w, n.name, `references $('${ref}') which is not a node of this workflow`);
        else if (!anc.has(ref) && ref !== n.name) err(w, n.name, `references $('${ref}') which is not upstream of this node`);
      }
      if (js.includes('__SOURCE__')) err(w, n.name, 'unreplaced __SOURCE__ token');
    }
    if (n.type.includes('Tool') === false && n.parameters && JSON.stringify(n.parameters).includes('@@')) warn(w, n.name, 'unreplaced @@TOKEN@@ placeholder: set it in deploy/config.json');
  }

  // connections
  for (const [from, types] of Object.entries(w.connections)) {
    const src = w.nodes.find((x) => x.name === from);
    if (!src) { err(w, from, 'connection from unknown node'); continue; }
    const entry = entryFor(src.type, src.typeVersion).e;
    for (const [type, outs] of Object.entries(types)) {
      if (type !== 'main') {
        const allowed = SUB_TYPES[type];
        if (allowed && !allowed.includes(src.type)) err(w, from, `${type} connection from unexpected node type ${src.type}`);
        for (const outList of outs) for (const c of outList) {
          const dst = w.nodes.find((x) => x.name === c.node);
          if (!dst) err(w, from, `${type} connects to unknown node ${c.node}`);
          else if (dst.type !== '@n8n/n8n-nodes-langchain.agent') err(w, from, `${type} must connect to an Agent, got ${dst.type}`);
        }
        continue;
      }
      const max = entry ? outputCount(src, entry) : 1;
      outs.forEach((outList, idx) => {
        if (idx >= max) err(w, from, `uses output ${idx} but the node has ${max} output(s)`);
        for (const c of outList) if (!names.has(c.node)) err(w, from, `connects to unknown node ${c.node}`);
      });
    }
  }
  // reachability: every non-trigger, non-subnode must be reachable from a trigger
  const reach = new Set(triggers.map((t) => t.name));
  const stack = [...reach];
  while (stack.length) {
    const cur = stack.pop();
    for (const outs of w.connections[cur]?.main ?? []) for (const c of outs ?? []) if (!reach.has(c.node)) { reach.add(c.node); stack.push(c.node); }
  }
  const subNodes = new Set();
  for (const types of Object.values(w.connections)) for (const [t, outs] of Object.entries(types)) if (t !== 'main') for (const l of outs) for (const c of l) subNodes.add(c.node);
  for (const [from, types] of Object.entries(w.connections)) for (const t of Object.keys(types)) if (t !== 'main') subNodes.add(from);
  for (const n of w.nodes) if (!reach.has(n.name) && !subNodes.has(n.name)) err(w, n.name, 'not reachable from any trigger');
  // every agent has a model
  for (const n of w.nodes.filter((x) => x.type === '@n8n/n8n-nodes-langchain.agent')) {
    const hasModel = Object.entries(w.connections).some(([f, t]) => (t.ai_languageModel ?? []).some((l) => l.some((c) => c.node === n.name)));
    if (!hasModel) err(w, n.name, 'agent has no chat model connected');
  }
}

if (!process.env.AQOS_WF_DIR) mkdirSync(join(ROOT, 'docs'), { recursive: true });
const ext = [...external].sort();
if (!process.env.AQOS_WF_DIR) writeFileSync(join(ROOT, 'docs/feasibility.json'), `${JSON.stringify({
  n8nVersion: CAT.n8nNodesBase,
  nativeNodeTypes: [...nativeTypes].sort(),
  customDevelopmentRequired: ext,
  note: 'Everything in n8n is native or generic HTTP/Code. The endpoints below are services the workflows call and must be built (see docs/blueprint).',
}, null, 2)}\n`);

console.log(`\n${wfs.length} workflows, ${wfs.reduce((a, w) => a + w.nodes.length, 0)} nodes, ${errors} error(s), ${warns} warning(s)`);
console.log(`${nativeTypes.size} native node types used; ${ext.length} custom service endpoints referenced`);
process.exit(errors ? 1 : 0);

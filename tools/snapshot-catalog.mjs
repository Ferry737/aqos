#!/usr/bin/env node
// Builds tools/catalog/n8n-<version>.json: a trimmed snapshot of the n8n node
// and credential definitions that AQOS uses (types, versions, outputs and the
// full parameter schemas). The validator checks every workflow node against
// this snapshot, so "is this node feasible in native n8n?" has a machine answer.
//
//   node tools/snapshot-catalog.mjs                 # npm pack the pinned packages
//   node tools/snapshot-catalog.mjs --from <dir>    # dir holds base/package and lc/package (already extracted)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PINS = { 'n8n-nodes-base': '2.41.4', '@n8n/n8n-nodes-langchain': '2.41.4' };

// Every node type AQOS workflows may use. Anything else fails validation.
const WANT = {
  'n8n-nodes-base': ['webhook', 'respondToWebhook', 'httpRequest', 'code', 'switch', 'if', 'postgres', 'redis',
    'scheduleTrigger', 'executeWorkflow', 'executeWorkflowTrigger', 'errorTrigger', 'wait', 'merge', 'noOp',
    'stopAndError', 'crypto', 'telegram', 'slack', 'emailSend', 'stripeTrigger', 'splitInBatches', 'splitOut',
    'aggregate', 'executionData', 'set', 'filter', 'limit', 'pagerDuty', 'dateTime', 'manualTrigger'],
  '@n8n/n8n-nodes-langchain': ['agent', 'lmChatAnthropic', 'toolWorkflow', 'toolThink', 'outputParserStructured', 'guardrails'],
};
const CREDS = ['postgres', 'redis', 'anthropicApi', 'httpHeaderAuth', 'telegramApi', 'stripeApi', 'smtp', 'slackApi', 'pagerDutyApi', 'crypto'];

function slimProp(p) {
  const o = { name: p.name, type: p.type };
  if (p.displayName) o.displayName = p.displayName;
  if (p.default !== undefined) o.default = p.default;
  if (p.required) o.required = true;
  if (p.displayOptions) o.displayOptions = p.displayOptions;
  if (p.typeOptions) {
    const t = {};
    for (const k of ['multipleValues', 'filter', 'minValue', 'maxValue']) if (p.typeOptions[k] !== undefined) t[k] = p.typeOptions[k];
    if (Object.keys(t).length) o.typeOptions = t;
  }
  if (Array.isArray(p.options)) {
    o.options = p.options.map((opt) => {
      if (Array.isArray(opt.values)) return { name: opt.name, values: opt.values.map(slimProp) };
      if (opt.type) return slimProp(opt);
      return { name: opt.name, value: opt.value };
    });
  }
  return o;
}

function prepare(dir) {
  const base = JSON.parse(readFileSync(join(dir, 'base/package/dist/types/nodes.json'), 'utf8'));
  const lc = JSON.parse(readFileSync(join(dir, 'lc/package/dist/types/nodes.json'), 'utf8'));
  const baseCreds = JSON.parse(readFileSync(join(dir, 'base/package/dist/types/credentials.json'), 'utf8'));
  const lcCreds = JSON.parse(readFileSync(join(dir, 'lc/package/dist/types/credentials.json'), 'utf8'));
  const nodes = {};
  for (const [pkg, list] of [['n8n-nodes-base', base], ['@n8n/n8n-nodes-langchain', lc]]) {
    for (const want of WANT[pkg]) {
      const entries = list.filter((n) => n.name === want);
      if (!entries.length) throw new Error(`catalog is missing ${pkg}.${want}`);
      nodes[`${pkg}.${want}`] = entries.map((n) => ({
        version: n.version,
        defaultVersion: n.defaultVersion ?? null,
        inputs: n.inputs,
        outputs: n.outputs,
        usableAsTool: n.usableAsTool ? true : false,
        credentials: (n.credentials ?? []).map((c) => ({ name: c.name, required: c.required === true, displayOptions: c.displayOptions })),
        properties: (n.properties ?? []).map(slimProp),
      }));
    }
  }
  const credentials = {};
  for (const c of [...baseCreds, ...lcCreds]) if (CREDS.includes(c.name)) credentials[c.name] = { properties: (c.properties ?? []).map((p) => p.name) };
  for (const c of CREDS) if (!credentials[c]) throw new Error(`catalog is missing credential ${c}`);
  return { nodes, credentials };
}

const fromIdx = process.argv.indexOf('--from');
let dir;
if (fromIdx > 0) {
  dir = process.argv[fromIdx + 1];
} else {
  dir = mkdtempSync(join(tmpdir(), 'aqos-catalog-'));
  mkdirSync(join(dir, 'base'), { recursive: true });
  mkdirSync(join(dir, 'lc'), { recursive: true });
  for (const [pkg, sub] of [['n8n-nodes-base', 'base'], ['@n8n/n8n-nodes-langchain', 'lc']]) {
    const spec = `${pkg}@${PINS[pkg]}`;
    const out = execFileSync('npm', ['pack', spec, '--silent'], { cwd: dir, shell: true, encoding: 'utf8' }).trim().split('\n').pop();
    execFileSync('tar', ['-xzf', out, '-C', join(dir, sub)], { cwd: dir });
  }
}
const snap = prepare(dir);
const out = join(ROOT, 'tools', 'catalog', `n8n-${PINS['n8n-nodes-base']}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ n8nNodesBase: PINS['n8n-nodes-base'], langchain: PINS['@n8n/n8n-nodes-langchain'], ...snap }));
console.log(`wrote ${out} (${Object.keys(snap.nodes).length} node types, ${Object.keys(snap.credentials).length} credential types)`);

#!/usr/bin/env node
// Structural check of the service contracts in docs/openapi/*.json: every
// endpoint the n8n workflows call must be described with a request schema (for
// POST), a 200 response schema with properties, and an auth scheme.
//   node tools/check-openapi.mjs [dir]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2] ?? join(ROOT, 'docs', 'openapi');
const REQUIRED = [
  ['post', '/v1/backfill'], ['post', '/v1/predict'], ['post', '/v1/propose'], ['post', '/v1/rebalance'], ['post', '/v1/allocation/propose'],
  ['get', '/v1/snapshot'], ['get', '/v1/headlines'],
  ['post', '/v1/orders/batch'], ['post', '/v1/kill'], ['post', '/v1/exposure'], ['post', '/v1/snapshots'], ['post', '/v1/keys/inspect'], ['post', '/v1/keys/destroy'],
];
const errors = [];
const found = new Map();
let webhooks = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let doc;
  try { doc = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch (e) { errors.push(`${f}: not valid JSON (${e.message})`); continue; }
  if (!/^3\.[01]/.test(doc.openapi ?? '')) errors.push(`${f}: openapi version must be 3.0 or 3.1`);
  if (!doc.components?.securitySchemes || !Object.keys(doc.components.securitySchemes).length) errors.push(`${f}: no security scheme`);
  webhooks += Object.keys(doc.webhooks ?? {}).length;
  const resolve = (s, depth = 0) => (s?.$ref && depth < 5 ? resolve(doc.components?.schemas?.[s.$ref.split('/').pop()], depth + 1) : s);
  for (const [path, item] of Object.entries(doc.paths ?? {})) for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
    found.set(`${method} ${path}`, f);
    const ok = resolve(op.responses?.['200']?.content?.['application/json']?.schema);
    if (!ok || !(ok.properties && Object.keys(ok.properties).length)) errors.push(`${f} ${method} ${path}: 200 response schema needs properties`);
    if (method === 'post') {
      const rq = resolve(op.requestBody?.content?.['application/json']?.schema);
      if (!rq || !(rq.properties && Object.keys(rq.properties).length)) errors.push(`${f} ${method} ${path}: request schema needs properties`);
    }
    if (!(op.responses?.['401'] || op.security || doc.security)) errors.push(`${f} ${method} ${path}: no auth described`);
  }
}
for (const [m, p] of REQUIRED) if (!found.has(`${m} ${p}`)) errors.push(`missing ${m.toUpperCase()} ${p}`);
if (webhooks < 1) errors.push('no webhooks section describing the signed events pushed to n8n (OpenAPI 3.1 "webhooks")');
if (errors.length) { console.log(errors.map((e) => `ERROR ${e}`).join('\n')); process.exit(1); }
console.log(`openapi ok: ${found.size} operations, ${webhooks} webhook(s)`);

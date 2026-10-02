#!/usr/bin/env node
// Writes deploy/credentials.template.json: the credentials the workflows
// reference by id/name, with EMPTY data. Import it (n8n import:credentials),
// then fill in secrets in the n8n UI or through your secret manager.
// Nothing secret is generated or stored by this script.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIALS } from './lib/credentials.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const list = Object.values(CREDENTIALS).map((c) => ({ id: c.id, name: c.name, type: c.type, data: {} }));
mkdirSync(join(ROOT, 'deploy'), { recursive: true });
writeFileSync(join(ROOT, 'deploy', 'credentials.template.json'), `${JSON.stringify(list, null, 2)}\n`);
console.log(`wrote deploy/credentials.template.json (${list.length} credentials, no secrets)`);

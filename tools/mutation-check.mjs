#!/usr/bin/env node
// Mutation check for the risk gate: deliberately breaks one safety rule at a
// time and requires the invariant tests to fail. A mutation the tests do not
// catch means the tests are too weak. The script restores the original file.
//   node tools/mutation-check.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'n8n/code/wf04-pretrade-checks.js');
const original = readFileSync(FILE, 'utf8');

const MUTATIONS = [
  ['REDUCE_ONLY rule removed', "if (mode === 'REDUCE_ONLY' && !rec('reduce_only_mode', reducing, { mode, position: r6(pos) })) { reject(); continue; }", '/* mutated */'],
  ['stale-mark check removed', "if (!rec('mark_fresh', num(mark?.age_s, Infinity) <= maxAge, num(mark?.age_s, null), maxAge)) { reject(px); continue; }", '/* mutated */'],
  ['batch exposure accumulation removed', 'st.gross += (Math.abs(newPos) - Math.abs(pos)) * px;', '/* mutated */'],
  ['HALT allowed', "if (!rec('trading_mode', mode !== 'HALT', mode)) { reject(); continue; }", '/* mutated */'],
  ['pair rule removed', "if (legs.length < 2 || legs.some((l) => l.decision === 'REJECT')) {", 'if (false) {'],
  ['unknown account allowed', "if (!rec('account_known', !!st, p.account_id)) { reject(); continue; }", '/* mutated */'],
  ['order notional cap removed', "shrink('max_order_notional', maxOrderUsd / px, r2(q * px), maxOrderUsd);", '/* mutated */'],
  ['unknown mode fails open', "return u in RANK ? u : 'HALT'; // unknown modes fail closed", "return u in RANK ? u : 'NORMAL';"],
];

let survived = 0;
try {
  for (const [name, from, to] of MUTATIONS) {
    if (!original.includes(from)) { console.log(`SKIP  ${name}: target text not found (script changed?)`); survived++; continue; }
    writeFileSync(FILE, original.replace(from, to));
    const r = spawnSync(process.execPath, ['--test', 'tools/tests/gate-invariants.test.mjs'], { cwd: ROOT, encoding: 'utf8' });
    const caught = r.status !== 0;
    if (!caught) survived++;
    console.log(`${caught ? 'CAUGHT  ' : 'SURVIVED'} ${name}`);
  }
} finally {
  writeFileSync(FILE, original);
}
const base = spawnSync(process.execPath, ['--test', 'tools/tests/gate-invariants.test.mjs'], { cwd: ROOT, encoding: 'utf8' });
console.log(`\nbaseline after restore: ${base.status === 0 ? 'pass' : 'FAIL'}; ${MUTATIONS.length - survived}/${MUTATIONS.length} mutations caught`);
process.exit(survived || base.status ? 1 : 0);

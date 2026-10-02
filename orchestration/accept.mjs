#!/usr/bin/env node
// Acceptance gate for one worker run. Accepts only if:
//   1. the worker changed nothing outside its listed deliverables
//   2. the acceptance command passes in the worker's workspace
//   3. the test count meets the task minimum (and `todo` tests are a minority)
//   4. mutation check: the tests kill at least half of simple mutants of the scripts they cover
// On success the deliverables are copied into the repo. Writes <run>/accept.json.
//   node orchestration/accept.mjs <task> <runsDir>
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [task, runsDir] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(join(ROOT, 'orchestration/tasks.json'), 'utf8'))[task];
if (!spec) { console.error(`unknown task ${task}`); process.exit(2); }
const RUN = join(runsDir, task);
const WS = join(RUN, 'ws');
const result = { task, accepted: false, reasons: [], details: {} };
const finish = () => { writeFileSync(join(RUN, 'accept.json'), JSON.stringify(result, null, 2)); console.log(`${task}: ${result.accepted ? 'ACCEPTED' : 'REJECTED'}${result.reasons.length ? ' - ' + result.reasons.join('; ') : ''}`); process.exit(result.accepted ? 0 : 1); };

if (!existsSync(WS)) { result.reasons.push('no workspace'); finish(); }
const missing = spec.deliverables.filter((d) => !existsSync(join(WS, d)));
if (missing.length) { result.reasons.push(`missing deliverables: ${missing.join(', ')}`); finish(); }

// 1. nothing else changed
const SKIP = new Set(['node_modules', 'AGENTS.md', 'TASK.md', 'CONTRACTS.md', 'BUGS.md', 'package-lock.json']);
const walk = (base, rel = '') => readdirSync(join(base, rel)).flatMap((n) => {
  if (SKIP.has(n) && !rel) return [];
  const r = rel ? `${rel}/${n}` : n;
  return statSync(join(base, r)).isDirectory() ? walk(base, r) : [r];
});
const changed = [];
for (const f of walk(WS)) {
  if (spec.deliverables.includes(f)) continue;
  const repoFile = join(ROOT, f);
  if (!existsSync(repoFile) || readFileSync(repoFile).compare(readFileSync(join(WS, f))) !== 0) changed.push(f);
}
const ignorable = (f) => /^(\.git|\.kilo|\.opencode|tmp)\//.test(f);
const bad = changed.filter((f) => !ignorable(f));
if (bad.length) { result.reasons.push(`modified files outside deliverables: ${bad.slice(0, 6).join(', ')}`); finish(); }

// 2. acceptance command
const [cmd, ...args] = spec.accept.split(' ');
const acc = spawnSync(cmd === 'node' ? process.execPath : cmd, args, { cwd: WS, encoding: 'utf8', timeout: 300000 });
const out = `${acc.stdout}\n${acc.stderr}`;
const num = (k) => Number((out.match(new RegExp(`ℹ ${k} (\\d+)`)) ?? [])[1] ?? NaN);
result.details = { tests: num('tests'), pass: num('pass'), fail: num('fail'), todo: num('todo') };
if (acc.status !== 0) { result.reasons.push(`acceptance command failed (exit ${acc.status})`); result.details.tail = out.split('\n').slice(-15).join('\n'); finish(); }
if (spec.minTests) {
  if (!(result.details.tests >= spec.minTests)) result.reasons.push(`only ${result.details.tests} tests, need ${spec.minTests}`);
  if (result.details.todo > Math.max(2, result.details.tests * 0.1)) result.reasons.push(`too many todo tests (${result.details.todo})`);
}
if (result.reasons.length) finish();

// 3. mutation check inside the workspace copy (scripts are identical to the repo's)
if (spec.mutate.length) {
  result.details.mutation = [];
  for (const [script, test] of spec.mutate) {
    const m = spawnSync(process.execPath, ['tools/mutate-script.mjs', script, test, '--max', '30'], { cwd: WS, encoding: 'utf8', timeout: 600000 });
    result.details.mutation.push(m.stdout.trim().split('\n')[0]);
    if (m.status !== 0) result.reasons.push(`weak tests for ${script}: ${m.stdout.trim().split('\n')[0]}`);
  }
}
if (result.reasons.length) finish();

// accept: copy deliverables (+ BUGS.md) into the repo
for (const d of spec.deliverables) { mkdirSync(dirname(join(ROOT, d)), { recursive: true }); copyFileSync(join(WS, d), join(ROOT, d)); }
if (existsSync(join(WS, 'BUGS.md'))) { mkdirSync(join(ROOT, 'orchestration/bugs'), { recursive: true }); copyFileSync(join(WS, 'BUGS.md'), join(ROOT, `orchestration/bugs/${task}.md`)); }
result.accepted = true;
finish();

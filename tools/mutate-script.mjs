#!/usr/bin/env node
// Generic mutation score for one Code-node script and the test file that covers it.
//   node tools/mutate-script.mjs <script.js> <test.mjs> [--max 40]
// Applies small operator mutations (>= to >, === to !==, && to ||, true to false ...)
// one at a time; a mutant is "killed" if the tests fail. Mutants that do not
// parse are skipped. Prints the kill ratio; exit 1 if below --min (default 0.5).
// The original file is always restored.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntaxCheck } from './lib/code.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [script, testFile] = process.argv.slice(2, 4);
const flag = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const MAX = flag('--max', 40);
const MIN = flag('--min', 0.5);
if (!script || !testFile) { console.error('usage: mutate-script.mjs <script.js> <test.mjs>'); process.exit(2); }

const file = join(ROOT, 'n8n', 'code', script);
const original = readFileSync(file, 'utf8');
const OPS = [[' >= ', ' > '], [' <= ', ' < '], [' > ', ' >= '], [' < ', ' <= '], [' === ', ' !== '], [' !== ', ' === '], [' && ', ' || '], [' || ', ' && '], [/\btrue\b/, 'false'], [/\bfalse\b/, 'true'], [' + ', ' - '], [/\? \?\? /, '?? ']];

// Candidate positions on non-comment lines.
const lines = original.split('\n');
const offsets = [];
let pos = 0;
for (const l of lines) { offsets.push(pos); pos += l.length + 1; }
const mutants = [];
lines.forEach((line, li) => {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
  for (const [from, to] of OPS) {
    const re = from instanceof RegExp ? new RegExp(from.source, 'g') : new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    let m;
    while ((m = re.exec(line))) {
      const at = offsets[li] + m.index;
      mutants.push({ at, len: m[0].length, to: from instanceof RegExp ? to : to, line: li + 1, desc: `${m[0].trim()} -> ${to.trim()}` });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
});
// deterministic sample
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
for (let i = mutants.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [mutants[i], mutants[j]] = [mutants[j], mutants[i]]; }

const run = () => spawnSync(process.execPath, ['--test', testFile], { cwd: ROOT, encoding: 'utf8', timeout: 90000 });
const restore = () => writeFileSync(file, original);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('exit', restore);

const base = run();
if (base.status !== 0) { console.log(`baseline FAILS for ${testFile}; fix the tests first`); process.exit(1); }

let tried = 0; let killed = 0; const survivors = [];
for (const m of mutants) {
  if (tried >= MAX) break;
  const mutated = original.slice(0, m.at) + m.to + original.slice(m.at + m.len);
  if (syntaxCheck(mutated, script)) continue;
  writeFileSync(file, mutated);
  tried++;
  if (run().status !== 0) killed++; else survivors.push(`line ${m.line}: ${m.desc}`);
}
restore();
const ratio = tried ? killed / tried : 1;
console.log(`${script}: ${killed}/${tried} mutants killed (${(ratio * 100).toFixed(0)}%)${survivors.length ? `\n  survivors: ${survivors.slice(0, 8).join('; ')}` : ''}`);
process.exit(ratio >= MIN ? 0 : 1);

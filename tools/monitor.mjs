#!/usr/bin/env node
// Obsidian Logs: live, per-second stream of the free-model agent team.
//   node tools/monitor.mjs [runsDir] [--port 8787]      then open http://127.0.0.1:8787
// Server-Sent Events: new log lines are pushed every 500 ms, task state every 2 s.
// /snapshot renders the same UI once, without an open stream (for screenshots).
// Local only (127.0.0.1). UI is tools/monitor-ui.html.
import http from 'node:http';
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const PORT = pi >= 0 ? Number(args[pi + 1]) : 8787;
const RUNS = args.find((a, i) => !a.startsWith('--') && i !== pi + 1) ?? join(ROOT, '..', 'aqos-agent-runs');
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const json = (f, d) => { try { return JSON.parse(read(f)); } catch { return d; } };
const specs = () => json(join(ROOT, 'orchestration/tasks.json'), {});
const superseded = () => json(join(ROOT, 'orchestration/superseded.json'), {});

function taskState(id, spec, plog) {
  const dir = join(RUNS, id);
  const attempts = plog.filter((l) => l.includes(`${id} attempt`)).map((l) => ({ at: l.slice(1, 9), model: (l.match(/model (\S+)/) ?? [])[1] }));
  const accept = json(join(dir, 'accept.json'), null);
  const gaveUp = plog.some((l) => l.includes(`${id} GAVE UP`));
  const wlog = read(join(dir, 'log'));
  const ended = /exit=\d+\s*$/.test(wlog.trim());
  const files = (spec?.deliverables ?? []).map((d) => { const p = join(dir, 'ws', d); return { name: d, size: existsSync(p) ? statSync(p).size : null }; });
  let state = 'waiting';
  if (accept?.accepted) state = 'accepted';
  else if (gaveUp) state = 'gave up';
  else if (attempts.length) state = ended && accept ? 'retrying' : 'running';
  return { id, state, attempts, files, minTests: spec?.minTests ?? 0,
    accept: accept && { accepted: accept.accepted, reasons: accept.reasons, tests: accept.details?.tests, pass: accept.details?.pass, mutation: accept.details?.mutation ?? [] } };
}
function snapshot() {
  const plog = strip(read(join(RUNS, 'pipeline.log'))).split('\n').filter(Boolean);
  const sp = specs();
  const sup = superseded();
  const tasks = Object.entries(sp).map(([id, s]) => taskState(id, s, plog));
  const archived = Object.entries(sup).map(([id, by]) => ({ id, state: 'gave up', replacedBy: by, resolved: by.every((b) => tasks.find((t) => t.id === b)?.state === 'accepted') }));
  return { now: Date.now(), tasks, archived, pipelineFinished: plog.some((l) => l.includes('pipeline finished')) };
}

// Incremental tailer per connection.
class Tail {
  constructor(file, backlog) { this.file = file; this.pos = null; this.buf = ''; this.backlog = backlog; }
  poll() {
    if (!existsSync(this.file)) return [];
    const size = statSync(this.file).size;
    if (this.pos === null) this.pos = Math.max(0, size - this.backlog);
    if (size < this.pos) this.pos = 0;
    if (size === this.pos) return [];
    const fd = openSync(this.file, 'r');
    const len = Math.min(size - this.pos, 256 * 1024);
    const b = Buffer.alloc(len);
    readSync(fd, b, 0, len, this.pos);
    closeSync(fd);
    this.pos += len;
    this.buf += b.toString('utf8');
    const parts = this.buf.split('\n');
    this.buf = parts.pop();
    return parts.map(strip).filter((l) => l.trim());
  }
}

const ui = () => readFileSync(join(ROOT, 'tools', 'monitor-ui.html'), 'utf8');
http.createServer((req, res) => {
  if (req.url.startsWith('/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const ids = [...Object.keys(specs()), ...Object.keys(superseded())];
    const tails = [['pipeline', new Tail(join(RUNS, 'pipeline.log'), 3000)], ...ids.map((id) => [id, new Tail(join(RUNS, id, 'log'), 2500)])];
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    send('state', snapshot());
    const t1 = setInterval(() => { try { for (const [id, t] of tails) { const ls = t.poll(); if (ls.length) send('lines', { task: id, lines: ls.slice(-200) }); } } catch (e) { send('err', String(e)); } }, 500);
    const t2 = setInterval(() => { try { send('state', snapshot()); } catch (e) { send('err', String(e)); } }, 2000);
    const t3 = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); });
    return;
  }
  if (req.url.startsWith('/snapshot')) {
    const ids = [...Object.keys(specs()), ...Object.keys(superseded())];
    const files = [['pipeline', join(RUNS, 'pipeline.log')], ...ids.map((id) => [id, join(RUNS, id, 'log')])];
    const lines = files.map(([task, f]) => ({ task, lines: strip(read(f)).split('\n').filter((l) => l.trim()).slice(-14) }));
    const data = JSON.stringify({ state: snapshot(), lines }).replace(/</g, '\\x3c');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(ui().replace('<script>', () => `<script>window.__SNAP__=${data};`));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(ui());
}).listen(PORT, '127.0.0.1', () => console.log(`Obsidian Logs: http://127.0.0.1:${PORT}  (runs: ${RUNS})`));

// Runs an n8n Code-node script (mode: "Run Once for All Items") the way n8n
// does, so scripts can be unit-tested without an n8n instance.
//
//   const out = await runCodeNode('wf04-pretrade-checks.js', {
//     input: [{ ...json }],                       // items for $input
//     nodes: { 'Load risk context': [{ ctx }] },  // items per $('Node name')
//     execution: { id: '1', resumeUrl: 'http://n8n/webhook-waiting/1' },
//     now: '2026-10-02T12:00:00Z',                // frozen clock (Date + $now)
//     seed: 42,                                   // deterministic Math.random
//   });
//   // out is the array of item objects returned by the script, as plain
//   // JSON ({ json: {...} }), after the same shape checks n8n applies.
//
// Behaviours that match n8n and catch real bugs:
//  * $('X') throws if node X is not in ctx.nodes (n8n: "hasn't been executed")
//  * .first() / .last() on an empty node returns undefined (so .json throws)
//  * the return value must be an array of objects with a "json" object
//  * there is no require, process, fetch, or timers inside the script
import vm from 'node:vm';
import { readScript, inlineIncludes } from './code.mjs';

const wrap = (items) => (items ?? []).map((i) => (i && typeof i === 'object' && 'json' in i ? i : { json: i }));

function seededRandom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

class ItemSet {
  constructor(items, name, executed = true) {
    this._items = items;
    this._name = name;
    this.isExecuted = executed;
  }
  all() { return this._items.map((i) => ({ ...i })); }
  first() { return this._items[0]; }
  last() { return this._items[this._items.length - 1]; }
  get item() { return this._items[0]; }
  get json() { return this._items[0]?.json; }
}

export async function runCodeNode(scriptOrFile, ctx = {}) {
  const code = /\.m?js$/.test(scriptOrFile) && !scriptOrFile.includes('\n') ? readScript(scriptOrFile) : inlineIncludes(scriptOrFile);
  const nowMs = ctx.now ? Date.parse(ctx.now) : Date.now();
  const rand = ctx.seed !== undefined ? seededRandom(ctx.seed) : Math.random;
  const input = wrap(ctx.input);
  const nodes = Object.fromEntries(Object.entries(ctx.nodes ?? {}).map(([k, v]) => [k, new ItemSet(wrap(v), k)]));

  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Node '${name}' hasn't been executed (add it to ctx.nodes)`);
    return nodes[name];
  };
  const $input = new ItemSet(input, '$input');

  const FakeDate = class extends Date {
    constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
    static now() { return nowMs; }
  };
  const FakeMath = Object.create(Math);
  FakeMath.random = rand;

  const sandbox = {
    $, $input,
    $json: input[0]?.json,
    $execution: { id: '1', mode: 'production', resumeUrl: 'http://n8n.local/webhook-waiting/1', ...(ctx.execution ?? {}) },
    $workflow: { id: 'TESTWF', name: 'test', active: true, ...(ctx.workflow ?? {}) },
    $runIndex: ctx.runIndex ?? 0,
    $now: { toISO: () => new Date(nowMs).toISOString(), toMillis: () => nowMs },
    $env: ctx.env ?? {},
    Date: FakeDate,
    Math: FakeMath,
    console: { log() {}, warn() {}, error() {} },
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(`(async function(){${code}\n})()`, { filename: String(scriptOrFile).slice(0, 80) });
  const result = await script.runInContext(context, { timeout: ctx.timeoutMs ?? 5000 });

  if (!Array.isArray(result)) throw new Error("Code doesn't return items properly: expected an array of { json } objects");
  for (const [i, it] of result.entries()) {
    if (!it || typeof it !== 'object' || typeof it.json !== 'object' || it.json === null || Array.isArray(it.json)) {
      throw new Error(`Code doesn't return items properly: item ${i} must be an object with a "json" object`);
    }
  }
  // Re-materialise in this realm (also proves the output is JSON-serialisable).
  return JSON.parse(JSON.stringify(result));
}

// Convenience: first item's json.
export async function runFirst(scriptOrFile, ctx) {
  const out = await runCodeNode(scriptOrFile, ctx);
  return out[0]?.json;
}

# Worker rules (read first)

You are a worker agent. An automatic gate checks your output; if it fails you are re-run from scratch, so get it right the first time.

## Boundaries
- Work only inside this directory. No network, no package installs, do not print environment variables.
- Create or edit ONLY the files listed under **Deliverables** in `TASK.md` (and `BUGS.md`). Any other change gets the whole run rejected. Never edit `n8n/`, `db/`, `tools/lib/`, `package.json` or existing tests.
- Do not read `n8n/workflows/`, `db/schema.sql` or the lock files. They are large and not needed. Read only the files `TASK.md` names, plus the style reference below.
- No destructive commands.

## How the gate judges test files
1. All tests pass (`node --test <file>`), no external dependencies, no network.
2. The test count meets the minimum in `TASK.md`.
3. Mutation check: the gate breaks the scripts under test in small ways (`>=` to `>`, `&&` to `||`, `true` to `false` ...) and at least half of those mutants must make your tests fail. So assert exact values and every branch, not just that something returned. Tautologies (`assert.ok(true)`, checking only types) lower your score.
4. If a script seems to have a bug, keep the test asserting the CORRECT behaviour, mark it `{ todo: 'BUG-n: reason' }`, and describe it in `BUGS.md` (file, input, expected, actual). Never weaken a test to make it pass. Few `todo` allowed.

## Style reference (read first)
- `tools/tests/critical-scripts.test.mjs` shows exactly how to run a Code-node script with the sandbox and what good assertions look like. Copy its patterns.
- `tools/lib/sandbox.mjs`: `runFirst(file, { input, nodes, now, seed, runIndex })` returns the first output item's json; `runCodeNode` returns all items. `nodes` must provide every `$('Node name')` the script reads, or it throws (as n8n does). `input` items become `$input`.
- Node 20+ ESM `.mjs`, `node:test`, `node:assert/strict`, plain-sentence test names.

## Process
1. Read `TASK.md`, then the style reference, then each script you must test (each starts with a comment describing intended behaviour).
2. Write the deliverable in one go. Run the acceptance command; fix YOUR mistakes; repeat until it passes.
3. Finish with a 5-line report: files, test count, bugs found, assumptions.

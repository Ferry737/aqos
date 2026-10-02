# Handoff

State at 2 October 2026, for the next engineer or agent. Read [blueprint.md](blueprint.md) first, then this.

## What is done and verified

`npm run verify` is green: 17 workflows (285 nodes) valid against the n8n 2.41.4 catalog, 74 database tests, 379 logic tests covering all 61 scripts. Mutation checks confirm the tests fail when safety rules are removed (`node tools/mutation-check.mjs`).

## What is not done

1. **No workflow has run in a live n8n.** First task: bring up `deploy/docker-compose.yml`, import credentials and workflows, point the custom-service hostnames at stubs, and execute each workflow. Likeliest first-run surprises: `$('Node')` references across loops (WF-12 uses `.item` pairing), Postgres `queryReplacement` receiving one JSON string, the Wait-node approval link in WF-08, the Switch/IF output wiring on import.
2. **Custom services are unbuilt:** see `docs/feasibility.json` (13 endpoints). The request and response shapes are in the Code-node scripts and `db/schema.sql` comments; write them as OpenAPI first.
3. **No strategies are implemented or backtested.** The blueprint names the models and the validation protocol; nothing has been trained. Do not publish any performance figure.
4. **Open business inputs:** budget, team, timeline, jurisdictions, price points (strategy document, D1 to D4).
5. **Service contracts and stubs exist, services do not.** `docs/openapi/*.json` and `tools/stub-services.mjs` (with `deploy/docker-compose.stubs.yml`) let the workflows be dry-run end to end. The contracts and the stub were written by free-model agents and checked structurally and against the consuming scripts; a human should still review them before building the real services.

## Design decisions worth knowing

- **The database enforces safety, not the workflows.** Orders need a single-use risk token (`oms.submit_parent_orders`); modes only escalate (`risk.apply_mode`); the audit log is hash-chained. A buggy workflow cannot bypass these.
- **n8n's Redis `get` drops the incoming item's fields.** Scripts that need earlier data read it with an explicit `$('Node name')`. The validator checks every such reference is a real, upstream node.
- **Postgres nodes call one function with one `jsonb` argument.** SQL never contains expressions; the validator rejects any that do.
- **No `$env` in workflows.** Deployment values are build-time tokens (`@@NAME@@`) from `deploy/config.json`.
- **Opus 5.5 cannot disable thinking or force a tool.** The LLM nodes use adaptive thinking and structured outputs; refusals and bad JSON fall back to deterministic text.
- **Workflow ids are fixed** (16 characters) so Execute Workflow links survive import.
- The `limits` in `db/seed_example.sql` are placeholders. Do not load them in production.

## Free-model agent team (what actually worked on this machine, 2 October 2026)

Dispatcher: `orchestration/dispatch.sh <task> <agent>`. Each task runs in an isolated copy of the repo; the orchestrator reviews and re-runs before accepting. A worker may never edit the scripts under test.

| Route | Result |
|---|---|
| Kilo Code CLI (`kilo run --auto -m kilo/kilo-auto/free`) | Works with no account (Kilo gateway free models). Slow, explores a lot, occasionally hits an upstream idle timeout. Needs `--auto` or it stops at the first permission prompt. |
| OpenCode (`opencode-cli run --standalone --auto -m mistral/codestral-latest`) | Connects, but Codestral looped on file edits. Not reliable for multi-file work. |
| Hermes (`hermes -z ... --provider gemini -m gemini-3.8-flash`) | Works for single prompts. The Google free tier allows about 5 requests per minute, which an agent loop exceeds. |
| Hermes with Z.AI `glm-4.7-flash` | Works for single prompts; rate-limited (429) under agent load. |
| Cerebras | Key present, but every call returns HTTP 402 (billing). |
| Mistral | Key works for `codestral-latest`; the medium and vibe models return 429. |

Lesson: free tiers are fine for narrow, well-specified prompts and poor for long agent sessions. Use them for drafts and review passes, and keep correctness-critical work (the risk-gate tests, the validator) with a stronger model.

## Next actions, in order

1. Live n8n dry run with stubs (days 1 to 3). Fix whatever the first run reveals.
2. Write the OpenAPI specs for the 13 endpoints; build the EMS first, on one venue, paper mode.
3. Start the legal opinions per target jurisdiction in week 1; nothing live before they exist.
4. Calibrate and approve `risk.limits` with a named risk owner.
5. Run kill-switch and failover drills (see blueprint section 5) before any client money.
6. Extend the unit tests to every script; keep the mutation check in CI.

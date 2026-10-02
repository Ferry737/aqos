# TASK T-H: stub services for a dry run

Deliverables: `tools/stub-services.mjs`, `tools/tests/stub-services.test.mjs` (at least 18 tests), `deploy/docker-compose.stubs.yml`. Acceptance: `node --test tools/tests/stub-services.test.mjs`.

Read `CONTRACTS.md` in this directory (the contract). Build a deterministic stub of all thirteen endpoints so the n8n workflows can be dry-run without the real services.

`tools/stub-services.mjs`: Node 20+, no dependencies (`node:http`, `node:crypto`). Export `createStubServer({ token = 'stub-token' })` returning a Node `http.Server` (not yet listening), and `signEvent(secret, body)` returning `{ headers: { 'x-aqos-signature': 'sha256=<hex>', 'content-type': 'application/json' }, rawBody }` where the HMAC-SHA256 is over the exact raw body string. When run as a script, listen on `PORT` (default 8080). Route by method and path only (one server answers for all service hostnames). Rules:
- Missing or wrong `Authorization: Bearer <token>` gives 401 with the error body from CONTRACTS.md. Unknown path 404, malformed JSON 400, missing required field 422.
- Deterministic: the same request always gives the same response (seed from `cycle_id` / ids, never `Math.random` or the clock, except `job_id` derived from the request).
- `/v1/orders/batch` and `/v1/kill` are idempotent: keep an in-memory set; a second send reports `duplicates` / `duplicate: true` and creates nothing new.
- A request header `x-stub-fail: 503` makes any endpoint return 503; `x-stub-delay-ms: N` delays the response by N ms (cap 5000).

`deploy/docker-compose.stubs.yml`: one `stubs` service (image `node:22`, runs the script) with network aliases `stream-gw`, `model-svc`, `portfolio-svc`, `risk-svc`, `ems`, `ems-standby`, `data-adapter` on the same network as `deploy/docker-compose.yml`'s default network (use `name: aqos_default` as an external network reference with a comment explaining it).

Tests (start the server on port 0 per test file, use global `fetch`). Besides per-endpoint tests (shape, 401, 404, 400/422, determinism, idempotency, `x-stub-fail`, `x-stub-delay-ms`), include these **consumer-compatibility tests**, which load the real n8n scripts through `tools/lib/sandbox.mjs` (`runFirst`) and feed them the stub's responses:
1. `/v1/predict` output passes `wf03-validate-predictions.js` (`input: [response]`, node `Gate decision` = `[{ cycle_id, bar_ts, mode: 'NORMAL' }]`) with `ok === true`.
2. `/v1/propose` output passes `wf03-prepare-outputs.js` (node `Validate predictions` = `[{ cycle_id, kept: [] }]`, `input: [response]`) with at least one proposal.
3. `/v1/snapshot` output through `wf07-normalize-snapshot.js` (`input: [response]`, node `Market stress event` = `[{}]`) then `wf07-evaluate-breakers.js` (node `Normalize snapshot` = that output, `input: [{ c: { policy: {}, modes: [], monitor: { fallback_streak: 0 }, recent_fingerprints: [] } }]`) gives `severity === 'OK'`.
4. `/v1/exposure` output passes `wf14-verify-exposure.js` (node `Normalize request` = `[{ action: 'cancel_all', scope: 'global', scope_id: '*', reason: 'x', request_id: 'r' }]`) with `clean === true`.
5. `/v1/keys/inspect` output passes `wf10-key-policy.js` (node `Key connected` = `[{ body: { account_id: 'a', client_id: 'c', venue: 'binance', key_ref: 'k', email: 'e@x.y', derivatives_allowed: false } }]`) with `status === 'VERIFIED'`.
6. `/v1/headlines` output passes `wf02-split-headlines.js` (`input: [response]`) yielding items.
7. `signEvent` output passes `common-verify-signed-webhook.js`: compute the expected signature yourself with `node:crypto`, build the item `{ headers: <headers>, computed_sig: <hex>, body: <parsed body> }`, set `now` to the event `ts`; `valid === true`; and a tampered body fails.
8. `/v1/allocation/propose` output passes `wf08-bounded-change.js` (`input: [response]`) with `within_bounds === true`.

# TASK T-A: unit tests for the risk-critical Code-node scripts

## Context
AQOS runs a 24/7 crypto trading pipeline in n8n. Its business logic lives in Code-node scripts in `n8n/code/`. They have never been executed outside a smoke check, so your tests are the first real verification.

Run scripts with the sandbox that mimics n8n: read `tools/lib/sandbox.mjs` first.
- `runCodeNode(file, ctx)` returns the array of items the script returned.
- `runFirst(file, ctx)` returns `items[0].json`.
- `ctx = { input, nodes, now, seed }`. `ctx.nodes` must supply every `$('Node name')` the script references; a missing node throws, exactly as in n8n. Use `now` to freeze the clock and `seed` for deterministic `Math.random`.

Every script starts with a comment describing its intended behaviour; read it and the code. `db/schema.sql` shows the shape of the data each script receives (for example `risk.gate_context` returns the `ctx` object that `wf04-pretrade-checks.js` consumes; `risk.breaker_context` returns the `c` object that `wf07-evaluate-breakers.js` consumes).

## Deliverables (only these two files)
- `tools/tests/risk-core.test.mjs`
- `BUGS.md`

## Acceptance
```
node --test tools/tests/risk-core.test.mjs
```
Passes with exit code 0 (tests tagged `todo` may fail). At least 70 tests in total.

## Scripts under test
1. `wf04-pretrade-checks.js`, the pre-trade risk gate. Most important: at least 35 tests.
2. `wf07-evaluate-breakers.js`, circuit-breaker policy: at least 20 tests.
3. `wf04-gate-scope.js`, `wf04-collect-escalations.js`
4. `wf05-prepare-dispatch.js`, `wf05-ems-batch.js`, `wf05-breaker.js`
5. `wf06-break-policy.js`, `wf06-notable-events.js`
6. `wf07-normalize-snapshot.js`, `wf07-plan-followups.js`, `wf07-dedupe-alert.js`
7. `common-fan-out-kills.js`

## Required scenarios: wf04-pretrade-checks.js
Build one small fixture factory (a valid `ctx`, a valid proposal) and vary one thing per test.
1. A small order inside every limit is APPROVE with `approved_qty` equal to the requested qty.
2. Trading modes: global/venue/strategy/account HALT rejects with reason `trading_mode`; an unknown mode string such as `WEIRD` fails closed (rejects); the worst mode wins; the Redis fast flag (third node `Global mode (fast flag)`) is honoured.
3. REDUCE_ONLY: an order that opens or increases a position is rejected; an order that reduces is allowed and capped to the absolute position; flipping through zero is capped at the position size.
4. `billing_status` not ACTIVE behaves at least like REDUCE_ONLY; `key_status` not VERIFIED is HALT.
5. Market data: stale mark (age above `max_mark_age_s`) rejects; missing mark rejects.
6. Price collar: a `limit_px` too far from the mark rejects; one inside the collar passes; a proposal without `limit_px` skips the collar.
7. Sizing caps shrink to the exact cap quantity (RESIZE): `max_order_notional` (global and account, the smaller wins), `max_position_pct_equity`, `max_gross_leverage`, `venue_caps_usd`, `max_net_leverage` (single-leg orders only).
8. In-flight orders in `account.pending` count as already filled when checking exposure.
9. Batch accumulation: ten identical proposals for one account never approve more total exposure than the single headroom (assert the sum, not just each decision).
10. Strategy capacity is shared pro-rata: two accounts competing for limited `strategies[x].max_gross_usd` headroom receive the same fraction of their request (within 1e-9). A strategy missing from `ctx.strategies` has zero capacity for exposure-increasing orders.
11. Pairs: if one leg of a `pair_id` is rejected, both are rejected; if one leg is shrunk, both legs keep the same fill ratio; a single-leg pair is rejected as `pair_incomplete`.
12. Escalations: daily loss at or beyond `daily_loss_limit_pct` emits a REDUCE_ONLY mode escalation; drawdown at or beyond `max_drawdown_pct` emits a HALT mode escalation plus a kill escalation (`flatten` if `auto_flatten_on_max_dd` is true, otherwise `cancel_all`).
13. Mandate: symbol not in `allowed_symbols` rejects; strategy not in `allowed_strategies` rejects; a restricted symbol allows exits only.
14. Order-rate throttle: `orders_last_min` plus the batch count above `max_orders_per_min_per_account` rejects.
15. Malformed proposals (missing ids, `qty <= 0`, bad side, unknown account) reject with an explanatory reason and never throw.
16. Output shape: every decision has `proposal_id`, `decision`, `approved_qty`, `reasons`, `checks`, `limits_version`, `state_version`; `stats` counts match.
17. Property tests with a seeded PRNG (write a tiny mulberry32 in the test file), at least 300 random batches over random contexts and proposals, asserting for every decision: `0 <= approved_qty <= requested_qty`; REJECT implies `approved_qty === 0`; APPROVE implies equality with the request; a global HALT yields only REJECT; for an account in REDUCE_ONLY, no approved order increases absolute exposure; the script is deterministic for identical input.

## Required scenarios: wf07-evaluate-breakers.js
VaR utilisation: warn band yields WARN only; at or above the reduce threshold yields a global REDUCE_ONLY. ES at or above the halt threshold yields global HALT plus a `cancel_all` kill. Stablecoin depeg: reduce and halt thresholds. Venue DOWN gives venue HALT; withdrawals suspended gives venue REDUCE_ONLY. Account drawdown gives HALT (+ `flatten` when `auto_flatten_on_max_dd`); account daily loss gives REDUCE_ONLY. Liquidation distance in sigmas: reduce and flatten thresholds. Stale marks above the limit gives REDUCE_ONLY. A long `db_fallback` streak gives REDUCE_ONLY (risk unmeasurable). Dedupe: an action that would not change state (current mode already equal or stricter) is dropped; a kill whose fingerprint is in `recent_fingerprints` is not re-issued; severity is OK, WARN or ACT as appropriate; each kill has a `request_id`.

## Required scenarios: the other scripts
For each remaining script: a normal case, an empty-input case, a malformed-input case, and every branch that the script's header comment names (for example `wf05-prepare-dispatch.js`: global HALT, REDUCE_ONLY with a non-reduce-only decision, circuit breaker OPEN, and the algorithm choice by urgency and notional; `wf05-breaker.js`: opens at 3 failures; `wf06-break-policy.js`: only an unexplained HIGH break triggers REDUCE_ONLY, external activity never does).

## Report
List any script bug as `BUG-n` in `BUGS.md` and tag the failing test `{ todo: 'BUG-n: ...' }`.

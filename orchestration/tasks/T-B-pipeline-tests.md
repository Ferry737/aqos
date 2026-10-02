# TASK T-B: unit tests for the supervisor, ingestion, alt-data and signal-cycle scripts

## Context
AQOS runs a 24/7 crypto trading pipeline in n8n. Its business logic lives in Code-node scripts in `n8n/code/`. They have never been executed outside a smoke check, so your tests are the first real verification.

Run scripts with the sandbox that mimics n8n: read `tools/lib/sandbox.mjs` first.
- `runCodeNode(file, ctx)` returns the array of items the script returned.
- `runFirst(file, ctx)` returns `items[0].json`.
- `ctx = { input, nodes, now, seed }`. `ctx.nodes` must supply every `$('Node name')` the script references; a missing node throws, exactly as in n8n. Use `now` to freeze the clock and `seed` for deterministic `Math.random`.

Every script starts with a comment describing its intended behaviour; read it and the code. `db/schema.sql` shows the shape of the data each script receives. Some scripts include `common-claude.js` (a helper that builds and parses Claude API requests); the sandbox inlines it.

## Deliverables (only these two files)
- `tools/tests/pipeline.test.mjs`
- `BUGS.md`

## Acceptance
```
node --test tools/tests/pipeline.test.mjs
```
Passes with exit code 0 (tests tagged `todo` may fail). At least 70 tests in total.

## Scripts under test
Supervisor (WF-00): `wf00-service-registry.js`, `wf00-evaluate-state.js`, `wf00-detect-change.js`
Ingestion (WF-01): `common-verify-signed-webhook.js`, `wf01-feed-rules.js`, `wf01-dq-triage-request.js`, `wf01-dq-triage-result.js`
Alt data (WF-02): `wf02-funding-sources.js`, `wf02-normalize-funding.js`, `wf02-split-headlines.js`, `wf02-batch-headlines.js`, `wf02-sentiment-request.js`, `wf02-sentiment-result.js`
Signal cycle (WF-03): `wf03-cycle-context.js`, `wf03-gate-decision.js`, `wf03-validate-predictions.js`, `wf03-prepare-outputs.js`, `wf03-fan-out.js`, `wf03-cycle-summary.js`

## Required scenarios
- `common-verify-signed-webhook.js`: the script receives items with `headers`, `body` and `computed_sig`. Valid signature passes; wrong signature, missing header, different length, uppercase hex (accepted) and a `sha256=` prefix (accepted) behave as the code implies; a body `ts` older or newer than 30 s is rejected; a body missing `event_id` or `type` is rejected; `envelope` is null when invalid.
- `wf00-evaluate-state.js`: all healthy gives `dq_status` OK and severity OK; stream gateway down gives SEV1 and `dq_status` DEGRADED; stale critical bars, stale marks and quarantined critical feeds give DEGRADED; risk monitor heartbeat missing or older than 90 s gives SEV1 and `escalate_to` REDUCE_ONLY only when the current mode is NORMAL; EMS primary down with standby up gives SEV2, both down gives SEV1; unconfirmed orders give SEV1; fingerprint is stable across component ordering. The script takes the more severe of the Redis flag and the database mode (`global_mode`).
- `wf00-detect-change.js`: alerts only on fingerprint change; a recovery after a problem notifies once; first-ever OK does not notify.
- `wf01-feed-rules.js`: checksum mismatch and crossed book quarantine; stale beyond the threshold quarantines (critical 60 s, others 300 s); an isolated outlier (MAD z above 8 with no other venue agreeing) quarantines; a gap triggers backfill unless already backfilled; `recovered` only logs; `triage` true for any action or a critical feed.
- `wf01-dq-triage-request.js` and `wf01-dq-triage-result.js`: the request has model `claude-opus-5-5`, `fallbacks: 'default'`, `output_config.format.type === 'json_schema'`, and every object in the schema has `additionalProperties: false` and lists all its properties in `required`; the result handles a good response, a refusal (`stop_reason: 'refusal'`), `max_tokens`, an HTTP error, and invalid JSON, always producing a usable incident with `text`; a backfill is requested only when repairable.
- `wf02-normalize-funding.js`: Binance and Bybit shapes map to rows; symbols outside the universe, implausible funding (absolute value of 5% or more), missing marks and invalid timestamps are dropped and counted; a failing venue is reported in `errors` without blocking the other.
- `wf02-split-headlines.js`, `wf02-batch-headlines.js`: trimming, 200-item cap, empty titles dropped, `hash_input` format.
- `wf02-sentiment-request.js` and `wf02-sentiment-result.js`: schema checks as above; the result drops unknown hashes and assets, de-duplicates, clips scores to [-1, 1] and relevance to [0, 1], and returns no scores on any failure.
- `wf03-cycle-context.js`: the same 5-minute bar from an event and from the schedule yields the same `cycle_id`; timestamps are floored to the bar; an invalid `bar_ts` throws.
- `wf03-gate-decision.js`: routes `duplicate` when not claimed, `skip` for data quality not OK or global HALT, otherwise `proceed`; a missing data-quality key is not OK.
- `wf03-validate-predictions.js`: stale `as_of`, non-finite mu, non-positive sigma, `mu` beyond 5 sigma, `p_up` out of range, unregistered model; more than 20% rejected fails the whole set; an empty set fails.
- `wf03-prepare-outputs.js`: deterministic `proposal_id`, invalid proposals dropped and counted. `wf03-fan-out.js`: all proposals preserved and, with a fixed seed, the order is deterministic and differs across seeds. `wf03-cycle-summary.js`: notify rules.
- Include a few property tests with a seeded PRNG where natural (for example: for any shuffle seed, `wf03-fan-out.js` returns a permutation).

## Report
List any script bug as `BUG-n` in `BUGS.md` and tag the failing test `{ todo: 'BUG-n: ...' }`.

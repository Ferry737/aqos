# TASK T-F: tests for portfolio, research and report-request scripts

Deliverable: `tools/tests/portfolio-research.test.mjs` (at least 30 tests). Acceptance: `node --test tools/tests/portfolio-research.test.mjs`.

Scripts in `n8n/code/` (read each header comment):
- `wf08-rebalance-request.js`: items with `account_id, max_abs_drift, drifted` become one request; drift is numeric; empty input still yields a request with no accounts.
- `wf08-prepare-proposals.js` (input item `{ proposals: [...] }`): `proposal_id` is deterministic for a given hour bucket (use `now`) and changes with the hour; invalid proposals (missing ids, bad side, qty <= 0) are dropped; sides upper-cased; defaults (`order_type` LIMIT, `urgency` low, `source` rebalance); with a fixed `seed` the order is deterministic and all valid proposals are kept; a non-array `proposals` yields no items.
- `wf08-review-request.js`: request model `claude-opus-5-5`, `fallbacks: 'default'`, json_schema format with `additionalProperties: false` on every object and all properties required.
- `wf08-decide-path.js` (needs node `Bounded-change policy`; input is a Claude response): within bounds and no review recommendation gives `apply`; recommendation to review gives `stage`; out of bounds gives `stage` even if the agent is happy; refusal / HTTP error / invalid JSON falls back to the policy alone (`review_error` set, `rationale` mentions the policy).
- `wf08-approval-message.js` (needs nodes `Approval token`, `Decide path`, `Stage allocation`; provide `execution: { resumeUrl: 'http://n8n/wait/1' }`): both links contain the resume URL, `decision=approve`/`reject`, the version and the token; only moves with non-zero delta are listed; the violation text appears when staged for policy reasons.
- `wf09-research-prompt.js`: valid JSON string in `research_input` containing the brief and four tasks. `wf09-digest.js` (needs node `Research Agent` with `output`): normal memo, missing fields, empty arrays print "- none", at most 6 items per list, text capped at 3900 characters, `severity` INFO.
- `wf12-narrative-request.js`: one request per input item, metrics passed through, model and schema checks as above. `wf12-run-summary.js`: counts rendered.

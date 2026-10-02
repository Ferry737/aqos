# TASK T-C: unit tests for the portfolio, research, onboarding, billing, reporting, error and alert scripts

## Context
AQOS runs a 24/7 crypto trading pipeline in n8n. Its business logic lives in Code-node scripts in `n8n/code/`. They have never been executed outside a smoke check, so your tests are the first real verification.

Run scripts with the sandbox that mimics n8n: read `tools/lib/sandbox.mjs` first.
- `runCodeNode(file, ctx)` returns the array of items the script returned.
- `runFirst(file, ctx)` returns `items[0].json`.
- `ctx = { input, nodes, now, seed, execution }`. `ctx.nodes` must supply every `$('Node name')` the script references; a missing node throws, exactly as in n8n. Use `now` to freeze the clock and `seed` for deterministic `Math.random`.

Every script starts with a comment describing its intended behaviour; read it and the code. `db/schema.sql` shows the shape of the data each script receives. Some scripts include `common-claude.js` (a helper that builds and parses Claude API requests); the sandbox inlines it.

## Deliverables (only these two files)
- `tools/tests/business.test.mjs`
- `BUGS.md`

## Acceptance
```
node --test tools/tests/business.test.mjs
```
Passes with exit code 0 (tests tagged `todo` may fail). At least 80 tests in total.

## Scripts under test
Portfolio (WF-08): `wf08-rebalance-request.js`, `wf08-prepare-proposals.js`, `wf08-bounded-change.js`, `wf08-review-request.js`, `wf08-decide-path.js`, `wf08-approval-message.js`, `wf08-approval-result.js`
Research (WF-09): `wf09-research-prompt.js`, `wf09-digest.js`
Onboarding (WF-10): `wf10-validate-signup.js`, `wf10-screening-outcome.js`, `wf10-key-policy.js`
Billing (WF-11): `wf11-normalize-stripe.js`, `wf11-billing-message.js`, `wf11-fee-burden-message.js`
Reports (WF-12): `wf12-narrative-request.js`, `wf12-compliance-gate.js`, `wf12-render-email.js`, `wf12-run-summary.js`
Errors (WF-13): `wf13-classify-error.js`, `wf13-severity-policy.js`
Kill switch (WF-14): `wf14-normalize-request.js`, `wf14-four-eyes.js`, `wf14-verify-exposure.js`, `wf14-retry-budget.js`
Risk analyst (WF-15): `wf15-analyst-prompt.js`, `wf15-format-analysis.js`
Alert routing (WF-16): `wf16-route-alert.js`

## Required scenarios
- `wf08-bounded-change.js`: weights summing to 1 within 5 percentage points per strategy and 15% turnover are within bounds; one strategy moving 6 points, turnover of 16%, weights not summing to 1, negative weights and an empty proposal each produce the specific violation.
- `wf08-decide-path.js`: `apply` only when within bounds and the agent did not ask for human review; a refusal or error from the agent falls back to the policy alone; the agent can add caution but never remove it. `wf08-approval-message.js` and `wf08-approval-result.js`: message contains approve and reject links with the token, version and `resumeUrl`; a timeout (no `decision` in the query) is recorded as `timeout` and never as approval.
- `wf10-validate-signup.js`: valid signup; invalid email; missing consent documents; blocked jurisdiction; scoring edge cases; `CONSERVATIVE` when the client cannot bear total loss; derivatives disabled for restricted countries and for conservative profiles; consents are filtered to the required document types.
- `wf10-screening-outcome.js`: CLEAR gives ACTIVE, REVIEW gives PENDING_REVIEW, HIT gives BLOCKED, an error maps to PENDING_REVIEW. `wf10-key-policy.js`: each rejection reason (withdraw enabled, transfer enabled, no IP allowlist, no trade permission, futures not allowed, permission check failed) and the verified case; instructions are client-readable.
- `wf11-normalize-stripe.js`: invoice, subscription and checkout shapes. `wf11-billing-message.js`: each status has a message that promises no liquidation and contains the non-advice sentence; duplicates and unmatched events produce no message. `wf11-fee-burden-message.js`: values are formatted.
- `wf12-compliance-gate.js` is the most important script here (at least 25 tests). It must reject: each banned phrase family (guarantee, risk-free, "will earn", "you should buy/sell/hold", "we recommend", "passive income", "to the moon"), a number that appears nowhere in the metrics (hallucinated), a link, a draft over 1200 characters, a subject over 90 characters, and a failed LLM call. It must accept a clean draft whose numbers all come from the metrics (including percent forms of fractions, rounding to two decimals, and small integers). Include adversarial cases: mixed case, hyphen and spacing variants ("risk free", "Risk-Free"), the number hidden in highlights or `risk_notes`, and a negation such as "no guarantee" (document the actual behaviour).
- `wf12-render-email.js`: escapes HTML in all model-supplied fields (try `<script>` and quotes), always includes the disclosure sentence, falls back to the template narrative when compliance failed, and builds the subject safely. `wf12-run-summary.js`: counts.
- `wf13-classify-error.js`: transient versus permanent messages, criticality by workflow id, fingerprints normalise uuids and numbers. `wf13-severity-policy.js`: critical and transient escalates only on repetition; `fail_safe_reduce_only` only for SEV1 in the capital-guarding workflows.
- `wf14-normalize-request.js`: webhook versus sub-workflow input, idempotent `request_id` bucketed per minute, validation (reset needs approvers, non-global scope needs `scope_id`). `wf14-four-eyes.js`: needs two distinct approvers. `wf14-verify-exposure.js`: clean only when no open orders and (for flatten) residual below dust. `wf14-retry-budget.js`: three attempts then stop.
- `wf16-route-alert.js`: severity mapping including ACT, WARN and unknown values, text truncation, default dedup key.
- Remaining scripts: a normal case, an empty-input case and a malformed-input case each.

## Report
List any script bug as `BUG-n` in `BUGS.md` and tag the failing test `{ todo: 'BUG-n: ...' }`.

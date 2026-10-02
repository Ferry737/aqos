# TASK T-E1: tests for onboarding scripts

Keep the file compact: plain, short tests; one small fixture helper at most. Aim for the minimum test count plus a few boundary cases, no more.

Deliverable: `tools/tests/onboarding.test.mjs` (at least 22 tests). Acceptance: `node --test tools/tests/onboarding.test.mjs`.

Scripts in `n8n/code/` (read each header comment):
- `wf10-validate-signup.js` (input item `{ body: {...signup} }`): valid signup; invalid email; invalid jurisdiction format; each missing required consent (terms, risk_disclosure, privacy, non_advice_ack, fee_schedule) and a bad `doc_sha256`; blocked country (KP, IR, CU) sets `blocked`; appropriateness scoring boundaries (experience none/lt1/1to3/gt3, quiz 0..8 clamp, `quiz_correct >= 6` passes, `can_bear_total_loss`); risk profile CONSERVATIVE when the client cannot bear total loss, BALANCED at score >= 55, DYNAMIC at >= 75 with `share_of_liquid_net_worth_pct <= 25`; `derivatives_allowed` false for GB and US and for CONSERVATIVE; consents filtered to the required types and hashes lower-cased; email lower-cased.
- `wf10-screening-outcome.js` (needs node `Validate signup`): CLEAR to ACTIVE, REVIEW to PENDING_REVIEW, HIT to BLOCKED, unknown or error to PENDING_REVIEW; `create.screening` content; route equals status.
- `wf10-key-policy.js` (needs node `Key connected` with `body`): VERIFIED needs `can_trade: true`, `can_withdraw: false`, no transfer, `ip_restricted: true`; each failure reason separately (withdrawals enabled, transfers enabled, no IP allowlist, no trade permission, futures enabled while `derivatives_allowed` is not true, `perm.error`), several together, and that `instructions` has one client-readable line per reason.

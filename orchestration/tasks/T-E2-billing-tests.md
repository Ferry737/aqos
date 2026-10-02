# TASK T-E2: tests for billing scripts

Keep the file compact: plain, short tests; one small fixture helper at most. Aim for the minimum test count plus a few boundary cases, no more.

Deliverable: `tools/tests/billing.test.mjs` (at least 15 tests). Acceptance: `node --test tools/tests/billing.test.mjs`.

Scripts in `n8n/code/` (read each header comment):
- `wf11-normalize-stripe.js`: invoice, subscription (status) and checkout shapes; monthly fee only for USD monthly prices (`unit_amount` in cents); missing price gives null fee; `client_ref` from `client_reference_id` or metadata.
- `wf11-billing-message.js` (needs node `Apply billing event`; input item has `email`): each status PAST_DUE, PAUSED_BILLING, CANCELED, ACTIVE returns a message containing the sentence "not investment advice"; PAST_DUE/PAUSED/CANCELED messages must say positions are not liquidated ("not liquidated" or "have not closed"); duplicate, unmatched, ignored or missing client id returns no message; missing email returns no message.
- `wf11-fee-burden-message.js`: one message per row; percentage and USD formatting; non-advice sentence present.

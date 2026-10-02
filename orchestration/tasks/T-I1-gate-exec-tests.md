# TASK T-I1: gate and execution plumbing tests

Keep the file compact: short tests, one small fixture helper at most; the minimum test count plus a few boundary cases, no more.

Deliverable: `tools/tests/plumbing-gate-exec.test.mjs` (at least 18 tests). Acceptance: `node --test tools/tests/plumbing-gate-exec.test.mjs`.

Scripts in `n8n/code/` (read each header comment):
- `wf04-gate-scope.js`: unique accounts and symbols, count `n`, empty input.
- `wf04-collect-escalations.js` (needs node `Pre-trade checks` with `escalations: [...]`): duplicates collapse; `kind: 'mode'` become `actions` with a `fingerprint` of the form `gate:<scope>:<id>:<mode>`; `kind: 'kill'` become `kills` with `request_id` bucketed per minute (use `now`), `requested_by: 'risk_gate'`; nothing to do returns no items.
- `common-fan-out-kills.js`: contains the token `__SOURCE__`; in your test replace it with a node name by reading the script text and calling `runCodeNode(scriptText.replace('__SOURCE__','Collect escalations'), ctx)` (the sandbox accepts script text containing a newline). One item per kill; no kills gives no items.
- `wf05-ems-batch.js`: rows without `parent_order_id` are ignored; numbers coerced (`qty`, `limit_px`, `arrival_mid`); null stays null; `reduce_only` only true when strictly true; `request_id` is `dispatch:<first id>:<count>`; `ids` in order.
- `wf06-break-policy.js`: no breaks gives no items; an unexplained HIGH break sets that account REDUCE_ONLY with the max `diff_usd`; fill_lag, external_activity, MEDIUM unknown do not; `external_accounts` lists accounts with external activity; severity SEV2 when an action exists else SEV3; several accounts handled independently.
- `wf06-notable-events.js`: no notable gives no items; severity is the worst present (SEV1 over SEV2 over SEV3); at most 20 lines; `dedup_key` includes the severity and the hour (use `now`).

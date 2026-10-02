# TASK T-I: tests for risk and execution plumbing scripts

Deliverable: `tools/tests/plumbing.test.mjs` (at least 35 tests). Acceptance: `node --test tools/tests/plumbing.test.mjs`.

Scripts in `n8n/code/` (read each header comment):
- `wf04-gate-scope.js`: unique accounts and symbols, count `n`, empty input.
- `wf04-collect-escalations.js` (needs node `Pre-trade checks` with `escalations: [...]`): duplicates collapse; `kind: 'mode'` become `actions` with a `fingerprint` of the form `gate:<scope>:<id>:<mode>`; `kind: 'kill'` become `kills` with `request_id` bucketed per minute (use `now`), `requested_by: 'risk_gate'`; nothing to do returns no items.
- `common-fan-out-kills.js`: contains the token `__SOURCE__`; in your test replace it with a node name by reading the script text and calling `runCodeNode(scriptText.replace('__SOURCE__','Collect escalations'), ctx)` (the sandbox accepts script text containing a newline). One item per kill; no kills gives no items.
- `wf05-ems-batch.js`: rows without `parent_order_id` are ignored; numbers coerced (`qty`, `limit_px`, `arrival_mid`); null stays null; `reduce_only` only true when strictly true; `request_id` is `dispatch:<first id>:<count>`; `ids` in order.
- `wf06-break-policy.js`: no breaks gives no items; an unexplained HIGH break sets that account REDUCE_ONLY with the max `diff_usd`; fill_lag, external_activity, MEDIUM unknown do not; `external_accounts` lists accounts with external activity; severity SEV2 when an action exists else SEV3; several accounts handled independently.
- `wf06-notable-events.js`: no notable gives no items; severity is the worst present (SEV1 over SEV2 over SEV3); at most 20 lines; `dedup_key` includes the severity and the hour (use `now`).
- `wf07-normalize-snapshot.js` (needs node `Market stress event` with `isExecuted`; test both values): a DB-fallback input `{ s: {...} }` yields `source: 'db_fallback'`, a normal body keeps its `source` or defaults to `risk_svc`; trigger is `event` when the stress node executed, else `schedule`.
- `wf07-plan-followups.js` (needs node `Evaluate breakers`; input `{ r: { changed: [...] } }`): `mirror_global_mode` equals the global change's mode, null when no global change; other fields pass through.
- `wf07-dedupe-alert.js` (needs node `Plan follow-ups`; input `{ last_alert_fp }`): severity OK gives nothing; same fingerprint as last gives nothing; new fingerprint gives one item with `dedup_key` starting `risk-` and at most 250 characters.
- `wf15-analyst-prompt.js`: `analyst_input` is valid JSON containing the breach fields; `wf15-format-analysis.js`: all sections, "- none" for empty lists, at most 6 items, 3900-character cap, missing output handled.

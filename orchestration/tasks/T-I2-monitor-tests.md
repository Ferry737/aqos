# TASK T-I2: risk-monitor plumbing tests

Keep the file compact: short tests, one small fixture helper at most; the minimum test count plus a few boundary cases, no more.

Deliverable: `tools/tests/plumbing-monitor.test.mjs` (at least 14 tests). Acceptance: `node --test tools/tests/plumbing-monitor.test.mjs`.

Scripts in `n8n/code/` (read each header comment):
- `wf07-normalize-snapshot.js` (needs node `Market stress event` with `isExecuted`; test both values): a DB-fallback input `{ s: {...} }` yields `source: 'db_fallback'`, a normal body keeps its `source` or defaults to `risk_svc`; trigger is `event` when the stress node executed, else `schedule`.
- `wf07-plan-followups.js` (needs node `Evaluate breakers`; input `{ r: { changed: [...] } }`): `mirror_global_mode` equals the global change's mode, null when no global change; other fields pass through.
- `wf07-dedupe-alert.js` (needs node `Plan follow-ups`; input `{ last_alert_fp }`): severity OK gives nothing; same fingerprint as last gives nothing; new fingerprint gives one item with `dedup_key` starting `risk-` and at most 250 characters.
- `wf15-analyst-prompt.js`: `analyst_input` is valid JSON containing the breach fields; `wf15-format-analysis.js`: all sections, "- none" for empty lists, at most 6 items, 3900-character cap, missing output handled.

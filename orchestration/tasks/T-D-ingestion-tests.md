# TASK T-D: tests for data-ingestion and alt-data scripts

Deliverable: `tools/tests/ingestion.test.mjs` (at least 40 tests). Acceptance: `node --test tools/tests/ingestion.test.mjs`.

Scripts in `n8n/code/` (read each header comment; all take/return n8n items):
- `wf01-feed-rules.js`: input items shaped `{ r: { event_id, payload: { feed_id, venue, symbol, critical, status, detail } } }`. Test every status: checksum_mismatch and crossed_book quarantine; stale quarantines only beyond 60 s (critical) or 300 s (non-critical); outlier quarantines only with `abs(mad_z) > 8` and `venues_agreeing === 0`; gap gives backfill unless `detail.backfilled`; recovered only logs; `triage` true for any non-log action or a critical feed. Boundary values (60 vs 61 s, mad_z 8 vs 8.1).
- `wf01-dq-triage-request.js`: output has `anthropic_request` with model `claude-opus-5-5`, `fallbacks` equal to `'default'`, `output_config.format.type === 'json_schema'`; every object in the schema has `additionalProperties: false` and all its properties in `required`.
- `wf01-dq-triage-result.js` (needs node `Build DQ triage request` = the incident items): good response, refusal (`stop_reason: 'refusal'`), `max_tokens`, HTTP 529, invalid JSON, `{error:{message}}` item. Always yields `text`; `severity` SEV1 for a quarantined critical feed, SEV2 non-critical quarantine, else SEV3; backfill only when the rule asked or the model asked on a repairable cause (`sequence_gap`, `network_path`, `gateway_bug`); minutes clamped to 1..240.
- `wf02-funding-sources.js`: two venues. `wf02-normalize-funding.js` (needs node `Funding sources`): Binance array and Bybit `{result:{list}}` shapes; symbols outside the universe, `abs(funding) >= 0.05`, missing or non-positive marks and invalid timestamps are dropped and counted in `dropped`; an HTTP error or `error` item for one venue goes to `errors` without blocking the other.
- `wf02-split-headlines.js`, `wf02-batch-headlines.js`: trimming, 200-item cap, empty titles dropped, `hash_input` format, symbols capped at 10.
- `wf02-sentiment-request.js`: schema checks as for the DQ request, at most 40 headlines. `wf02-sentiment-result.js` (needs node `Build sentiment request` with `batch_hashes`): unknown hashes and assets dropped, duplicates dropped, score clipped to [-1, 1], relevance to [0, 1], non-finite values dropped, any failure returns no scores and an `error`.

A response from the Claude API as the scripts see it: `{ statusCode: 200, body: { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: '<json string>' }] } }`.

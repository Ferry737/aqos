# Service contracts (as the n8n workflows and Code scripts consume them)

All services are JSON over HTTP. Auth for every service call from n8n: header `Authorization: Bearer <token>` (n8n "Header Auth" credential); a request without a valid token must get HTTP 401. Errors: 4xx/5xx with `{ "error": { "code": "...", "message": "..." } }`.

## Calls made by n8n

| Service | Call | Request | 200 response |
|---|---|---|---|
| stream-gw | `POST /v1/backfill` | `{ feed_id, minutes }` | `{ accepted: true, job_id }` |
| data-adapter | `GET /v1/headlines?since=15m` | query `since` | `{ items: [{ source, title, url, published_at, symbols: [] }] }` |
| model-svc | `POST /v1/predict` | `{ cycle_id, bar_ts, strategy_set }` | `{ as_of, regime, predictions: [{ model_id, model_version, symbol, horizon, mu, sigma, p_up, q05, q50, q95 }], diagnostics }` where `as_of` equals the request `bar_ts` and `model_id` starts with one of `tsmom_v1`, `xsmom_v1`, `statarb_ou_v1`, `funding_carry_v1`, `basis_xex_v1`; `sigma > 0`; `abs(mu) <= 5 * sigma`; `0 <= p_up <= 1`. Deterministic per `cycle_id`. |
| portfolio-svc | `POST /v1/propose` | `{ cycle_id, bar_ts, predictions: [...] }` | `{ proposals: [{ account_id, strategy_id, symbol, venue, side: BUY or SELL, qty, order_type, limit_px, urgency, pair_id, reduce_only }], diagnostics }` |
| portfolio-svc | `POST /v1/rebalance` | `{ as_of, reason, accounts: [{ account_id, max_abs_drift, drifted: [{ venue, symbol, target_w, current_w }] }] }` | `{ proposals: [...same shape...] }` |
| portfolio-svc | `POST /v1/allocation/propose` | `{ as_of }` | `{ proposed_weights: { <strategy>: number }, current_weights: { <strategy>: number }, diagnostics }` |
| risk-svc | `GET /v1/snapshot` | none | `{ source: "risk_svc", ts, global: { var_limit_usd, var_99_1d_usd, es_limit_usd, es_975_1d_usd, absorption_ratio, stablecoin_depeg_bps: { <coin>: number }, max_mark_age_s }, venues: [{ venue, health: "UP" or "DOWN", withdrawals_suspended }], accounts: [{ account_id, equity_usd, day_pnl_pct, drawdown_pct, gross_leverage, daily_loss_limit_pct, max_drawdown_pct, auto_flatten_on_max_dd, min_liq_distance_sigma }] }` |
| ems | `POST /v1/orders/batch` | `{ request_id, sent_at, orders: [{ parent_order_id, account_id, strategy_id, venue, symbol, side, qty, order_type, limit_px, reduce_only, algo, algo_params, urgency, pair_id, arrival_mid }] }` | `{ request_id, accepted: [parent_order_id], duplicates: [parent_order_id], rejected: [{ parent_order_id, reason }] }`. Idempotent on `parent_order_id`: re-sending reports it under `duplicates`, never creates a second order. |
| ems | `POST /v1/kill` | `{ request_id, scope: global/account/strategy/venue, scope_id, action: halt_new/cancel_all/flatten, reason }` | `{ request_id, status, cancelled_orders, duplicate }`. Idempotent on `request_id`. |
| ems | `POST /v1/exposure` | `{ scope, scope_id }` | `{ open_orders, gross_notional_usd }` |
| ems | `POST /v1/snapshots` | `{ accounts: "all" }` | `{ accounts: [{ account_id, venue, positions: [{ symbol, qty }], external_orders_count, external_fills_count }] }` (state read from the venues) |
| ems | `POST /v1/keys/inspect` | `{ venue, key_ref }` | `{ can_trade, can_withdraw, can_transfer, ip_restricted, futures_enabled }` (read from the venue) |
| ems | `POST /v1/keys/destroy` | `{ key_ref }` | `{ destroyed: true }` |

## Events pushed to n8n

`POST https://<n8n>/webhook/aqos/events` with header `x-aqos-signature: sha256=<lowercase hex HMAC-SHA256 of the exact raw body>` and body
`{ event_id (unique), source, type, ts (ISO, within 30 s of delivery), payload }`.

| type | payload |
|---|---|
| `bar_close` | `{ bar_ts, timeframe: "5m" }` |
| `market_stress` | `{ reason, severity }` |
| `execution_events` | `{ events: [{ event_id, type: ACK/WORKING/PARTIAL_FILL/FILL/CANCELLED/REJECTED/EXPIRED/LIQUIDATION/ADL/FUNDING/FEE, parent_order_id, account_id, venue, symbol, side, qty, px, fee_usd, ts, reason }] }` |
| `feed_status` | `{ feed_id, venue, symbol, critical, status: stale/gap/checksum_mismatch/crossed_book/outlier/recovered, detail }` |

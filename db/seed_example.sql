-- =====================================================================
-- Example data for local development and tests.
-- Every number here is an illustrative placeholder: limits must be
-- calibrated and approved by the risk committee before any live use.
-- None of these values are performance figures.
-- =====================================================================

INSERT INTO risk.limits(limits_version, effective_at, created_by, approved_by, doc) VALUES
('lim-2026.10-a', now() - interval '1 day', 'risk_committee', ARRAY['cro', 'cto'], '{
  "global": {
    "max_order_notional_usd": 250000,
    "min_order_notional_usd": 10,
    "price_collar_bps": 150,
    "max_mark_age_s": 10,
    "max_orders_per_min_per_account": 30,
    "decision_ttl_s": 90,
    "restricted_symbols": ["LUNAUSDT"]
  },
  "strategies": {
    "tsmom_v1":         {"max_gross_usd": 5000000},
    "xsmom_v1":         {"max_gross_usd": 3000000},
    "statarb_ou_v1":    {"max_gross_usd": 2000000},
    "funding_carry_v1": {"max_gross_usd": 8000000},
    "basis_xex_v1":     {"max_gross_usd": 4000000}
  },
  "breakers": {
    "var_util_warn": 0.8,
    "var_util_reduce": 1.0,
    "es_util_halt": 1.25,
    "liq_distance_sigma_reduce": 3.0,
    "liq_distance_sigma_flatten": 1.5,
    "depeg_bps_reduce": 50,
    "depeg_bps_halt": 200,
    "max_mark_age_s_halt": 60,
    "fallback_streak_reduce": 8,
    "absorption_warn": 0.85
  }
}'::jsonb) ON CONFLICT DO NOTHING;

INSERT INTO biz.clients(client_id, external_ref, email, jurisdiction, status, risk_profile, appropriateness_score,
                        tier, mode, quiz_passed_at, paper_started_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'cus_demo_a', 'client.a@example.com', 'EU-DE', 'ACTIVE', 'BALANCED', 78,
   'CORE', 'LIVE', now() - interval '40 days', now() - interval '60 days'),
  ('22222222-2222-4222-8222-222222222222', 'cus_demo_b', 'client.b@example.com', 'SG', 'ACTIVE', 'CONSERVATIVE', 64,
   'LAB', 'PAPER', now() - interval '20 days', now() - interval '20 days')
ON CONFLICT DO NOTHING;

INSERT INTO biz.accounts(account_id, client_id, venue, key_ref, key_status, billing_status) VALUES
  ('acc_a_binance', '11111111-1111-4111-8111-111111111111', 'binance', 'kv://keys/acc_a_binance', 'VERIFIED', 'ACTIVE'),
  ('acc_a_bybit',   '11111111-1111-4111-8111-111111111111', 'bybit',   'kv://keys/acc_a_bybit',   'VERIFIED', 'ACTIVE'),
  ('acc_b_binance', '22222222-2222-4222-8222-222222222222', 'binance', 'kv://keys/acc_b_binance', 'VERIFIED', 'ACTIVE')
ON CONFLICT DO NOTHING;

INSERT INTO biz.consents(client_id, doc_type, doc_version, doc_sha256) VALUES
  ('11111111-1111-4111-8111-111111111111', 'risk_disclosure', '2026.09', repeat('a', 64)),
  ('22222222-2222-4222-8222-222222222222', 'risk_disclosure', '2026.09', repeat('a', 64))
ON CONFLICT DO NOTHING;

INSERT INTO biz.subscriptions(client_id, stripe_customer_id, stripe_subscription_id, tier, status, monthly_fee_usd) VALUES
  ('11111111-1111-4111-8111-111111111111', 'cus_stripe_a', 'sub_a', 'CORE', 'ACTIVE', 149),
  ('22222222-2222-4222-8222-222222222222', 'cus_stripe_b', 'sub_b', 'PRO',  'ACTIVE', 399)
ON CONFLICT DO NOTHING;

INSERT INTO risk.account_state(account_id, equity_usd, day_start_equity_usd, hwm_equity_usd) VALUES
  ('acc_a_binance', 100000, 100500, 104000),
  ('acc_a_bybit',    50000,  50000,  50000),
  ('acc_b_binance',  20000,  20000,  20000)
ON CONFLICT DO NOTHING;

INSERT INTO risk.account_limits(account_id, limits) VALUES
  ('acc_a_binance', '{"max_gross_leverage": 2.0, "max_net_leverage": 1.0, "max_position_pct_equity": 0.25,
                      "daily_loss_limit_pct": 0.03, "max_drawdown_pct": 0.15, "max_order_notional_usd": 50000,
                      "allowed_symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LUNAUSDT"],
                      "allowed_strategies": ["tsmom_v1", "funding_carry_v1", "statarb_ou_v1"],
                      "venue_caps_usd": {"binance": 150000}, "auto_flatten_on_max_dd": false}'),
  ('acc_a_bybit',   '{"max_gross_leverage": 2.0, "max_net_leverage": 1.0, "max_position_pct_equity": 0.5,
                      "daily_loss_limit_pct": 0.03, "max_drawdown_pct": 0.15,
                      "allowed_symbols": ["BTCUSDT", "ETHUSDT"], "allowed_strategies": ["funding_carry_v1", "basis_xex_v1"],
                      "venue_caps_usd": {"bybit": 75000}, "auto_flatten_on_max_dd": false}'),
  ('acc_b_binance', '{"max_gross_leverage": 1.0, "max_net_leverage": 1.0, "max_position_pct_equity": 0.2,
                      "daily_loss_limit_pct": 0.02, "max_drawdown_pct": 0.10,
                      "allowed_symbols": ["BTCUSDT", "ETHUSDT"], "allowed_strategies": ["tsmom_v1"],
                      "venue_caps_usd": {"binance": 20000}, "auto_flatten_on_max_dd": true}')
ON CONFLICT DO NOTHING;

INSERT INTO md.latest_mark(venue, symbol, px, ts) VALUES
  ('binance', 'BTCUSDT', 61250.5, now()),
  ('binance', 'ETHUSDT', 2450.25, now()),
  ('binance', 'SOLUSDT', 142.10,  now()),
  ('binance', 'LUNAUSDT', 0.5,    now()),
  ('bybit',   'BTCUSDT', 61248.0, now()),
  ('bybit',   'ETHUSDT', 2450.10, now())
ON CONFLICT DO NOTHING;

INSERT INTO md.feed_registry(feed_id, venue, channel, symbol, critical, trust, last_bar_ts) VALUES
  ('binance.kline_1m.BTCUSDT', 'binance', 'kline_1m', 'BTCUSDT', true, 1, now() - interval '20 seconds'),
  ('binance.kline_1m.ETHUSDT', 'binance', 'kline_1m', 'ETHUSDT', true, 1, now() - interval '25 seconds'),
  ('bybit.tickers.BTCUSDT',    'bybit',   'tickers',  'BTCUSDT', false, 1, now() - interval '5 seconds')
ON CONFLICT DO NOTHING;

INSERT INTO oms.positions(account_id, venue, symbol, qty, avg_px) VALUES
  ('acc_a_binance', 'binance', 'BTCUSDT', 0.4, 60000),
  ('acc_a_binance', 'binance', 'ETHUSDT', -5,  2500)
ON CONFLICT DO NOTHING;

INSERT INTO oms.strategy_positions(account_id, strategy_id, venue, symbol, qty) VALUES
  ('acc_a_binance', 'tsmom_v1',      'binance', 'BTCUSDT', 0.4),
  ('acc_a_binance', 'statarb_ou_v1', 'binance', 'ETHUSDT', -5)
ON CONFLICT DO NOTHING;

INSERT INTO pm.targets(account_id, strategy_id, venue, symbol, target_weight, no_trade_band) VALUES
  ('acc_a_binance', 'tsmom_v1', 'binance', 'BTCUSDT', 0.30, 0.02)
ON CONFLICT DO NOTHING;

INSERT INTO research.model_registry_mirror(model_id, strategy_family, stage, live_vs_backtest_z, psi_max) VALUES
  ('tsmom_v1@lgbm-2026.09',    'tsmom',   'production', -0.4, 0.06),
  ('statarb_ou_v1@ou-2026.08', 'statarb', 'production', -2.8, 0.31),
  ('xsmom_v1@tft-2026.09',     'xsmom',   'paper',       0.2, 0.04)
ON CONFLICT DO NOTHING;

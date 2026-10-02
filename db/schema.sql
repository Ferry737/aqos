-- =====================================================================
-- AQOS (Agentic Quant OS) — orchestration schema
-- PostgreSQL 15+. Verified with PGlite (Postgres 17) by tools/test-schema.mjs.
-- TimescaleDB is optional; hypertables are created only when it is installed.
--
-- Contract with n8n:
--   * Every function a workflow calls takes ONE jsonb argument ($1::jsonb)
--     and is idempotent, so retries and duplicate triggers are harmless.
--   * Safety invariants live here, not in workflow code:
--       - a risk decision is a single-use, expiring token (risk.decisions)
--       - no parent order exists without a consumed token (oms.submit_parent_orders)
--       - risk modes only escalate unless de-escalation is explicitly authorised
--       - every state change is written to a hash-chained audit log
--   * Venue state is the golden source; internal books reconcile to it.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS md;
CREATE SCHEMA IF NOT EXISTS alt;
CREATE SCHEMA IF NOT EXISTS alpha;
CREATE SCHEMA IF NOT EXISTS pm;
CREATE SCHEMA IF NOT EXISTS risk;
CREATE SCHEMA IF NOT EXISTS oms;
CREATE SCHEMA IF NOT EXISTS biz;
CREATE SCHEMA IF NOT EXISTS research;
CREATE SCHEMA IF NOT EXISTS pnl;

-- ---------------------------------------------------------------------
-- ops: audit chain, heartbeats, events, incidents, leases, kill requests
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.audit_log (
  seq        bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL,
  actor      text NOT NULL,
  action     text NOT NULL,
  subject    text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);

CREATE TABLE IF NOT EXISTS ops.audit_head (
  id        int PRIMARY KEY CHECK (id = 1),
  last_seq  bigint NOT NULL,
  last_hash text NOT NULL
);
INSERT INTO ops.audit_head VALUES (1, 0, repeat('0', 64)) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION ops.audit_digest(p_prev text, p_actor text, p_action text, p_subject text, p_payload jsonb, p_ts timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
           p_prev || '|' || p_actor || '|' || p_action || '|' || coalesce(p_subject, '') || '|' ||
           coalesce(p_payload, '{}'::jsonb)::text || '|' ||
           to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex')
$$;

-- Appends serialise on ops.audit_head, so the chain has no forks.
CREATE OR REPLACE FUNCTION ops.append_audit(p_actor text, p_action text, p_subject text, p_payload jsonb)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_prev text;
  v_ts   timestamptz := clock_timestamp();
  v_hash text;
  v_seq  bigint;
BEGIN
  SELECT last_hash INTO v_prev FROM ops.audit_head WHERE id = 1 FOR UPDATE;
  v_hash := ops.audit_digest(v_prev, p_actor, p_action, p_subject, p_payload, v_ts);
  INSERT INTO ops.audit_log(ts, actor, action, subject, payload, prev_hash, hash)
  VALUES (v_ts, p_actor, p_action, p_subject, coalesce(p_payload, '{}'::jsonb), v_prev, v_hash)
  RETURNING seq INTO v_seq;
  UPDATE ops.audit_head SET last_seq = v_seq, last_hash = v_hash WHERE id = 1;
  RETURN v_seq;
END $$;

CREATE OR REPLACE FUNCTION ops.verify_audit_chain(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  r      record;
  v_prev text := repeat('0', 64);
  n      bigint := 0;
BEGIN
  FOR r IN SELECT * FROM ops.audit_log ORDER BY seq LOOP
    IF r.prev_hash <> v_prev
       OR r.hash <> ops.audit_digest(v_prev, r.actor, r.action, r.subject, r.payload, r.ts) THEN
      RETURN jsonb_build_object('ok', false, 'broken_at_seq', r.seq, 'checked', n);
    END IF;
    v_prev := r.hash;
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'checked', n);
END $$;

CREATE TABLE IF NOT EXISTS ops.heartbeats (
  component text PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ops.touch_heartbeat(p_component text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO ops.heartbeats(component, ts) VALUES (p_component, now())
  ON CONFLICT (component) DO UPDATE SET ts = now();
$$;

-- Inbound webhook events (market-data gateway, EMS). Dedupe by event_id.
CREATE TABLE IF NOT EXISTS ops.events (
  event_id    text PRIMARY KEY,
  source      text NOT NULL,
  type        text NOT NULL,
  ts          timestamptz NOT NULL,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ops.ingest_event(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  IF coalesce(p->>'event_id', '') = '' OR coalesce(p->>'type', '') = '' THEN
    RAISE EXCEPTION 'event_id and type are required';
  END IF;
  INSERT INTO ops.events(event_id, source, type, ts, payload)
  VALUES (p->>'event_id', coalesce(p->>'source', 'unknown'), p->>'type',
          coalesce((p->>'ts')::timestamptz, now()), coalesce(p->'payload', '{}'::jsonb))
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN PERFORM ops.touch_heartbeat('event_gateway:' || coalesce(p->>'source', 'unknown')); END IF;
  RETURN jsonb_build_object('inserted', v_n = 1, 'event_id', p->>'event_id', 'type', p->>'type',
                            'payload', coalesce(p->'payload', '{}'::jsonb));
END $$;

CREATE TABLE IF NOT EXISTS ops.dead_letter (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  source  text NOT NULL,
  reason  text NOT NULL,
  payload jsonb NOT NULL
);

CREATE OR REPLACE FUNCTION ops.dead_letter_put(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO ops.dead_letter(source, reason, payload)
    VALUES (coalesce(p->>'source', 'unknown'), coalesce(p->>'reason', 'unspecified'), coalesce(p->'payload', p))
    RETURNING id)
  SELECT jsonb_build_object('dead_letter_id', id) FROM ins;
$$;

-- Leader lease with a fencing epoch. A holder that loses the lease cannot act:
-- downstream services reject requests carrying an old epoch.
CREATE TABLE IF NOT EXISTS ops.leases (
  name       text PRIMARY KEY,
  holder     text NOT NULL,
  epoch      bigint NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION ops.try_acquire_lease(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_name   text := p->>'name';
  v_holder text := p->>'holder';
  v_ttl    int  := coalesce((p->>'ttl_s')::int, 30);
  r        ops.leases%ROWTYPE;
BEGIN
  INSERT INTO ops.leases AS l (name, holder, epoch, expires_at)
  VALUES (v_name, v_holder, 1, clock_timestamp() + make_interval(secs => v_ttl))
  ON CONFLICT (name) DO UPDATE
     SET holder     = EXCLUDED.holder,
         epoch      = CASE WHEN l.holder = EXCLUDED.holder THEN l.epoch ELSE l.epoch + 1 END,
         expires_at = EXCLUDED.expires_at
   WHERE l.holder = EXCLUDED.holder OR l.expires_at < clock_timestamp()
  RETURNING * INTO r;
  IF r.name IS NULL THEN
    SELECT * INTO r FROM ops.leases WHERE name = v_name;
    RETURN jsonb_build_object('acquired', false, 'holder', r.holder, 'epoch', r.epoch, 'expires_at', r.expires_at);
  END IF;
  RETURN jsonb_build_object('acquired', true, 'holder', r.holder, 'epoch', r.epoch, 'expires_at', r.expires_at);
END $$;

CREATE OR REPLACE FUNCTION ops.check_fence(p jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM ops.leases
     WHERE name = p->>'name' AND holder = p->>'holder'
       AND epoch = (p->>'epoch')::bigint AND expires_at > clock_timestamp());
$$;

CREATE TABLE IF NOT EXISTS ops.incidents (
  incident_id   bigserial PRIMARY KEY,
  fingerprint   text NOT NULL UNIQUE,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  occurrences   bigint NOT NULL DEFAULT 1,
  workflow_id   text,
  workflow_name text,
  node          text,
  message       text,
  severity      text,
  status        text NOT NULL DEFAULT 'OPEN'
);

CREATE TABLE IF NOT EXISTS ops.incident_hits (
  fingerprint text NOT NULL,
  ts          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS incident_hits_fp_ts ON ops.incident_hits(fingerprint, ts);

CREATE OR REPLACE FUNCTION ops.record_incident(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_fp     text := p->>'fingerprint';
  v_new    boolean;
  v_id     bigint;
  v_total  bigint;
  v_window bigint;
BEGIN
  INSERT INTO ops.incidents AS i (fingerprint, workflow_id, workflow_name, node, message, severity)
  VALUES (v_fp, p->>'workflow_id', p->>'workflow_name', p->>'node', left(p->>'message', 2000), p->>'severity')
  ON CONFLICT (fingerprint) DO UPDATE
     SET last_seen = now(), occurrences = i.occurrences + 1, status = 'OPEN',
         message = EXCLUDED.message, severity = EXCLUDED.severity
  RETURNING incident_id, occurrences, (xmax = 0) INTO v_id, v_total, v_new;
  INSERT INTO ops.incident_hits(fingerprint) VALUES (v_fp);
  SELECT count(*) INTO v_window FROM ops.incident_hits
   WHERE fingerprint = v_fp
     AND ts > clock_timestamp() - make_interval(secs => coalesce((p->>'window_s')::int, 300));
  RETURN jsonb_build_object('incident_id', v_id, 'is_new', v_new, 'occurrences_total', v_total,
                            'occurrences_window', v_window);
END $$;

CREATE TABLE IF NOT EXISTS ops.supervisor_transitions (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  fingerprint text NOT NULL,
  state       jsonb NOT NULL
);

CREATE OR REPLACE FUNCTION ops.record_supervisor_transition(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO ops.supervisor_transitions(fingerprint, state)
    VALUES (coalesce(p->>'fingerprint', 'none'), p) RETURNING id)
  SELECT jsonb_build_object('transition_id', id) FROM ins;
$$;

-- ---------------------------------------------------------------------
-- md: feed registry, latest marks, funding, alternative metrics
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS md.feed_registry (
  feed_id           text PRIMARY KEY,
  venue             text NOT NULL,
  channel           text NOT NULL,
  symbol            text,
  critical          boolean NOT NULL DEFAULT false,
  trust             smallint NOT NULL DEFAULT 1 CHECK (trust IN (0, 1)),
  last_bar_ts       timestamptz,
  quarantined_at    timestamptz,
  quarantine_reason text
);

-- Written by the stream gateway every second (UNLOGGED in production).
CREATE TABLE IF NOT EXISTS md.latest_mark (
  venue  text NOT NULL,
  symbol text NOT NULL,
  px     numeric NOT NULL CHECK (px > 0),
  ts     timestamptz NOT NULL,
  PRIMARY KEY (venue, symbol)
);

CREATE TABLE IF NOT EXISTS md.funding (
  venue           text NOT NULL,
  symbol          text NOT NULL,
  ts              timestamptz NOT NULL,
  funding_rate    numeric,
  next_funding_ts timestamptz,
  mark_px         numeric,
  index_px        numeric,
  open_interest   numeric,
  PRIMARY KEY (venue, symbol, ts)
);

CREATE OR REPLACE FUNCTION md.upsert_funding(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH src AS (
    SELECT DISTINCT ON (x->>'venue', x->>'symbol', (x->>'ts')::timestamptz) x
      FROM jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) x
     ORDER BY x->>'venue', x->>'symbol', (x->>'ts')::timestamptz),
  ins AS (
    INSERT INTO md.funding(venue, symbol, ts, funding_rate, next_funding_ts, mark_px, index_px, open_interest)
    SELECT x->>'venue', x->>'symbol', (x->>'ts')::timestamptz, (x->>'funding_rate')::numeric,
           (x->>'next_funding_ts')::timestamptz, (x->>'mark_px')::numeric, (x->>'index_px')::numeric,
           (x->>'open_interest')::numeric
      FROM src
    ON CONFLICT (venue, symbol, ts) DO UPDATE
       SET funding_rate = EXCLUDED.funding_rate, next_funding_ts = EXCLUDED.next_funding_ts,
           mark_px = EXCLUDED.mark_px, index_px = EXCLUDED.index_px, open_interest = EXCLUDED.open_interest
    RETURNING 1)
  SELECT jsonb_build_object('upserted', count(*)) FROM ins;
$$;

CREATE TABLE IF NOT EXISTS md.alt_metrics (
  source text NOT NULL,
  metric text NOT NULL,
  ts     timestamptz NOT NULL,
  value  numeric,
  PRIMARY KEY (source, metric, ts)
);

CREATE OR REPLACE FUNCTION md.upsert_alt_metrics(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH src AS (
    SELECT DISTINCT ON (x->>'source', x->>'metric', (x->>'ts')::timestamptz) x
      FROM jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) x
     ORDER BY x->>'source', x->>'metric', (x->>'ts')::timestamptz),
  ins AS (
    INSERT INTO md.alt_metrics(source, metric, ts, value)
    SELECT x->>'source', x->>'metric', (x->>'ts')::timestamptz, (x->>'value')::numeric FROM src
    ON CONFLICT (source, metric, ts) DO UPDATE SET value = EXCLUDED.value
    RETURNING 1)
  SELECT jsonb_build_object('upserted', count(*)) FROM ins;
$$;

-- Quarantine is automatic and reversible only by a human (md.restore_feed is
-- deliberately not exposed to any workflow or agent).
CREATE OR REPLACE FUNCTION md.quarantine_feed(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  UPDATE md.feed_registry
     SET trust = 0, quarantined_at = now(), quarantine_reason = left(p->>'reason', 500)
   WHERE feed_id = p->>'feed_id' AND trust = 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    PERFORM ops.append_audit(coalesce(p->>'actor', 'data_quality'), 'md.quarantine', p->>'feed_id', p);
  END IF;
  RETURN jsonb_build_object('feed_id', p->>'feed_id', 'quarantined', v_n = 1);
END $$;

CREATE OR REPLACE FUNCTION md.restore_feed(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p->>'restored_by', '') = '' THEN RAISE EXCEPTION 'restored_by is required'; END IF;
  UPDATE md.feed_registry SET trust = 1, quarantined_at = NULL, quarantine_reason = NULL WHERE feed_id = p->>'feed_id';
  PERFORM ops.append_audit(p->>'restored_by', 'md.restore', p->>'feed_id', p);
  RETURN jsonb_build_object('feed_id', p->>'feed_id', 'restored', true);
END $$;

-- ---------------------------------------------------------------------
-- alt: headlines and sentiment (LLM output is stored as scored data only)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alt.headlines (
  hash         text PRIMARY KEY,
  source       text,
  published_at timestamptz,
  title        text NOT NULL,
  url          text,
  symbols      text[] NOT NULL DEFAULT '{}',
  first_seen   timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION alt.filter_new_headlines(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO alt.headlines(hash, source, published_at, title, url, symbols)
    SELECT x->>'hash', x->>'source', (x->>'published_at')::timestamptz, x->>'title', x->>'url',
           ARRAY(SELECT jsonb_array_elements_text(coalesce(x->'symbols', '[]'::jsonb)))
      FROM jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) x
     WHERE coalesce(x->>'hash', '') <> '' AND coalesce(x->>'title', '') <> ''
    ON CONFLICT (hash) DO NOTHING
    RETURNING hash, source, published_at, title, url, symbols)
  SELECT jsonb_build_object('count', count(*), 'new_items', coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb)) FROM ins;
$$;

CREATE TABLE IF NOT EXISTS alt.sentiment_scores (
  hash       text NOT NULL REFERENCES alt.headlines(hash),
  asset      text NOT NULL,
  model      text NOT NULL,
  scored_at  timestamptz NOT NULL DEFAULT now(),
  score      numeric NOT NULL CHECK (score BETWEEN -1 AND 1),
  relevance  numeric NOT NULL CHECK (relevance BETWEEN 0 AND 1),
  event_type text,
  PRIMARY KEY (hash, asset)
);

CREATE OR REPLACE FUNCTION alt.record_sentiment(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO alt.sentiment_scores(hash, asset, model, score, relevance, event_type)
    SELECT x->>'hash', upper(x->>'asset'), coalesce(p->>'model', 'unknown'),
           greatest(-1, least(1, (x->>'score')::numeric)),
           greatest(0, least(1, (x->>'relevance')::numeric)), x->>'event_type'
      FROM jsonb_array_elements(coalesce(p->'scores', '[]'::jsonb)) x
     WHERE EXISTS (SELECT 1 FROM alt.headlines h WHERE h.hash = x->>'hash')
    ON CONFLICT (hash, asset) DO NOTHING
    RETURNING 1)
  SELECT jsonb_build_object('recorded', count(*)) FROM ins;
$$;

-- ---------------------------------------------------------------------
-- risk: limits, modes (ratchet), account state, decisions (tokens), breaches
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk.limits (
  limits_version text PRIMARY KEY,
  effective_at   timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  approved_by    text[] NOT NULL DEFAULT '{}',
  doc            jsonb NOT NULL
);

CREATE OR REPLACE VIEW risk.current_limits AS
  SELECT * FROM risk.limits WHERE effective_at <= now() ORDER BY effective_at DESC, limits_version DESC LIMIT 1;

CREATE TABLE IF NOT EXISTS risk.modes (
  scope    text NOT NULL CHECK (scope IN ('global', 'account', 'strategy', 'venue')),
  scope_id text NOT NULL,
  mode     text NOT NULL CHECK (mode IN ('NORMAL', 'REDUCE_ONLY', 'HALT')),
  reason   text,
  set_by   text,
  set_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_id)
);
INSERT INTO risk.modes(scope, scope_id, mode, reason, set_by)
VALUES ('global', '*', 'NORMAL', 'bootstrap', 'schema') ON CONFLICT DO NOTHING;

-- Unknown modes rank as HALT: fail closed.
CREATE OR REPLACE FUNCTION risk.mode_rank(m text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE upper(coalesce(m, 'NORMAL')) WHEN 'NORMAL' THEN 0 WHEN 'REDUCE_ONLY' THEN 1 ELSE 2 END
$$;

-- Ratchet: escalation is always allowed. De-escalation needs either
--   (a) allow_deescalate + two distinct approvers (four-eyes), or
--   (b) lift_own = <subsystem> when the current reason was set by that same
--       subsystem ("billing:", "daily_loss:"): a control lifts only what it set.
CREATE OR REPLACE FUNCTION risk.apply_mode(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_scope     text := p->>'scope';
  v_id        text := coalesce(p->>'scope_id', '*');
  v_new       text := upper(p->>'mode');
  v_set_by    text := coalesce(p->>'set_by', 'system');
  v_old       text;
  v_old_rsn   text;
  v_approvers int;
  v_lift_own  text := p->>'lift_own';
BEGIN
  IF v_new NOT IN ('NORMAL', 'REDUCE_ONLY', 'HALT') THEN RAISE EXCEPTION 'invalid mode: %', v_new; END IF;
  SELECT mode, reason INTO v_old, v_old_rsn FROM risk.modes WHERE scope = v_scope AND scope_id = v_id FOR UPDATE;
  v_old := coalesce(v_old, 'NORMAL');

  IF risk.mode_rank(v_new) > risk.mode_rank(v_old) THEN
    NULL;  -- escalation
  ELSIF risk.mode_rank(v_new) < risk.mode_rank(v_old) THEN
    IF v_lift_own IS NOT NULL AND v_old_rsn LIKE v_lift_own || ':%' THEN
      NULL;  -- the subsystem that set the mode may lift it
    ELSIF coalesce((p->>'allow_deescalate')::boolean, false) THEN
      SELECT count(DISTINCT a) INTO v_approvers FROM jsonb_array_elements_text(coalesce(p->'approver_ids', '[]'::jsonb)) a;
      IF v_approvers < 2 THEN RAISE EXCEPTION 'de-escalation of %:% requires two distinct approvers', v_scope, v_id; END IF;
    ELSE
      RETURN jsonb_build_object('scope', v_scope, 'scope_id', v_id, 'previous', v_old, 'mode', v_old,
                                'changed', false, 'note', 'de-escalation not authorised');
    END IF;
  ELSE
    RETURN jsonb_build_object('scope', v_scope, 'scope_id', v_id, 'previous', v_old, 'mode', v_old, 'changed', false);
  END IF;

  INSERT INTO risk.modes(scope, scope_id, mode, reason, set_by, set_at)
  VALUES (v_scope, v_id, v_new, p->>'reason', v_set_by, now())
  ON CONFLICT (scope, scope_id) DO UPDATE
     SET mode = EXCLUDED.mode, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now();
  PERFORM ops.append_audit(v_set_by, 'risk.mode_change', v_scope || ':' || v_id,
                           jsonb_build_object('from', v_old, 'to', v_new, 'reason', p->>'reason',
                                              'approver_ids', p->'approver_ids'));
  RETURN jsonb_build_object('scope', v_scope, 'scope_id', v_id, 'previous', v_old, 'mode', v_new, 'changed', true);
END $$;

CREATE TABLE IF NOT EXISTS risk.account_state (
  account_id           text PRIMARY KEY,
  equity_usd           numeric NOT NULL,
  day_start_equity_usd numeric NOT NULL,
  hwm_equity_usd       numeric NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Mandate limits chosen by the client inside platform caps.
CREATE TABLE IF NOT EXISTS risk.account_limits (
  account_id text PRIMARY KEY,
  limits     jsonb NOT NULL,
  version    int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk.decisions (
  decision_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id    text NOT NULL UNIQUE,
  cycle_id       text,
  account_id     text NOT NULL,
  strategy_id    text NOT NULL,
  symbol         text NOT NULL,
  venue          text NOT NULL,
  side           text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  requested_qty  numeric NOT NULL,
  approved_qty   numeric NOT NULL DEFAULT 0 CHECK (approved_qty >= 0),
  decision       text NOT NULL CHECK (decision IN ('APPROVE', 'RESIZE', 'REJECT')),
  order_type     text,
  limit_px       numeric,
  urgency        text,
  reduce_only    boolean NOT NULL DEFAULT false,
  pair_id        text,
  mark_px        numeric,
  reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  checks         jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalate       jsonb,
  limits_version text,
  state_version  text,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN', 'CONSUMED', 'EXPIRED', 'NOT_DISPATCHED', 'CLOSED')),
  consumed_at    timestamptz,
  CHECK (decision = 'REJECT' OR approved_qty > 0)
);
CREATE INDEX IF NOT EXISTS decisions_cycle ON risk.decisions(cycle_id);

CREATE TABLE IF NOT EXISTS risk.breaches (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  scope       text NOT NULL,
  scope_id    text NOT NULL,
  tier        text NOT NULL,
  metric      text,
  value       numeric,
  limit_value numeric,
  action      text,
  fingerprint text
);

CREATE TABLE IF NOT EXISTS risk.monitor_state (
  id              int PRIMARY KEY CHECK (id = 1),
  last_source     text,
  fallback_streak int NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO risk.monitor_state(id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS risk.limit_change_requests (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  scope        text NOT NULL,
  scope_id     text NOT NULL,
  limit_name   text NOT NULL,
  old_value    numeric,
  new_value    numeric NOT NULL,
  rationale    text,
  requested_by text NOT NULL,
  status       text NOT NULL CHECK (status IN ('APPLIED', 'PENDING_HUMAN', 'REJECTED')),
  applied_at   timestamptz
);

-- ---------------------------------------------------------------------
-- biz: clients, venue accounts, consents, subscriptions, reports
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS biz.clients (
  client_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref          text UNIQUE,
  email                 text NOT NULL,
  jurisdiction          text NOT NULL,
  status                text NOT NULL CHECK (status IN ('ACTIVE', 'PENDING_REVIEW', 'BLOCKED', 'CLOSED')),
  screening             jsonb,
  risk_profile          text CHECK (risk_profile IN ('CONSERVATIVE', 'BALANCED', 'DYNAMIC')),
  appropriateness_score int,
  tier                  text NOT NULL DEFAULT 'LAB',
  mode                  text NOT NULL DEFAULT 'PAPER' CHECK (mode IN ('PAPER', 'LIVE')),
  report_cadence        text NOT NULL DEFAULT 'daily' CHECK (report_cadence IN ('daily', 'weekly', 'monthly')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  paper_started_at      timestamptz NOT NULL DEFAULT now(),
  quiz_passed_at        timestamptz,
  live_opt_in_at        timestamptz
);

CREATE TABLE IF NOT EXISTS biz.accounts (
  account_id      text PRIMARY KEY,
  client_id       uuid REFERENCES biz.clients(client_id),
  venue           text NOT NULL,
  key_ref         text,
  key_status      text NOT NULL DEFAULT 'PENDING' CHECK (key_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'REVOKED')),
  key_permissions jsonb,
  billing_status  text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (billing_status IN ('ACTIVE', 'PAST_DUE', 'PAUSED_BILLING', 'CANCELED')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS biz.consents (
  client_id   uuid NOT NULL REFERENCES biz.clients(client_id),
  doc_type    text NOT NULL,
  doc_version text NOT NULL,
  doc_sha256  text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, doc_type, doc_version)
);

CREATE TABLE IF NOT EXISTS biz.subscriptions (
  client_id              uuid PRIMARY KEY REFERENCES biz.clients(client_id),
  stripe_customer_id     text UNIQUE,
  stripe_subscription_id text,
  tier                   text,
  status                 text,
  monthly_fee_usd        numeric,
  current_period_end     timestamptz,
  grace_until            timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS biz.billing_events (
  stripe_event_id text PRIMARY KEY,
  type            text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  payload         jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS biz.reports (
  report_id      bigserial PRIMARY KEY,
  client_id      uuid NOT NULL,
  period         text NOT NULL,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  channel        text NOT NULL,
  content_sha256 text,
  llm_model      text,
  compliance     jsonb,
  UNIQUE (client_id, period, channel)
);

CREATE TABLE IF NOT EXISTS pnl.daily (
  account_id  text NOT NULL,
  day         date NOT NULL,
  equity_usd  numeric,
  fees_usd    numeric,
  funding_usd numeric,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day)
);

-- ---------------------------------------------------------------------
-- oms: parent orders, execution events, positions, reconciliation
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oms.parent_orders (
  parent_order_id uuid PRIMARY KEY,
  decision_id     uuid NOT NULL UNIQUE REFERENCES risk.decisions(decision_id),
  cycle_id        text,
  account_id      text NOT NULL,
  strategy_id     text NOT NULL,
  symbol          text NOT NULL,
  venue           text NOT NULL,
  side            text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty             numeric NOT NULL CHECK (qty > 0),
  order_type      text NOT NULL DEFAULT 'LIMIT',
  limit_px        numeric,
  algo            text NOT NULL,
  algo_params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  urgency         text,
  reduce_only     boolean NOT NULL DEFAULT false,
  pair_id         text,
  status          text NOT NULL DEFAULT 'REGISTERED',
  status_reason   text,
  filled_qty      numeric NOT NULL DEFAULT 0,
  avg_px          numeric,
  arrival_mid     numeric,
  fees_usd        numeric NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parent_orders_account_created ON oms.parent_orders(account_id, created_at);

CREATE TABLE IF NOT EXISTS oms.execution_events (
  event_id        text PRIMARY KEY,
  parent_order_id uuid,
  account_id      text,
  venue           text,
  symbol          text,
  type            text NOT NULL,
  side            text,
  qty             numeric,
  px              numeric,
  fee_usd         numeric,
  ts              timestamptz NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms.positions (
  account_id text NOT NULL,
  venue      text NOT NULL,
  symbol     text NOT NULL,
  qty        numeric NOT NULL DEFAULT 0,
  avg_px     numeric,
  source     text NOT NULL DEFAULT 'internal',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, venue, symbol)
);

-- Attribution of positions to strategies (capacity and crowding limits).
CREATE TABLE IF NOT EXISTS oms.strategy_positions (
  account_id  text NOT NULL,
  strategy_id text NOT NULL,
  venue       text NOT NULL,
  symbol      text NOT NULL,
  qty         numeric NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, strategy_id, venue, symbol)
);

CREATE TABLE IF NOT EXISTS oms.recon_breaks (
  break_id       bigserial PRIMARY KEY,
  ts             timestamptz NOT NULL DEFAULT now(),
  account_id     text NOT NULL,
  venue          text NOT NULL,
  symbol         text NOT NULL,
  internal_qty   numeric,
  venue_qty      numeric,
  diff_qty       numeric,
  diff_usd       numeric,
  classification text NOT NULL,
  severity       text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  resolved       boolean NOT NULL DEFAULT false
);

-- Consumes risk tokens atomically. An order is created only if its decision
-- is OPEN, unexpired, approved, and matches account/venue/symbol/side, with
-- qty <= approved_qty. parent_order_id = decision_id, so the token is also the
-- end-to-end idempotency key the EMS uses.
CREATE OR REPLACE FUNCTION oms.submit_parent_orders(p jsonb)
RETURNS SETOF oms.parent_orders LANGUAGE plpgsql AS $$
DECLARE
  x     jsonb;
  d     risk.decisions%ROWTYPE;
  po    oms.parent_orders%ROWTYPE;
  v_qty numeric;
BEGIN
  FOR x IN SELECT o FROM jsonb_array_elements(coalesce(p->'orders', '[]'::jsonb)) o LOOP
    SELECT * INTO d FROM risk.decisions WHERE decision_id = (x->>'decision_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM ops.append_audit('oms', 'order.rejected.no_decision', x->>'decision_id', x);
      CONTINUE;
    END IF;
    v_qty := coalesce((x->>'qty')::numeric, d.approved_qty);
    IF d.status = 'OPEN' AND d.expires_at < now() THEN
      UPDATE risk.decisions SET status = 'EXPIRED' WHERE decision_id = d.decision_id;
      PERFORM ops.append_audit('oms', 'order.rejected.expired_token', d.decision_id::text, x);
      CONTINUE;
    END IF;
    IF d.status <> 'OPEN' OR d.decision NOT IN ('APPROVE', 'RESIZE')
       OR v_qty <= 0 OR v_qty > d.approved_qty
       OR d.account_id <> (x->>'account_id') OR d.symbol <> (x->>'symbol')
       OR d.side <> (x->>'side') OR d.venue <> (x->>'venue') THEN
      PERFORM ops.append_audit('oms', 'order.rejected.token_mismatch', d.decision_id::text,
                               jsonb_build_object('decision_status', d.status, 'requested', x));
      CONTINUE;
    END IF;
    UPDATE risk.decisions SET status = 'CONSUMED', consumed_at = now() WHERE decision_id = d.decision_id;
    INSERT INTO oms.parent_orders(parent_order_id, decision_id, cycle_id, account_id, strategy_id, symbol, venue,
                                  side, qty, order_type, limit_px, algo, algo_params, urgency, reduce_only,
                                  pair_id, arrival_mid)
    VALUES (d.decision_id, d.decision_id, d.cycle_id, d.account_id, d.strategy_id, d.symbol, d.venue,
            d.side, v_qty, coalesce(x->>'order_type', d.order_type, 'LIMIT'),
            coalesce((x->>'limit_px')::numeric, d.limit_px), coalesce(x->>'algo', 'TWAP'),
            coalesce(x->'algo_params', '{}'::jsonb), d.urgency, d.reduce_only, d.pair_id,
            coalesce((x->>'arrival_mid')::numeric, d.mark_px))
    RETURNING * INTO po;
    PERFORM ops.append_audit('oms', 'order.registered', po.parent_order_id::text,
                             jsonb_build_object('account_id', po.account_id, 'symbol', po.symbol,
                                                'side', po.side, 'qty', po.qty, 'algo', po.algo));
    RETURN NEXT po;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION oms.mark_sent(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH upd AS (
    UPDATE oms.parent_orders SET status = 'SENT', sent_at = now(), updated_at = now()
     WHERE parent_order_id IN (SELECT (jsonb_array_elements_text(coalesce(p->'parent_order_ids', '[]'::jsonb)))::uuid)
       AND status = 'REGISTERED'
    RETURNING 1)
  SELECT jsonb_build_object('updated', count(*)) FROM upd;
$$;

-- A failed or timed-out send does not prove the EMS never received the order.
-- Such orders become SEND_UNCONFIRMED: they are never re-sent blindly, they
-- count as in-flight exposure in the risk gate, and EMS events or
-- reconciliation resolve them. The supervisor pages if they linger.
CREATE OR REPLACE FUNCTION oms.mark_unconfirmed(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH upd AS (
    UPDATE oms.parent_orders SET status = 'SEND_UNCONFIRMED', status_reason = p->>'reason', updated_at = now()
     WHERE parent_order_id IN (SELECT (jsonb_array_elements_text(coalesce(p->'parent_order_ids', '[]'::jsonb)))::uuid)
       AND status = 'REGISTERED'
    RETURNING 1)
  SELECT jsonb_build_object('updated', count(*)) FROM upd;
$$;

CREATE OR REPLACE FUNCTION risk.mark_not_dispatched(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH upd AS (
    UPDATE risk.decisions SET status = 'NOT_DISPATCHED'
     WHERE decision_id IN (SELECT (jsonb_array_elements_text(coalesce(p->'decision_ids', '[]'::jsonb)))::uuid)
       AND status = 'OPEN'
    RETURNING 1)
  SELECT jsonb_build_object('updated', count(*), 'reason', p->>'reason') FROM upd;
$$;

-- Idempotent application of EMS execution events (fills, state changes,
-- liquidations/ADL, funding, fees).
CREATE OR REPLACE FUNCTION oms.apply_execution_events(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  e         jsonb;
  v_n       int;
  v_applied int := 0;
  v_dups    int := 0;
  v_notable jsonb := '[]'::jsonb;
  po        oms.parent_orders%ROWTYPE;
  v_type    text;
  v_qty     numeric;
  v_px      numeric;
  v_signed  numeric;
  v_old     numeric;
  v_old_avg numeric;
  v_new     numeric;
  v_avg     numeric;
  v_slip    numeric;
  v_alert   numeric := coalesce((p->>'slippage_alert_bps')::numeric, 25);
BEGIN
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(p->'events', '[]'::jsonb)) x
           ORDER BY (x->>'ts')::timestamptz, x->>'event_id' LOOP
    v_type := upper(e->>'type');
    v_qty  := (e->>'qty')::numeric;
    v_px   := (e->>'px')::numeric;
    INSERT INTO oms.execution_events(event_id, parent_order_id, account_id, venue, symbol, type, side, qty, px, fee_usd, ts, payload)
    VALUES (e->>'event_id', (e->>'parent_order_id')::uuid, e->>'account_id', e->>'venue', e->>'symbol', v_type,
            upper(e->>'side'), v_qty, v_px, (e->>'fee_usd')::numeric, (e->>'ts')::timestamptz, e)
    ON CONFLICT (event_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN v_dups := v_dups + 1; CONTINUE; END IF;
    v_applied := v_applied + 1;

    po := NULL;
    IF coalesce(e->>'parent_order_id', '') <> '' THEN
      SELECT * INTO po FROM oms.parent_orders WHERE parent_order_id = (e->>'parent_order_id')::uuid FOR UPDATE;
    END IF;

    IF v_type IN ('FILL', 'PARTIAL_FILL', 'LIQUIDATION', 'ADL') THEN
      v_signed := v_qty * CASE upper(e->>'side') WHEN 'BUY' THEN 1 ELSE -1 END;
      SELECT qty, avg_px INTO v_old, v_old_avg FROM oms.positions
       WHERE account_id = e->>'account_id' AND venue = e->>'venue' AND symbol = e->>'symbol' FOR UPDATE;
      v_old := coalesce(v_old, 0);
      v_new := v_old + v_signed;
      v_avg := CASE
                 WHEN v_new = 0 THEN NULL
                 WHEN v_old = 0 OR sign(v_old) <> sign(v_new) THEN v_px                    -- open or flip
                 WHEN sign(v_signed) = sign(v_old)
                   THEN (abs(v_old) * coalesce(v_old_avg, v_px) + abs(v_signed) * v_px) / abs(v_new)  -- add
                 ELSE v_old_avg END;                                                       -- reduce
      INSERT INTO oms.positions(account_id, venue, symbol, qty, avg_px, source, updated_at)
      VALUES (e->>'account_id', e->>'venue', e->>'symbol', v_new, v_avg, 'internal', now())
      ON CONFLICT (account_id, venue, symbol) DO UPDATE
         SET qty = EXCLUDED.qty, avg_px = EXCLUDED.avg_px, source = 'internal', updated_at = now();

      IF po.parent_order_id IS NOT NULL THEN
        INSERT INTO oms.strategy_positions(account_id, strategy_id, venue, symbol, qty)
        VALUES (po.account_id, po.strategy_id, po.venue, po.symbol, v_signed)
        ON CONFLICT (account_id, strategy_id, venue, symbol) DO UPDATE
           SET qty = oms.strategy_positions.qty + EXCLUDED.qty, updated_at = now();
        UPDATE oms.parent_orders
           SET avg_px     = (coalesce(avg_px, 0) * filled_qty + v_px * v_qty) / (filled_qty + v_qty),
               filled_qty = filled_qty + v_qty,
               fees_usd   = fees_usd + coalesce((e->>'fee_usd')::numeric, 0),
               status     = CASE WHEN filled_qty + v_qty >= qty * 0.999999 THEN 'FILLED' ELSE 'PARTIALLY_FILLED' END,
               updated_at = now()
         WHERE parent_order_id = po.parent_order_id;
        IF po.arrival_mid IS NOT NULL AND po.arrival_mid > 0 THEN
          v_slip := (v_px - po.arrival_mid) / po.arrival_mid * 10000 * CASE po.side WHEN 'BUY' THEN 1 ELSE -1 END;
          IF v_slip > v_alert THEN
            v_notable := v_notable || jsonb_build_object('kind', 'slippage', 'severity', 'SEV3',
                           'event_id', e->>'event_id', 'parent_order_id', po.parent_order_id,
                           'slippage_bps', round(v_slip, 2));
          END IF;
        END IF;
      END IF;

      IF v_type IN ('LIQUIDATION', 'ADL') THEN
        v_notable := v_notable || jsonb_build_object('kind', lower(v_type), 'severity', 'SEV1',
                       'event_id', e->>'event_id', 'account_id', e->>'account_id', 'venue', e->>'venue',
                       'symbol', e->>'symbol', 'qty', v_qty, 'px', v_px);
      END IF;

    ELSIF v_type IN ('ACK', 'WORKING', 'CANCELLED', 'REJECTED', 'EXPIRED') AND po.parent_order_id IS NOT NULL THEN
      UPDATE oms.parent_orders
         SET status = CASE v_type WHEN 'ACK' THEN 'WORKING' ELSE v_type END,
             status_reason = e->>'reason', updated_at = now()
       WHERE parent_order_id = po.parent_order_id
         AND status NOT IN ('FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED');
      IF v_type = 'REJECTED' THEN
        v_notable := v_notable || jsonb_build_object('kind', 'reject', 'severity', 'SEV2',
                       'event_id', e->>'event_id', 'parent_order_id', po.parent_order_id,
                       'reason', e->>'reason');
      END IF;
    END IF;
    -- FUNDING and FEE events are stored above and aggregated by pnl.close_day.
  END LOOP;
  PERFORM ops.touch_heartbeat('execution_events');
  RETURN jsonb_build_object('applied', v_applied, 'duplicates', v_dups, 'notable', v_notable);
END $$;

-- Venue snapshot vs internal book. Venue truth is adopted for every break
-- except short fill lag; each break is classified and returned.
CREATE OR REPLACE FUNCTION oms.reconcile(p jsonb)
RETURNS SETOF oms.recon_breaks LANGUAGE plpgsql AS $$
DECLARE
  a        jsonb;
  r        record;
  br       oms.recon_breaks%ROWTYPE;
  v_px     numeric;
  v_usd    numeric;
  v_eq     numeric;
  v_cls    text;
  v_sev    text;
  v_tol    numeric := coalesce((p->>'tolerance_usd')::numeric, 5);
BEGIN
  FOR a IN SELECT x FROM jsonb_array_elements(coalesce(p->'accounts', '[]'::jsonb)) x LOOP
    SELECT equity_usd INTO v_eq FROM risk.account_state WHERE account_id = a->>'account_id';
    FOR r IN
      WITH venue_pos AS (
             SELECT y->>'symbol' AS symbol, (y->>'qty')::numeric AS qty
               FROM jsonb_array_elements(coalesce(a->'positions', '[]'::jsonb)) y),
           internal AS (
             SELECT symbol, qty FROM oms.positions
              WHERE account_id = a->>'account_id' AND venue = a->>'venue')
      SELECT coalesce(v.symbol, i.symbol) AS symbol,
             coalesce(i.qty, 0)           AS internal_qty,
             coalesce(v.qty, 0)           AS venue_qty
        FROM venue_pos v FULL OUTER JOIN internal i ON i.symbol = v.symbol
       WHERE coalesce(v.qty, 0) <> coalesce(i.qty, 0)
    LOOP
      SELECT px INTO v_px FROM md.latest_mark WHERE venue = a->>'venue' AND symbol = r.symbol;
      v_usd := abs(r.venue_qty - r.internal_qty) * coalesce(v_px, 0);
      CONTINUE WHEN v_px IS NOT NULL AND v_usd < v_tol;

      IF coalesce((a->>'external_orders_count')::int, 0) > 0 OR coalesce((a->>'external_fills_count')::int, 0) > 0 THEN
        v_cls := 'external_activity';
      ELSIF EXISTS (SELECT 1 FROM oms.parent_orders o
                     WHERE o.account_id = a->>'account_id' AND o.venue = a->>'venue' AND o.symbol = r.symbol
                       AND o.status IN ('SENT', 'WORKING', 'PARTIALLY_FILLED')
                       AND o.updated_at > now() - interval '10 minutes') THEN
        v_cls := 'fill_lag';
      ELSE
        v_cls := 'unknown';
      END IF;
      v_sev := CASE
                 WHEN v_cls = 'fill_lag' THEN 'LOW'
                 WHEN v_px IS NULL OR v_usd >= greatest(1000, 0.01 * coalesce(v_eq, 0)) THEN 'HIGH'
                 ELSE 'MEDIUM' END;

      INSERT INTO oms.recon_breaks(account_id, venue, symbol, internal_qty, venue_qty, diff_qty, diff_usd,
                                   classification, severity)
      VALUES (a->>'account_id', a->>'venue', r.symbol, r.internal_qty, r.venue_qty,
              r.venue_qty - r.internal_qty, round(v_usd, 2), v_cls, v_sev)
      RETURNING * INTO br;

      IF v_cls <> 'fill_lag' THEN
        INSERT INTO oms.positions(account_id, venue, symbol, qty, source, updated_at)
        VALUES (a->>'account_id', a->>'venue', r.symbol, r.venue_qty, 'venue_recon', now())
        ON CONFLICT (account_id, venue, symbol) DO UPDATE
           SET qty = EXCLUDED.qty, source = 'venue_recon', updated_at = now();
        UPDATE oms.recon_breaks SET resolved = true WHERE break_id = br.break_id;
        br.resolved := true;
        PERFORM ops.append_audit('reconciliation', 'oms.adopt_venue_truth',
                                 (a->>'account_id') || ':' || (a->>'venue') || ':' || r.symbol, to_jsonb(br));
      END IF;
      RETURN NEXT br;
    END LOOP;
  END LOOP;
  PERFORM ops.touch_heartbeat('reconciliation');
END $$;

-- ---------------------------------------------------------------------
-- risk: gate context, decisions, snapshots, breakers, ratcheted limit changes
-- ---------------------------------------------------------------------

-- Everything the pre-trade gate needs, in one round trip.
CREATE OR REPLACE FUNCTION risk.gate_context(p jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH lim AS (
  SELECT limits_version, doc FROM risk.current_limits
), marks AS (
  SELECT m.venue, m.symbol, m.symbol || '@' || m.venue AS k, m.px,
         extract(epoch FROM now() - m.ts) AS age_s
    FROM md.latest_mark m
), pos AS (
  SELECT ps.account_id, ps.venue, ps.symbol, ps.qty, ps.qty * mk.px AS notional_usd
    FROM oms.positions ps
    LEFT JOIN marks mk ON mk.venue = ps.venue AND mk.symbol = ps.symbol
   WHERE ps.account_id IN (SELECT jsonb_array_elements_text(coalesce(p->'accounts', '[]'::jsonb))) AND ps.qty <> 0
), acct AS (
  SELECT a.account_id,
         coalesce(l.limits, '{}'::jsonb) || jsonb_build_object(
           'mode', coalesce((SELECT mode FROM risk.modes WHERE scope = 'account' AND scope_id = a.account_id), 'NORMAL'),
           'billing_status', a.billing_status,
           'key_status', a.key_status,
           'equity_usd', s.equity_usd,
           'day_pnl_pct', CASE WHEN s.day_start_equity_usd > 0 THEN s.equity_usd / s.day_start_equity_usd - 1 END,
           'drawdown_pct', CASE WHEN s.hwm_equity_usd > 0 THEN 1 - s.equity_usd / s.hwm_equity_usd END,
           'gross_exposure_usd', coalesce((SELECT sum(abs(notional_usd)) FROM pos WHERE pos.account_id = a.account_id), 0),
           'net_exposure_usd', coalesce((SELECT sum(notional_usd) FROM pos WHERE pos.account_id = a.account_id), 0),
           'positions', coalesce((SELECT jsonb_object_agg(pos.symbol || '@' || pos.venue,
                                          jsonb_build_object('qty', pos.qty, 'notional_usd', pos.notional_usd))
                                    FROM pos WHERE pos.account_id = a.account_id), '{}'::jsonb),
           'venue_exposure_usd', coalesce((SELECT jsonb_object_agg(v.venue, v.g)
                                             FROM (SELECT venue, sum(abs(notional_usd)) AS g FROM pos
                                                    WHERE pos.account_id = a.account_id GROUP BY venue) v), '{}'::jsonb),
           'orders_last_min', (SELECT count(*) FROM oms.parent_orders o
                                WHERE o.account_id = a.account_id AND o.created_at > now() - interval '60 seconds'),
           -- In-flight orders count as if filled when checking exposure limits.
           'pending', coalesce((SELECT jsonb_object_agg(k, q)
                                  FROM (SELECT o.symbol || '@' || o.venue AS k,
                                               sum((o.qty - o.filled_qty) * CASE o.side WHEN 'BUY' THEN 1 ELSE -1 END) AS q
                                          FROM oms.parent_orders o
                                         WHERE o.account_id = a.account_id
                                           AND o.status IN ('REGISTERED', 'SENT', 'WORKING', 'PARTIALLY_FILLED', 'SEND_UNCONFIRMED')
                                         GROUP BY 1) w), '{}'::jsonb)
         ) AS ctx
    FROM biz.accounts a
    LEFT JOIN risk.account_state s ON s.account_id = a.account_id
    LEFT JOIN risk.account_limits l ON l.account_id = a.account_id
   WHERE a.account_id IN (SELECT jsonb_array_elements_text(coalesce(p->'accounts', '[]'::jsonb)))
), strat AS (
  SELECT j.key AS strategy_id,
         j.value || jsonb_build_object(
           'mode', coalesce((SELECT mode FROM risk.modes WHERE scope = 'strategy' AND scope_id = j.key), 'NORMAL'),
           'gross_usd', coalesce((SELECT sum(abs(sp.qty * mk.px)) FROM oms.strategy_positions sp
                                    JOIN marks mk ON mk.venue = sp.venue AND mk.symbol = sp.symbol
                                   WHERE sp.strategy_id = j.key), 0)) AS ctx
    FROM lim, jsonb_each(coalesce(lim.doc->'strategies', '{}'::jsonb)) j
)
SELECT jsonb_build_object(
  'limits_version', (SELECT limits_version FROM lim),
  'state_version',  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'global', coalesce((SELECT doc->'global' FROM lim), '{}'::jsonb)
            || jsonb_build_object('mode', coalesce((SELECT mode FROM risk.modes WHERE scope = 'global' AND scope_id = '*'), 'NORMAL')),
  'accounts', coalesce((SELECT jsonb_object_agg(account_id, ctx) FROM acct), '{}'::jsonb),
  -- Marks for proposed symbols plus everything the requested accounts hold or
  -- have in flight, so the gate can value every position it reasons about.
  'marks', coalesce((SELECT jsonb_object_agg(k, jsonb_build_object('px', px, 'age_s', round(age_s::numeric, 3)))
                       FROM marks
                      WHERE symbol IN (SELECT jsonb_array_elements_text(coalesce(p->'symbols', '[]'::jsonb)))
                         OR k IN (SELECT ps.symbol || '@' || ps.venue FROM oms.positions ps
                                   WHERE ps.qty <> 0 AND ps.account_id IN (SELECT jsonb_array_elements_text(coalesce(p->'accounts', '[]'::jsonb))))
                         OR k IN (SELECT o.symbol || '@' || o.venue FROM oms.parent_orders o
                                   WHERE o.status IN ('REGISTERED', 'SENT', 'WORKING', 'PARTIALLY_FILLED', 'SEND_UNCONFIRMED')
                                     AND o.account_id IN (SELECT jsonb_array_elements_text(coalesce(p->'accounts', '[]'::jsonb))))),
                    '{}'::jsonb),
  'strategies', coalesce((SELECT jsonb_object_agg(strategy_id, ctx) FROM strat), '{}'::jsonb),
  'venues', coalesce((SELECT jsonb_object_agg(scope_id, jsonb_build_object('mode', mode))
                        FROM risk.modes WHERE scope = 'venue'), '{}'::jsonb)
);
$$;

-- Records gate decisions. Duplicates (same proposal_id) are ignored and NOT
-- returned, so a retried gate can never dispatch the same proposal twice.
CREATE OR REPLACE FUNCTION risk.record_decisions(p jsonb)
RETURNS SETOF risk.decisions LANGUAGE sql AS $$
  WITH ttl AS (
    SELECT coalesce((SELECT (doc->'global'->>'decision_ttl_s')::int FROM risk.current_limits), 90) AS s
  ), ins AS (
    INSERT INTO risk.decisions(proposal_id, cycle_id, account_id, strategy_id, symbol, venue, side, requested_qty,
                               approved_qty, decision, order_type, limit_px, urgency, reduce_only, pair_id, mark_px,
                               reasons, checks, escalate, limits_version, state_version, expires_at, status)
    SELECT x->>'proposal_id', x->>'cycle_id', x->>'account_id', x->>'strategy_id', x->>'symbol', x->>'venue',
           upper(x->>'side'), (x->>'requested_qty')::numeric, coalesce((x->>'approved_qty')::numeric, 0),
           upper(x->>'decision'), x->>'order_type', (x->>'limit_px')::numeric, x->>'urgency',
           coalesce((x->>'reduce_only')::boolean, false), x->>'pair_id', (x->>'mark_px')::numeric,
           coalesce(x->'reasons', '[]'::jsonb), coalesce(x->'checks', '[]'::jsonb),
           CASE WHEN jsonb_typeof(x->'escalate') = 'object' THEN x->'escalate' END,
           x->>'limits_version', x->>'state_version', now() + make_interval(secs => (SELECT s FROM ttl)),
           CASE WHEN upper(x->>'decision') = 'REJECT' THEN 'CLOSED' ELSE 'OPEN' END
      FROM jsonb_array_elements(coalesce(p->'decisions', '[]'::jsonb)) x
    ON CONFLICT (proposal_id) DO NOTHING
    RETURNING *)
  SELECT * FROM ins;
$$;

-- Degraded snapshot used when the risk service is unavailable: no VaR/ES,
-- which the breaker policy treats as "risk not measurable".
CREATE OR REPLACE FUNCTION risk.snapshot_basic(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH pos AS (
  SELECT ps.account_id, ps.venue, ps.qty * m.px AS notional, extract(epoch FROM now() - m.ts) AS age
    FROM oms.positions ps JOIN md.latest_mark m ON m.venue = ps.venue AND m.symbol = ps.symbol
   WHERE ps.qty <> 0
), acc AS (
  SELECT a.account_id, s.equity_usd,
         CASE WHEN s.day_start_equity_usd > 0 THEN s.equity_usd / s.day_start_equity_usd - 1 END AS day_pnl_pct,
         CASE WHEN s.hwm_equity_usd > 0 THEN 1 - s.equity_usd / s.hwm_equity_usd END AS drawdown_pct,
         coalesce((SELECT sum(abs(notional)) FROM pos WHERE pos.account_id = a.account_id), 0)
           / NULLIF(s.equity_usd, 0) AS gross_leverage,
         (l.limits->>'daily_loss_limit_pct')::numeric AS daily_loss_limit_pct,
         (l.limits->>'max_drawdown_pct')::numeric AS max_drawdown_pct,
         coalesce((l.limits->>'auto_flatten_on_max_dd')::boolean, false) AS auto_flatten_on_max_dd
    FROM biz.accounts a
    JOIN risk.account_state s ON s.account_id = a.account_id
    LEFT JOIN risk.account_limits l ON l.account_id = a.account_id
)
SELECT jsonb_build_object(
  'source', 'db_fallback',
  'ts', now(),
  'global', jsonb_build_object('max_mark_age_s', (SELECT round(max(age)::numeric, 1) FROM pos)),
  'accounts', coalesce((SELECT jsonb_agg(to_jsonb(acc)) FROM acc), '[]'::jsonb),
  'venues', '[]'::jsonb);
$$;

CREATE OR REPLACE FUNCTION risk.breaker_context(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM ops.touch_heartbeat('risk_monitor');
  SELECT jsonb_build_object(
    'policy', coalesce((SELECT doc->'breakers' FROM risk.current_limits), '{}'::jsonb),
    'limits_version', (SELECT limits_version FROM risk.current_limits),
    'modes', coalesce((SELECT jsonb_agg(jsonb_build_object('scope', scope, 'scope_id', scope_id, 'mode', mode, 'reason', reason))
                         FROM risk.modes), '[]'::jsonb),
    'monitor', (SELECT jsonb_build_object('last_source', last_source, 'fallback_streak', fallback_streak)
                  FROM risk.monitor_state WHERE id = 1),
    'recent_fingerprints', coalesce((SELECT jsonb_agg(DISTINCT fingerprint) FROM risk.breaches
                                      WHERE ts > now() - interval '30 minutes' AND fingerprint IS NOT NULL), '[]'::jsonb))
  INTO v;
  RETURN v;
END $$;

-- Applies breaker actions (mode changes only; flatten/cancel is executed by
-- the kill-switch workflow). Records every breach; returns what changed.
CREATE OR REPLACE FUNCTION risk.apply_actions(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  a         jsonb;
  res       jsonb;
  v_changed jsonb := '[]'::jsonb;
  v_same    jsonb := '[]'::jsonb;
BEGIN
  IF p->>'snapshot_source' IN ('risk_svc', 'db_fallback') THEN
    UPDATE risk.monitor_state
       SET last_source = p->>'snapshot_source',
           fallback_streak = CASE WHEN p->>'snapshot_source' = 'db_fallback' THEN fallback_streak + 1 ELSE 0 END,
           updated_at = now()
     WHERE id = 1;
  END IF;
  FOR a IN SELECT x FROM jsonb_array_elements(coalesce(p->'actions', '[]'::jsonb)) x LOOP
    -- Kill actions (action, no mode) are recorded too, so their fingerprints
    -- suppress repeats from the 15-second monitor.
    INSERT INTO risk.breaches(scope, scope_id, tier, metric, value, limit_value, action, fingerprint)
    VALUES (a->>'scope', coalesce(a->>'scope_id', '*'), coalesce(a->>'tier', 'unknown'), a->>'metric',
            (a->>'value')::numeric, (a->>'limit')::numeric, coalesce(a->>'mode', a->>'action'),
            coalesce(a->>'fingerprint', p->>'fingerprint'));
    IF a ? 'mode' THEN
      res := risk.apply_mode(jsonb_build_object('scope', a->>'scope', 'scope_id', coalesce(a->>'scope_id', '*'),
                                                'mode', a->>'mode', 'reason', a->>'reason', 'set_by', 'risk_monitor'));
      IF (res->>'changed')::boolean THEN v_changed := v_changed || res; ELSE v_same := v_same || res; END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('changed', v_changed, 'unchanged', v_same);
END $$;

-- AI agents may only tighten limits. max_* limits tighten downwards, min_*
-- limits tighten upwards; anything else is queued for a human.
-- SECURITY DEFINER: the read-only agent role may call this one function, which
-- runs with the owner's rights and can only tighten.
CREATE OR REPLACE FUNCTION risk.propose_limit_change(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_scope  text := p->>'scope';
  v_id     text := coalesce(p->>'scope_id', '*');
  v_name   text := p->>'limit_name';
  v_new    numeric := (p->>'new_value')::numeric;
  v_old    numeric;
  v_ok     boolean;
  v_status text;
  v_ver    text;
  v_doc    jsonb;
BEGIN
  IF v_name IS NULL OR v_new IS NULL THEN RAISE EXCEPTION 'limit_name and new_value are required'; END IF;
  IF v_scope = 'account' THEN
    SELECT (limits->>v_name)::numeric INTO v_old FROM risk.account_limits WHERE account_id = v_id;
  ELSIF v_scope = 'strategy' THEN
    SELECT (doc->'strategies'->v_id->>v_name)::numeric INTO v_old FROM risk.current_limits;
  ELSIF v_scope = 'global' THEN
    SELECT (doc->'global'->>v_name)::numeric INTO v_old FROM risk.current_limits;
  ELSE
    RAISE EXCEPTION 'unsupported scope %', v_scope;
  END IF;

  v_ok := v_old IS NOT NULL AND (
            (v_name LIKE 'max\_%' AND v_new < v_old AND v_new >= 0) OR
            (v_name LIKE 'min\_%' AND v_new > v_old));
  v_status := CASE WHEN v_ok THEN 'APPLIED' ELSE 'PENDING_HUMAN' END;

  IF v_ok THEN
    IF v_scope = 'account' THEN
      UPDATE risk.account_limits SET limits = jsonb_set(limits, ARRAY[v_name], to_jsonb(v_new)),
             version = version + 1, updated_at = now()
       WHERE account_id = v_id;
    ELSE
      SELECT doc INTO v_doc FROM risk.current_limits;
      v_doc := CASE WHEN v_scope = 'global' THEN jsonb_set(v_doc, ARRAY['global', v_name], to_jsonb(v_new))
                    ELSE jsonb_set(v_doc, ARRAY['strategies', v_id, v_name], to_jsonb(v_new)) END;
      v_ver := (SELECT limits_version FROM risk.current_limits) || '+t' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
      INSERT INTO risk.limits(limits_version, effective_at, created_by, doc)
      VALUES (v_ver, clock_timestamp(), coalesce(p->>'requested_by', 'agent'), v_doc);
    END IF;
  END IF;

  INSERT INTO risk.limit_change_requests(scope, scope_id, limit_name, old_value, new_value, rationale, requested_by, status, applied_at)
  VALUES (v_scope, v_id, v_name, v_old, v_new, left(p->>'rationale', 2000), coalesce(p->>'requested_by', 'agent'),
          v_status, CASE WHEN v_ok THEN now() END);
  PERFORM ops.append_audit(coalesce(p->>'requested_by', 'agent'), 'risk.limit_change.' || lower(v_status),
                           v_scope || ':' || v_id || ':' || v_name,
                           jsonb_build_object('old', v_old, 'new', v_new, 'rationale', p->>'rationale'));
  RETURN jsonb_build_object('status', v_status, 'scope', v_scope, 'scope_id', v_id, 'limit_name', v_name,
                            'old_value', v_old, 'new_value', v_new, 'new_limits_version', v_ver);
END $$;

-- ---------------------------------------------------------------------
-- alpha: signal cycles (idempotent claim), predictions, proposals
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alpha.cycles (
  cycle_id     text PRIMARY KEY,
  strategy_set text NOT NULL,
  bar_ts       timestamptz NOT NULL,
  trigger      text,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'CLAIMED',
  gates        jsonb,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  finished_at  timestamptz
);

CREATE TABLE IF NOT EXISTS alpha.predictions (
  cycle_id      text NOT NULL REFERENCES alpha.cycles(cycle_id),
  model_id      text NOT NULL,
  model_version text NOT NULL,
  symbol        text NOT NULL,
  horizon       text NOT NULL,
  mu            numeric,
  sigma         numeric,
  p_up          numeric,
  q05           numeric,
  q50           numeric,
  q95           numeric,
  PRIMARY KEY (cycle_id, model_id, symbol, horizon)
);

CREATE TABLE IF NOT EXISTS alpha.proposals (
  proposal_id text PRIMARY KEY,
  cycle_id    text NOT NULL REFERENCES alpha.cycles(cycle_id),
  account_id  text NOT NULL,
  strategy_id text NOT NULL,
  symbol      text NOT NULL,
  venue       text NOT NULL,
  side        text NOT NULL,
  qty         numeric NOT NULL,
  order_type  text,
  limit_px    numeric,
  urgency     text,
  pair_id     text,
  reduce_only boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION alpha.claim_cycle(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  INSERT INTO alpha.cycles(cycle_id, strategy_set, bar_ts, trigger, gates)
  VALUES (p->>'cycle_id', coalesce(p->>'strategy_set', 'core'), (p->>'bar_ts')::timestamptz, p->>'trigger', p->'gates')
  ON CONFLICT (cycle_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN PERFORM ops.touch_heartbeat('signal_cycle'); END IF;
  RETURN jsonb_build_object('claimed', v_n = 1, 'cycle_id', p->>'cycle_id');
END $$;

CREATE OR REPLACE FUNCTION alpha.mark_cycle(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH upd AS (
    UPDATE alpha.cycles
       SET status = p->>'status',
           detail = detail || coalesce(p->'detail', '{}'::jsonb),
           finished_at = CASE WHEN p->>'status' <> 'RUNNING' THEN now() END
     WHERE cycle_id = p->>'cycle_id'
    RETURNING cycle_id, status)
  SELECT coalesce((SELECT jsonb_build_object('cycle_id', cycle_id, 'status', status) FROM upd),
                  jsonb_build_object('cycle_id', p->>'cycle_id', 'status', 'NOT_FOUND'));
$$;

CREATE OR REPLACE FUNCTION alpha.record_cycle_outputs(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_pred int; v_prop int;
BEGIN
  INSERT INTO alpha.predictions(cycle_id, model_id, model_version, symbol, horizon, mu, sigma, p_up, q05, q50, q95)
  SELECT p->>'cycle_id', x->>'model_id', x->>'model_version', x->>'symbol', x->>'horizon',
         (x->>'mu')::numeric, (x->>'sigma')::numeric, (x->>'p_up')::numeric,
         (x->>'q05')::numeric, (x->>'q50')::numeric, (x->>'q95')::numeric
    FROM jsonb_array_elements(coalesce(p->'predictions', '[]'::jsonb)) x
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_pred = ROW_COUNT;
  INSERT INTO alpha.proposals(proposal_id, cycle_id, account_id, strategy_id, symbol, venue, side, qty, order_type,
                              limit_px, urgency, pair_id, reduce_only)
  SELECT x->>'proposal_id', p->>'cycle_id', x->>'account_id', x->>'strategy_id', x->>'symbol', x->>'venue',
         upper(x->>'side'), (x->>'qty')::numeric, x->>'order_type', (x->>'limit_px')::numeric, x->>'urgency',
         x->>'pair_id', coalesce((x->>'reduce_only')::boolean, false)
    FROM jsonb_array_elements(coalesce(p->'proposals', '[]'::jsonb)) x
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_prop = ROW_COUNT;
  UPDATE alpha.cycles SET status = 'RUNNING' WHERE cycle_id = p->>'cycle_id' AND status = 'CLAIMED';
  RETURN jsonb_build_object('predictions', v_pred, 'proposals', v_prop);
END $$;

CREATE OR REPLACE FUNCTION alpha.finish_cycle(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
           'cycle_id', p->>'cycle_id',
           'proposals', (SELECT count(*) FROM alpha.proposals WHERE cycle_id = p->>'cycle_id'),
           'approved', count(*) FILTER (WHERE decision = 'APPROVE'),
           'resized', count(*) FILTER (WHERE decision = 'RESIZE'),
           'rejected', count(*) FILTER (WHERE decision = 'REJECT'),
           'escalations', count(*) FILTER (WHERE escalate IS NOT NULL),
           'orders_registered', (SELECT count(*) FROM oms.parent_orders WHERE cycle_id = p->>'cycle_id'))
    INTO v
    FROM risk.decisions WHERE cycle_id = p->>'cycle_id';
  UPDATE alpha.cycles SET status = 'COMPLETED', finished_at = now(), detail = detail || jsonb_build_object('summary', v)
   WHERE cycle_id = p->>'cycle_id';
  RETURN v;
END $$;

-- ---------------------------------------------------------------------
-- pm: targets, drift, strategy allocations with bounded autonomy
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm.targets (
  account_id    text NOT NULL,
  strategy_id   text NOT NULL,
  venue         text NOT NULL,
  symbol        text NOT NULL,
  target_weight numeric NOT NULL,
  no_trade_band numeric NOT NULL DEFAULT 0.02,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, strategy_id, venue, symbol)
);

CREATE OR REPLACE FUNCTION pm.drift_report(p jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(account_id text, max_abs_drift numeric, drifted jsonb) LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT tg.account_id, tg.venue, tg.symbol, sum(tg.target_weight) AS tw, min(tg.no_trade_band) AS band
      FROM pm.targets tg GROUP BY 1, 2, 3
  ), cur AS (
    SELECT ps.account_id, ps.venue, ps.symbol, ps.qty * m.px / NULLIF(s.equity_usd, 0) AS cw
      FROM oms.positions ps
      JOIN md.latest_mark m ON m.venue = ps.venue AND m.symbol = ps.symbol
      JOIN risk.account_state s ON s.account_id = ps.account_id
  ), d AS (
    SELECT coalesce(t.account_id, cur.account_id) AS acc, coalesce(t.venue, cur.venue) AS venue,
           coalesce(t.symbol, cur.symbol) AS symbol, coalesce(t.tw, 0) AS tw, coalesce(cur.cw, 0) AS cw,
           coalesce(t.band, 0.02) AS band
      FROM t FULL OUTER JOIN cur ON cur.account_id = t.account_id AND cur.venue = t.venue AND cur.symbol = t.symbol
  )
  SELECT acc, round(max(abs(cw - tw)), 6),
         jsonb_agg(jsonb_build_object('venue', venue, 'symbol', symbol,
                                      'target_w', round(tw, 6), 'current_w', round(cw, 6)))
           FILTER (WHERE abs(cw - tw) > band)
    FROM d GROUP BY acc HAVING bool_or(abs(cw - tw) > band);
$$;

CREATE TABLE IF NOT EXISTS pm.strategy_allocations (
  version_id           bigserial PRIMARY KEY,
  created_at           timestamptz NOT NULL DEFAULT now(),
  weights              jsonb NOT NULL,
  status               text NOT NULL CHECK (status IN ('ACTIVE', 'STAGED', 'REJECTED', 'SUPERSEDED', 'EXPIRED')),
  proposed_by          text,
  approved_by          text,
  rationale            text,
  approval_token_sha256 text,
  approval_expires_at  timestamptz
);

CREATE OR REPLACE FUNCTION pm.apply_allocation(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  UPDATE pm.strategy_allocations SET status = 'SUPERSEDED' WHERE status = 'ACTIVE';
  INSERT INTO pm.strategy_allocations(weights, status, proposed_by, approved_by, rationale)
  VALUES (p->'weights', 'ACTIVE', coalesce(p->>'proposed_by', 'meta_learner'), coalesce(p->>'approved_by', 'policy:bounded_change'), p->>'rationale')
  RETURNING version_id INTO v_id;
  PERFORM ops.append_audit(coalesce(p->>'proposed_by', 'meta_learner'), 'pm.allocation.applied', v_id::text, p);
  RETURN jsonb_build_object('version_id', v_id, 'status', 'ACTIVE');
END $$;

CREATE OR REPLACE FUNCTION pm.stage_allocation(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  IF length(coalesce(p->>'token', '')) < 32 THEN RAISE EXCEPTION 'approval token must be at least 32 characters'; END IF;
  INSERT INTO pm.strategy_allocations(weights, status, proposed_by, rationale, approval_token_sha256, approval_expires_at)
  VALUES (p->'weights', 'STAGED', coalesce(p->>'proposed_by', 'meta_learner'), p->>'rationale',
          encode(sha256(convert_to(p->>'token', 'UTF8')), 'hex'),
          now() + make_interval(secs => coalesce((p->>'ttl_s')::int, 14400)))
  RETURNING version_id INTO v_id;
  RETURN jsonb_build_object('version_id', v_id, 'status', 'STAGED');
END $$;

CREATE OR REPLACE FUNCTION pm.verify_approval(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r pm.strategy_allocations%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pm.strategy_allocations WHERE version_id = (p->>'version_id')::bigint FOR UPDATE;
  IF NOT FOUND OR r.status <> 'STAGED' THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'not_staged');
  END IF;
  IF r.approval_expires_at < now() THEN
    UPDATE pm.strategy_allocations SET status = 'EXPIRED' WHERE version_id = r.version_id;
    RETURN jsonb_build_object('approved', false, 'reason', 'expired');
  END IF;
  IF r.approval_token_sha256 <> encode(sha256(convert_to(coalesce(p->>'token', ''), 'UTF8')), 'hex') THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'bad_token');
  END IF;
  IF lower(coalesce(p->>'decision', '')) <> 'approve' THEN
    UPDATE pm.strategy_allocations SET status = 'REJECTED', approved_by = p->>'approver' WHERE version_id = r.version_id;
    RETURN jsonb_build_object('approved', false, 'reason', 'rejected_by_human');
  END IF;
  UPDATE pm.strategy_allocations SET status = 'SUPERSEDED' WHERE status = 'ACTIVE';
  UPDATE pm.strategy_allocations SET status = 'ACTIVE', approved_by = coalesce(p->>'approver', 'human')
   WHERE version_id = r.version_id;
  PERFORM ops.append_audit(coalesce(p->>'approver', 'human'), 'pm.allocation.approved', r.version_id::text, r.weights);
  RETURN jsonb_build_object('approved', true, 'version_id', r.version_id);
END $$;

-- ---------------------------------------------------------------------
-- research: memos, trial ledger (multiple-testing accounting), lifecycle
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS research.model_registry_mirror (
  model_id           text PRIMARY KEY,
  strategy_family    text,
  stage              text NOT NULL CHECK (stage IN ('research', 'shadow', 'paper', 'pilot', 'production', 'retired')),
  live_vs_backtest_z numeric,
  psi_max            numeric,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research.trial_ledger (
  trial_id          bigserial PRIMARY KEY,
  ts                timestamptz NOT NULL DEFAULT now(),
  hypothesis_family text NOT NULL,
  spec              jsonb NOT NULL,
  result            jsonb
);

CREATE TABLE IF NOT EXISTS research.memos (
  memo_id bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  model   text,
  memo    jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS research.transition_requests (
  request_id   bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  model_id     text NOT NULL,
  from_stage   text,
  to_stage     text NOT NULL,
  rationale    text,
  evidence     jsonb,
  requested_by text,
  status       text NOT NULL CHECK (status IN ('AUTO_APPROVED', 'PENDING_HUMAN', 'APPROVED', 'REJECTED')),
  decided_by   text,
  decided_at   timestamptz
);

CREATE OR REPLACE FUNCTION research.stage_rank(s text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s WHEN 'retired' THEN 0 WHEN 'research' THEN 1 WHEN 'shadow' THEN 2 WHEN 'paper' THEN 3
                WHEN 'pilot' THEN 4 WHEN 'production' THEN 5 END
$$;

CREATE OR REPLACE FUNCTION research.agent_brief(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'models', coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.model_id) FROM research.model_registry_mirror m), '[]'::jsonb),
    'trial_counts', coalesce((SELECT jsonb_object_agg(hypothesis_family, n)
                                FROM (SELECT hypothesis_family, count(*) AS n FROM research.trial_ledger GROUP BY 1) t), '{}'::jsonb),
    'pending_transitions', coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM research.transition_requests r
                                      WHERE r.status = 'PENDING_HUMAN'), '[]'::jsonb),
    'last_memo', (SELECT memo FROM research.memos ORDER BY memo_id DESC LIMIT 1));
$$;

CREATE OR REPLACE FUNCTION research.save_memo(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH ins AS (INSERT INTO research.memos(model, memo) VALUES (p->>'model', coalesce(p->'memo', p)) RETURNING memo_id)
  SELECT jsonb_build_object('memo_id', memo_id) FROM ins;
$$;

-- Demotions and moves into paper trading carry no capital risk and are
-- auto-approved. Pilot and production capital always needs a human.
CREATE OR REPLACE FUNCTION research.propose_transition(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_from   text;
  v_to     text := p->>'to_stage';
  v_status text;
  v_id     bigint;
BEGIN
  SELECT stage INTO v_from FROM research.model_registry_mirror WHERE model_id = p->>'model_id' FOR UPDATE;
  IF v_from IS NULL THEN RAISE EXCEPTION 'unknown model %', p->>'model_id'; END IF;
  IF research.stage_rank(v_to) IS NULL THEN RAISE EXCEPTION 'unknown stage %', v_to; END IF;
  v_status := CASE WHEN research.stage_rank(v_to) <= research.stage_rank(v_from) OR v_to IN ('shadow', 'paper')
                   THEN 'AUTO_APPROVED' ELSE 'PENDING_HUMAN' END;
  INSERT INTO research.transition_requests(model_id, from_stage, to_stage, rationale, evidence, requested_by, status, decided_by, decided_at)
  VALUES (p->>'model_id', v_from, v_to, left(p->>'rationale', 4000), p->'evidence', coalesce(p->>'requested_by', 'research_agent'),
          v_status, CASE WHEN v_status = 'AUTO_APPROVED' THEN 'policy:ratchet' END,
          CASE WHEN v_status = 'AUTO_APPROVED' THEN now() END)
  RETURNING request_id INTO v_id;
  IF v_status = 'AUTO_APPROVED' THEN
    UPDATE research.model_registry_mirror SET stage = v_to, updated_at = now() WHERE model_id = p->>'model_id';
  END IF;
  PERFORM ops.append_audit(coalesce(p->>'requested_by', 'research_agent'), 'research.transition.' || lower(v_status),
                           p->>'model_id', jsonb_build_object('from', v_from, 'to', v_to));
  RETURN jsonb_build_object('request_id', v_id, 'status', v_status, 'from_stage', v_from, 'to_stage', v_to);
END $$;

-- ---------------------------------------------------------------------
-- biz functions: onboarding, keys, graduation, billing, fee burden, reports
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION biz.create_client(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_id     uuid;
  v_status text := coalesce(p->>'status', 'PENDING_REVIEW');
  c        jsonb;
BEGIN
  INSERT INTO biz.clients(external_ref, email, jurisdiction, status, screening, risk_profile, appropriateness_score, tier, quiz_passed_at)
  VALUES (p->>'external_ref', p->>'email', p->>'jurisdiction', v_status, p->'screening', p->>'risk_profile',
          (p->>'appropriateness_score')::int, coalesce(p->>'tier', 'LAB'),
          CASE WHEN coalesce((p->>'quiz_passed')::boolean, false) THEN now() END)
  ON CONFLICT (external_ref) DO UPDATE SET email = EXCLUDED.email
  RETURNING client_id INTO v_id;
  FOR c IN SELECT x FROM jsonb_array_elements(coalesce(p->'consents', '[]'::jsonb)) x LOOP
    INSERT INTO biz.consents(client_id, doc_type, doc_version, doc_sha256)
    VALUES (v_id, c->>'doc_type', c->>'doc_version', c->>'doc_sha256') ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM ops.append_audit('onboarding', 'biz.client.created', v_id::text,
                           jsonb_build_object('status', v_status, 'jurisdiction', p->>'jurisdiction'));
  RETURN jsonb_build_object('client_id', v_id, 'status', v_status);
END $$;

CREATE OR REPLACE FUNCTION biz.mark_key_status(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO biz.accounts(account_id, client_id, venue, key_ref, key_status, key_permissions)
  VALUES (p->>'account_id', (p->>'client_id')::uuid, p->>'venue', p->>'key_ref', p->>'status', p->'permissions')
  ON CONFLICT (account_id) DO UPDATE
     SET key_ref = EXCLUDED.key_ref, key_status = EXCLUDED.key_status, key_permissions = EXCLUDED.key_permissions;
  PERFORM ops.append_audit('onboarding', 'biz.key.' || lower(p->>'status'), p->>'account_id', p->'permissions');
  RETURN jsonb_build_object('account_id', p->>'account_id', 'key_status', p->>'status');
END $$;

CREATE OR REPLACE FUNCTION biz.graduation_candidates(p jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(client_id uuid, email text, paper_days int) LANGUAGE sql STABLE AS $$
  SELECT c.client_id, c.email, extract(day FROM now() - c.paper_started_at)::int
    FROM biz.clients c
   WHERE c.status = 'ACTIVE' AND c.mode = 'PAPER' AND c.live_opt_in_at IS NULL
     AND c.quiz_passed_at IS NOT NULL
     AND c.paper_started_at <= now() - make_interval(days => coalesce((p->>'min_paper_days')::int, 14))
     AND EXISTS (SELECT 1 FROM biz.consents k WHERE k.client_id = c.client_id AND k.doc_type = 'risk_disclosure')
     AND EXISTS (SELECT 1 FROM biz.accounts a WHERE a.client_id = c.client_id AND a.key_status = 'VERIFIED');
$$;

-- Billing never force-liquidates a client. A lapsed subscription moves the
-- client's accounts to REDUCE_ONLY with reason "billing:*"; payment lifts it.
CREATE OR REPLACE FUNCTION biz.apply_billing_event(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_n       int;
  v_client  uuid;
  v_status  text;
  v_action  text := 'none';
  v_type    text := p->>'type';
  v_acct    record;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  INSERT INTO biz.billing_events(stripe_event_id, type, payload) VALUES (p->>'event_id', v_type, p)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN jsonb_build_object('duplicate', true, 'event_id', p->>'event_id'); END IF;

  SELECT client_id INTO v_client FROM biz.subscriptions WHERE stripe_customer_id = p->>'customer_id';
  IF v_client IS NULL AND coalesce(p->>'client_ref', '') <> '' THEN
    SELECT client_id INTO v_client FROM biz.clients WHERE external_ref = p->>'client_ref';
  END IF;
  IF v_client IS NULL THEN RETURN jsonb_build_object('duplicate', false, 'unmatched', true, 'event_id', p->>'event_id'); END IF;

  v_status := CASE
    WHEN v_type IN ('invoice.paid', 'checkout.session.completed', 'customer.subscription.created') THEN 'ACTIVE'
    WHEN v_type = 'invoice.payment_failed' THEN 'PAST_DUE'
    WHEN v_type = 'customer.subscription.deleted' THEN 'CANCELED'
    WHEN v_type = 'customer.subscription.updated' THEN
      CASE p->>'subscription_status' WHEN 'active' THEN 'ACTIVE' WHEN 'trialing' THEN 'ACTIVE'
        WHEN 'past_due' THEN 'PAST_DUE' WHEN 'unpaid' THEN 'PAUSED_BILLING' WHEN 'paused' THEN 'PAUSED_BILLING'
        WHEN 'canceled' THEN 'CANCELED' ELSE 'PAST_DUE' END
    ELSE NULL END;
  IF v_status IS NULL THEN RETURN jsonb_build_object('duplicate', false, 'ignored', v_type); END IF;

  INSERT INTO biz.subscriptions(client_id, stripe_customer_id, stripe_subscription_id, tier, status, monthly_fee_usd, grace_until, updated_at)
  VALUES (v_client, p->>'customer_id', p->>'subscription_id', p->>'tier', v_status, (p->>'monthly_fee_usd')::numeric,
          CASE WHEN v_status = 'PAST_DUE' THEN now() + interval '7 days' END, now())
  ON CONFLICT (client_id) DO UPDATE
     SET stripe_customer_id = coalesce(EXCLUDED.stripe_customer_id, biz.subscriptions.stripe_customer_id),
         stripe_subscription_id = coalesce(EXCLUDED.stripe_subscription_id, biz.subscriptions.stripe_subscription_id),
         tier = coalesce(EXCLUDED.tier, biz.subscriptions.tier),
         monthly_fee_usd = coalesce(EXCLUDED.monthly_fee_usd, biz.subscriptions.monthly_fee_usd),
         status = EXCLUDED.status,
         grace_until = CASE WHEN EXCLUDED.status = 'PAST_DUE'
                            THEN coalesce(biz.subscriptions.grace_until, now() + interval '7 days') END,
         updated_at = now();

  UPDATE biz.accounts SET billing_status = v_status WHERE client_id = v_client;

  FOR v_acct IN SELECT account_id FROM biz.accounts WHERE client_id = v_client LOOP
    IF v_status IN ('PAUSED_BILLING', 'CANCELED') THEN
      v_changes := v_changes || risk.apply_mode(jsonb_build_object('scope', 'account', 'scope_id', v_acct.account_id,
                     'mode', 'REDUCE_ONLY', 'reason', 'billing:' || lower(v_status), 'set_by', 'billing'));
      v_action := 'reduce_only';
    ELSIF v_status = 'ACTIVE' THEN
      v_changes := v_changes || risk.apply_mode(jsonb_build_object('scope', 'account', 'scope_id', v_acct.account_id,
                     'mode', 'NORMAL', 'reason', 'billing:restored', 'set_by', 'billing', 'lift_own', 'billing'));
      v_action := 'restore_if_billing_hold';
    END IF;
  END LOOP;
  RETURN jsonb_build_object('duplicate', false, 'client_id', v_client, 'status', v_status, 'action', v_action,
                            'mode_changes', v_changes);
END $$;

-- Client-protective guardrail: flag accounts whose subscription cost is high
-- relative to the capital they have connected.
CREATE OR REPLACE FUNCTION biz.fee_burden_report(p jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(client_id uuid, email text, monthly_fee_usd numeric, connected_equity_usd numeric, annual_fee_pct numeric)
LANGUAGE sql STABLE AS $$
  WITH eq AS (
    SELECT a.client_id, sum(s.equity_usd) AS equity
      FROM biz.accounts a JOIN risk.account_state s ON s.account_id = a.account_id
     GROUP BY a.client_id)
  SELECT c.client_id, c.email, sub.monthly_fee_usd, eq.equity,
         round(12 * sub.monthly_fee_usd / NULLIF(eq.equity, 0) * 100, 3)
    FROM biz.clients c
    JOIN biz.subscriptions sub ON sub.client_id = c.client_id AND sub.status = 'ACTIVE'
    JOIN eq ON eq.client_id = c.client_id
   WHERE 12 * sub.monthly_fee_usd / NULLIF(eq.equity, 0) > coalesce((p->>'threshold_annual_pct')::numeric, 2) / 100;
$$;

CREATE OR REPLACE FUNCTION biz.reports_due(p jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(client_id uuid, email text, period text, metrics jsonb) LANGUAGE sql STABLE AS $$
  WITH d AS (SELECT coalesce((p->>'as_of')::date, current_date) AS as_of)
  SELECT c.client_id, c.email, to_char((SELECT as_of FROM d) - 1, 'YYYY-MM-DD'),
         jsonb_build_object(
           'mode', c.mode,
           'accounts', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'account_id', a.account_id, 'venue', a.venue,
                      'equity_usd', pd.equity_usd, 'fees_usd', pd.fees_usd, 'funding_usd', pd.funding_usd,
                      'day_change_usd', pd.equity_usd - prev.equity_usd,
                      'risk_mode', coalesce(m.mode, 'NORMAL')))
               FROM biz.accounts a
               LEFT JOIN pnl.daily pd ON pd.account_id = a.account_id AND pd.day = (SELECT as_of FROM d) - 1
               LEFT JOIN pnl.daily prev ON prev.account_id = a.account_id AND prev.day = (SELECT as_of FROM d) - 2
               LEFT JOIN risk.modes m ON m.scope = 'account' AND m.scope_id = a.account_id
              WHERE a.client_id = c.client_id), '[]'::jsonb),
           'breaker_events', coalesce((
             SELECT jsonb_agg(jsonb_build_object('ts', b.ts, 'tier', b.tier, 'metric', b.metric, 'action', b.action))
               FROM risk.breaches b JOIN biz.accounts a ON b.scope = 'account' AND b.scope_id = a.account_id
              WHERE a.client_id = c.client_id AND b.ts >= (SELECT as_of FROM d) - 1 AND b.ts < (SELECT as_of FROM d)), '[]'::jsonb))
    FROM biz.clients c
   WHERE c.status = 'ACTIVE'
     AND (c.report_cadence = 'daily'
          OR (c.report_cadence = 'weekly'  AND extract(isodow FROM (SELECT as_of FROM d)) = 1)
          OR (c.report_cadence = 'monthly' AND extract(day FROM (SELECT as_of FROM d)) = 1))
     AND NOT EXISTS (SELECT 1 FROM biz.reports r WHERE r.client_id = c.client_id
                        AND r.period = to_char((SELECT as_of FROM d) - 1, 'YYYY-MM-DD') AND r.channel = 'email');
$$;

CREATE OR REPLACE FUNCTION biz.record_report(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO biz.reports(client_id, period, channel, content_sha256, llm_model, compliance)
    VALUES ((p->>'client_id')::uuid, p->>'period', coalesce(p->>'channel', 'email'), p->>'content_sha256',
            p->>'llm_model', p->'compliance')
    ON CONFLICT (client_id, period, channel) DO NOTHING
    RETURNING report_id)
  SELECT jsonb_build_object('report_id', (SELECT report_id FROM ins), 'duplicate', NOT EXISTS (SELECT 1 FROM ins));
$$;

-- ---------------------------------------------------------------------
-- pnl: end-of-day snapshots; daily-loss holds are lifted at the day roll
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pnl.close_day(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_day    date := coalesce((p->>'day')::date, current_date - 1);
  v_n      int;
  v_lifted int := 0;
  r        record;
  res      jsonb;
BEGIN
  INSERT INTO pnl.daily(account_id, day, equity_usd, fees_usd, funding_usd)
  SELECT s.account_id, v_day, s.equity_usd,
         coalesce((SELECT sum(e.fee_usd) FROM oms.execution_events e
                    WHERE e.account_id = s.account_id AND e.ts >= v_day AND e.ts < v_day + 1), 0),
         coalesce((SELECT sum((e.payload->>'amount_usd')::numeric) FROM oms.execution_events e
                    WHERE e.account_id = s.account_id AND e.type = 'FUNDING' AND e.ts >= v_day AND e.ts < v_day + 1), 0)
    FROM risk.account_state s
  ON CONFLICT (account_id, day) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE risk.account_state
     SET day_start_equity_usd = equity_usd, hwm_equity_usd = greatest(hwm_equity_usd, equity_usd), updated_at = now();

  FOR r IN SELECT scope_id FROM risk.modes WHERE scope = 'account' AND reason LIKE 'daily_loss:%' LOOP
    res := risk.apply_mode(jsonb_build_object('scope', 'account', 'scope_id', r.scope_id, 'mode', 'NORMAL',
                                              'reason', 'daily_loss:day_roll', 'set_by', 'day_close', 'lift_own', 'daily_loss'));
    IF (res->>'changed')::boolean THEN v_lifted := v_lifted + 1; END IF;
  END LOOP;
  PERFORM ops.touch_heartbeat('day_close');
  RETURN jsonb_build_object('day', v_day, 'accounts_closed', v_n, 'daily_loss_holds_lifted', v_lifted);
END $$;

-- ---------------------------------------------------------------------
-- ops: kill requests and freshness report (needs the tables above)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.kill_requests (
  request_id   text PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  scope        text NOT NULL CHECK (scope IN ('global', 'account', 'strategy', 'venue')),
  scope_id     text NOT NULL,
  action       text NOT NULL CHECK (action IN ('halt_new', 'cancel_all', 'flatten', 'reset')),
  reason       text,
  requested_by text NOT NULL,
  approver_ids text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'RECEIVED',
  result       jsonb,
  completed_at timestamptz
);

CREATE OR REPLACE FUNCTION ops.record_kill_request(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_n int; v_mode text;
BEGIN
  INSERT INTO ops.kill_requests(request_id, scope, scope_id, action, reason, requested_by, approver_ids)
  VALUES (p->>'request_id', p->>'scope', coalesce(p->>'scope_id', '*'), p->>'action', p->>'reason', p->>'requested_by',
          ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'approver_ids', '[]'::jsonb))))
  ON CONFLICT (request_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  SELECT mode INTO v_mode FROM risk.modes WHERE scope = p->>'scope' AND scope_id = coalesce(p->>'scope_id', '*');
  IF v_n = 1 THEN
    PERFORM ops.append_audit(p->>'requested_by', 'ops.kill.' || (p->>'action'),
                             (p->>'scope') || ':' || coalesce(p->>'scope_id', '*'), p);
  END IF;
  RETURN jsonb_build_object('request_id', p->>'request_id', 'duplicate', v_n = 0,
                            'current_mode', coalesce(v_mode, 'NORMAL'));
END $$;

CREATE OR REPLACE FUNCTION ops.complete_kill_request(p jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  WITH upd AS (
    UPDATE ops.kill_requests SET status = p->>'status', result = p->'result', completed_at = now()
     WHERE request_id = p->>'request_id' RETURNING request_id, status)
  SELECT coalesce((SELECT jsonb_build_object('request_id', request_id, 'status', status) FROM upd),
                  jsonb_build_object('request_id', p->>'request_id', 'status', 'NOT_FOUND'));
$$;

CREATE OR REPLACE FUNCTION ops.freshness_report(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'now', now(),
    'critical_feeds', coalesce((SELECT jsonb_agg(jsonb_build_object('feed_id', feed_id, 'trust', trust,
                                       'bar_age_s', round(extract(epoch FROM now() - last_bar_ts)::numeric, 1)))
                                  FROM md.feed_registry WHERE critical), '[]'::jsonb),
    'max_critical_bar_age_s', (SELECT round(max(extract(epoch FROM now() - last_bar_ts))::numeric, 1)
                                 FROM md.feed_registry WHERE critical AND trust = 1),
    'quarantined_critical', (SELECT count(*) FROM md.feed_registry WHERE critical AND trust = 0),
    'max_mark_age_s', (SELECT round(max(extract(epoch FROM now() - ts))::numeric, 1) FROM md.latest_mark),
    'heartbeat_age_s', coalesce((SELECT jsonb_object_agg(component, round(extract(epoch FROM now() - ts)::numeric, 1))
                                   FROM ops.heartbeats), '{}'::jsonb),
    'open_high_breaks', (SELECT count(*) FROM oms.recon_breaks WHERE NOT resolved AND severity = 'HIGH'),
    'unconfirmed_orders', (SELECT count(*) FROM oms.parent_orders
                            WHERE status = 'SEND_UNCONFIRMED' AND updated_at < now() - interval '120 seconds'),
    'global_mode', coalesce((SELECT mode FROM risk.modes WHERE scope = 'global' AND scope_id = '*'), 'NORMAL'));
$$;

-- ---------------------------------------------------------------------
-- Read-only views for AI agents (granted to aqos_agent_ro only)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW risk.v_exposures AS
  SELECT ps.account_id, ps.venue, ps.symbol, ps.qty, m.px AS mark_px, ps.qty * m.px AS notional_usd, m.ts AS mark_ts
    FROM oms.positions ps LEFT JOIN md.latest_mark m ON m.venue = ps.venue AND m.symbol = ps.symbol
   WHERE ps.qty <> 0;

CREATE OR REPLACE VIEW risk.v_recent_breaches AS
  SELECT * FROM risk.breaches WHERE ts > now() - interval '24 hours';

CREATE OR REPLACE VIEW oms.v_recent_fills AS
  SELECT event_id, parent_order_id, account_id, venue, symbol, type, side, qty, px, fee_usd, ts
    FROM oms.execution_events
   WHERE ts > now() - interval '24 hours' AND type IN ('FILL', 'PARTIAL_FILL', 'LIQUIDATION', 'ADL');

CREATE OR REPLACE VIEW research.v_model_health AS
  SELECT model_id, strategy_family, stage, live_vs_backtest_z, psi_max, updated_at FROM research.model_registry_mirror;

-- ---------------------------------------------------------------------
-- Optional TimescaleDB hypertables
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('md.funding', 'ts', if_not_exists => true, migrate_data => true);
    PERFORM create_hypertable('md.alt_metrics', 'ts', if_not_exists => true, migrate_data => true);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Roles (least privilege). Skipped where role creation is not permitted.
--   aqos_orchestrator : n8n's main credential; executes functions only
--   aqos_agent_ro     : AI agent tools; SELECT on the v_* views only
--   aqos_research_ro  : research agent; SELECT on research.* and views
-- The audit log is append-only for every application role.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqos_orchestrator') THEN CREATE ROLE aqos_orchestrator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqos_agent_ro')     THEN CREATE ROLE aqos_agent_ro NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqos_research_ro')  THEN CREATE ROLE aqos_research_ro NOLOGIN; END IF;
  GRANT USAGE ON SCHEMA ops, md, alt, alpha, pm, risk, oms, biz, research, pnl TO aqos_orchestrator;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ops, md, alt, alpha, pm, risk, oms, biz, research, pnl TO aqos_orchestrator;
  GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA md, alt, alpha, pm, risk, oms, biz, research, pnl TO aqos_orchestrator;
  GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ops TO aqos_orchestrator;
  GRANT UPDATE ON ops.audit_head, ops.heartbeats, ops.incidents, ops.leases, ops.kill_requests TO aqos_orchestrator;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA ops, md, alt, alpha, pm, risk, oms, biz, research, pnl TO aqos_orchestrator;
  REVOKE UPDATE, DELETE, TRUNCATE ON ops.audit_log FROM aqos_orchestrator;
  GRANT USAGE ON SCHEMA risk, oms, research TO aqos_agent_ro, aqos_research_ro;
  GRANT SELECT ON risk.v_exposures, risk.v_recent_breaches, oms.v_recent_fills, research.v_model_health TO aqos_agent_ro;
  GRANT EXECUTE ON FUNCTION risk.propose_limit_change(jsonb), research.propose_transition(jsonb) TO aqos_agent_ro;
  GRANT SELECT ON ALL TABLES IN SCHEMA research TO aqos_research_ro;
  GRANT SELECT ON risk.v_exposures, oms.v_recent_fills TO aqos_research_ro;
  GRANT EXECUTE ON FUNCTION research.propose_transition(jsonb) TO aqos_research_ro;
EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
  RAISE NOTICE 'role setup skipped: %', SQLERRM;
END $$;

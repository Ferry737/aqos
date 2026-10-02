// Turns health probes and database freshness into one system state.
// Policies: no trustworthy market data -> no new signals (dq DEGRADED);
// no risk monitoring -> no new risk (escalate global mode to REDUCE_ONLY).
// The supervisor can only escalate; the database ratchet enforces that too.
const P = {
  maxCriticalBarAgeS: 150,
  maxMarkAgeS: 15,
  maxRiskMonitorAgeS: 90,
  maxReconAgeS: 300,
};
const RANK = { NORMAL: 0, REDUCE_ONLY: 1, HALT: 2 };
const normMode = (m) => {
  const u = String(m ?? 'NORMAL').toUpperCase();
  return u in RANK ? u : 'HALT';
};

function evaluate(probes, fresh, currentMode, nowIso) {
  const components = {};
  for (const p of probes) {
    const up = p.statusCode >= 200 && p.statusCode < 300;
    components[p.name] = { up, critical: p.critical, status: p.statusCode ?? null, error: up ? null : p.error ?? `http_${p.statusCode}` };
  }
  const hb = fresh.heartbeat_age_s ?? {};
  const issues = [];
  const add = (sev, code, detail) => issues.push(detail === undefined ? { sev, code } : { sev, code, detail });

  const gatewayUp = components['stream-gateway']?.up === true;
  const feedsStale = fresh.max_critical_bar_age_s == null || Number(fresh.max_critical_bar_age_s) > P.maxCriticalBarAgeS;
  const marksStale = fresh.max_mark_age_s == null || Number(fresh.max_mark_age_s) > P.maxMarkAgeS;
  const quarantined = Number(fresh.quarantined_critical ?? 0);
  if (!gatewayUp) add('SEV1', 'stream_gateway_down');
  if (feedsStale) add('SEV2', 'critical_feeds_stale', fresh.max_critical_bar_age_s);
  if (marksStale) add('SEV2', 'marks_stale', fresh.max_mark_age_s);
  if (quarantined > 0) add('SEV2', 'critical_feed_quarantined', quarantined);
  const dqStatus = gatewayUp && !feedsStale && !marksStale && quarantined === 0 ? 'OK' : 'DEGRADED';

  if (!components['ems-primary']?.up) {
    add(components['ems-standby']?.up ? 'SEV2' : 'SEV1', 'ems_primary_down', { standby_up: components['ems-standby']?.up === true });
  }
  if (!components['risk-service']?.up) add('SEV2', 'risk_service_down_fallback_active');
  if (!components['model-service']?.up) add('SEV2', 'model_service_down_signals_paused');
  const riskAge = hb.risk_monitor;
  const riskBlind = riskAge == null || Number(riskAge) > P.maxRiskMonitorAgeS;
  if (riskBlind) add('SEV1', 'risk_monitor_blind', riskAge ?? null);
  const reconAge = hb.reconciliation;
  if (reconAge == null || Number(reconAge) > P.maxReconAgeS) add('SEV2', 'reconciliation_stale', reconAge ?? null);
  if (Number(fresh.open_high_breaks ?? 0) > 0) add('SEV2', 'open_high_recon_breaks', fresh.open_high_breaks);
  if (Number(fresh.unconfirmed_orders ?? 0) > 0) add('SEV1', 'orders_send_unconfirmed', fresh.unconfirmed_orders);

  const escalateTo = riskBlind && RANK[currentMode] < RANK.REDUCE_ONLY ? 'REDUCE_ONLY' : null;
  const severity = issues.some((i) => i.sev === 'SEV1') ? 'SEV1' : issues.some((i) => i.sev === 'SEV2') ? 'SEV2' : 'OK';
  const fingerprint = [dqStatus, escalateTo ?? '-', ...issues.map((i) => i.code).sort()].join('|');
  return { ts: nowIso, dq_status: dqStatus, global_mode: currentMode, escalate_to: escalateTo, severity, issues, components, fingerprint };
}

// ---- n8n glue -------------------------------------------------------------
const registry = $('Service registry').all();
const results = $('Probe /healthz').all();
const probes = registry.map((s, i) => {
  const r = results[i]?.json ?? {};
  return { ...s.json, statusCode: r.statusCode ?? null, error: r.error ? String(r.error.message ?? r.error) : null };
});
const fresh = $('Freshness report').first().json.r ?? {};
// Use the more severe of the fast flag (Redis) and the system of record (DB).
const redisMode = normMode($('Current global mode').first().json.global_mode ?? 'NORMAL');
const dbMode = normMode(fresh.global_mode ?? 'NORMAL');
const mode = RANK[redisMode] >= RANK[dbMode] ? redisMode : dbMode;
return [{ json: evaluate(probes, fresh, mode, new Date().toISOString()) }];

// ===========================================================================
// AQOS · WF-07 Risk Monitor · Circuit-breaker policy (deterministic)
//   T1 WARN        : notify (VaR > 80% of limit, correlation concentration)
//   T2 REDUCE_ONLY : no new risk (VaR >= limit, daily loss, depeg, venue
//                    withdrawals suspended, liquidation distance <= 3 sigma,
//                    risk unmeasurable for N passes, stale marks)
//   T3 HALT        : cancel open orders, block new (ES >= 125% of limit,
//                    max drawdown, severe depeg, venue down)
//   T4 FLATTEN     : controlled exit beats a forced liquidation
//                    (liquidation distance <= 1.5 sigma, or client opted in)
// Escalation is automatic. Lifting HALT needs two humans (WF-14 reset).
// Actions that would not change state are dropped; kill requests already
// issued in the last 30 minutes (by fingerprint) are not re-sent.
// ===========================================================================
const RANK = { NORMAL: 0, REDUCE_ONLY: 1, HALT: 2 };
const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

function evaluate(snap, c) {
  const P = c?.policy ?? {};
  const g = snap?.global ?? {};
  const src = snap?.source ?? 'risk_svc';
  const modeActs = [];
  const kills = [];
  const warnings = [];
  const mode = (scope, scope_id, m, reason, tier, metric, value, limit) =>
    modeActs.push({ scope, scope_id, mode: m, reason, tier, metric, value, limit, fingerprint: `mode:${scope}:${scope_id}:${m}` });
  const kill = (scope, scope_id, action, reason) =>
    kills.push({ scope, scope_id, action, reason, tier: action === 'flatten' ? 'T4' : 'T3', fingerprint: `kill:${scope}:${scope_id}:${action}` });

  // Measurement health.
  const streak = num(c?.monitor?.fallback_streak) || 0;
  if (src === 'db_fallback' && streak + 1 >= num(P.fallback_streak_reduce ?? 8)) {
    mode('global', '*', 'REDUCE_ONLY', 'risk_unmeasurable:fallback_streak', 'T2', 'fallback_streak', streak + 1, num(P.fallback_streak_reduce ?? 8));
  }
  const markAge = num(g.max_mark_age_s);
  if (Number.isFinite(markAge) && markAge > num(P.max_mark_age_s_halt ?? 60)) {
    mode('global', '*', 'REDUCE_ONLY', `stale_marks:${markAge}s`, 'T2', 'max_mark_age_s', markAge, num(P.max_mark_age_s_halt ?? 60));
  }

  // Portfolio VaR / ES (risk service only).
  if (num(g.var_limit_usd) > 0) {
    const u = num(g.var_99_1d_usd) / num(g.var_limit_usd);
    if (u >= num(P.var_util_reduce ?? 1)) mode('global', '*', 'REDUCE_ONLY', `var_util:${r4(u)}`, 'T2', 'var_util', r4(u), num(P.var_util_reduce ?? 1));
    else if (u >= num(P.var_util_warn ?? 0.8)) warnings.push({ code: 'var_util_high', value: r4(u) });
  }
  if (num(g.es_limit_usd) > 0) {
    const u = num(g.es_975_1d_usd) / num(g.es_limit_usd);
    if (u >= num(P.es_util_halt ?? 1.25)) {
      mode('global', '*', 'HALT', `es_util:${r4(u)}`, 'T3', 'es_util', r4(u), num(P.es_util_halt ?? 1.25));
      kill('global', '*', 'cancel_all', `es_util:${r4(u)}`);
    }
  }
  if (num(g.absorption_ratio) >= num(P.absorption_warn ?? 0.85)) warnings.push({ code: 'correlation_concentration', value: num(g.absorption_ratio) });

  // Stablecoin depegs (collateral and quote-currency risk).
  for (const [coin, bps] of Object.entries(g.stablecoin_depeg_bps ?? {})) {
    const b = Math.abs(num(bps));
    if (b >= num(P.depeg_bps_halt ?? 200)) {
      mode('global', '*', 'HALT', `depeg:${coin}:${b}bps`, 'T3', 'depeg_bps', b, num(P.depeg_bps_halt ?? 200));
      kill('global', '*', 'cancel_all', `depeg:${coin}`);
    } else if (b >= num(P.depeg_bps_reduce ?? 50)) {
      mode('global', '*', 'REDUCE_ONLY', `depeg:${coin}:${b}bps`, 'T2', 'depeg_bps', b, num(P.depeg_bps_reduce ?? 50));
    }
  }

  // Venue / counterparty health.
  for (const v of snap?.venues ?? []) {
    if (v.health === 'DOWN') mode('venue', v.venue, 'HALT', 'venue_down', 'T3', null, null, null);
    else if (v.withdrawals_suspended === true) mode('venue', v.venue, 'REDUCE_ONLY', 'counterparty:withdrawals_suspended', 'T2', null, null, null);
  }

  // Accounts.
  for (const a of snap?.accounts ?? []) {
    const dd = num(a.drawdown_pct);
    const day = num(a.day_pnl_pct);
    const ddLim = num(a.max_drawdown_pct);
    const dayLim = num(a.daily_loss_limit_pct);
    if (Number.isFinite(dd) && Number.isFinite(ddLim) && dd >= ddLim) {
      mode('account', a.account_id, 'HALT', `max_drawdown:${r4(dd)}`, 'T3', 'drawdown_pct', r4(dd), ddLim);
      kill('account', a.account_id, a.auto_flatten_on_max_dd === true ? 'flatten' : 'cancel_all', 'max_drawdown');
    } else if (Number.isFinite(day) && Number.isFinite(dayLim) && day <= -dayLim) {
      mode('account', a.account_id, 'REDUCE_ONLY', `daily_loss:${r4(day)}`, 'T2', 'day_pnl_pct', r4(day), -dayLim);
    }
    const liq = num(a.min_liq_distance_sigma);
    if (Number.isFinite(liq)) {
      if (liq <= num(P.liq_distance_sigma_flatten ?? 1.5)) {
        mode('account', a.account_id, 'HALT', `liq_distance:${liq}sigma`, 'T4', 'liq_distance_sigma', liq, num(P.liq_distance_sigma_flatten ?? 1.5));
        kill('account', a.account_id, 'flatten', `liquidation_distance_${liq}_sigma`);
      } else if (liq <= num(P.liq_distance_sigma_reduce ?? 3)) {
        mode('account', a.account_id, 'REDUCE_ONLY', `liq_distance:${liq}sigma`, 'T2', 'liq_distance_sigma', liq, num(P.liq_distance_sigma_reduce ?? 3));
      }
    }
  }

  // Keep only what changes state.
  const current = {};
  for (const m of c?.modes ?? []) current[`${m.scope}:${m.scope_id}`] = String(m.mode).toUpperCase();
  const best = {};
  for (const a of modeActs) {
    const k = `${a.scope}:${a.scope_id}`;
    if (!best[k] || RANK[a.mode] > RANK[best[k].mode]) best[k] = a;
  }
  const effectiveModes = Object.values(best).filter((a) => (RANK[current[`${a.scope}:${a.scope_id}`] ?? 'NORMAL'] ?? 2) < RANK[a.mode]);
  const recent = new Set(c?.recent_fingerprints ?? []);
  const uniqKills = [...new Map(kills.map((k) => [k.fingerprint, k])).values()];
  const newKills = uniqKills.filter((k) => !recent.has(k.fingerprint));

  const severity = effectiveModes.length || newKills.length ? 'ACT' : warnings.length ? 'WARN' : 'OK';
  const fingerprint = [...effectiveModes.map((a) => a.fingerprint), ...newKills.map((k) => k.fingerprint), ...warnings.map((w) => w.code)].sort().join('|') || 'ok';
  const lines = [
    ...effectiveModes.map((a) => `${a.tier} ${a.scope}:${a.scope_id} -> ${a.mode} (${a.reason})`),
    ...newKills.map((k) => `${k.tier} ${k.scope}:${k.scope_id} -> ${k.action.toUpperCase()} (${k.reason})`),
    ...warnings.map((w) => `T1 ${w.code} = ${w.value}`),
  ];
  return {
    severity,
    snapshot_source: src,
    actions: [...effectiveModes, ...newKills],
    kills: newKills.map((k) => ({ ...k, request_id: `${k.fingerprint}:${Math.floor(Date.now() / 60_000)}`, requested_by: 'risk_monitor' })),
    warnings,
    fingerprint,
    text: `[RISK ${severity}] source=${src}\n${lines.join('\n')}`,
  };
}

// ---- n8n glue -------------------------------------------------------------
const snap = $('Normalize snapshot').first().json.snapshot;
const c = $input.first().json.c;
return [{ json: evaluate(snap, c) }];

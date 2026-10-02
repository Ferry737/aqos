// Fail closed: a malformed, stale or mostly rejected prediction set trades
// nothing this cycle. Individual bad rows are dropped and counted.
const STRATEGIES = ['tsmom_v1', 'xsmom_v1', 'statarb_ou_v1', 'funding_carry_v1', 'basis_xex_v1'];
const MAX_REJECT_RATIO = 0.2;

function validate(resp, barTs) {
  const preds = Array.isArray(resp?.predictions) ? resp.predictions : [];
  const kept = [];
  const rejected = [];
  for (const p of preds) {
    const why = [];
    const mu = Number(p.mu);
    const sigma = Number(p.sigma);
    if (!Number.isFinite(mu)) why.push('mu_not_finite');
    if (!Number.isFinite(sigma) || sigma <= 0) why.push('sigma_invalid');
    if (Number.isFinite(mu) && Number.isFinite(sigma) && sigma > 0 && Math.abs(mu) > 5 * sigma) why.push('mu_beyond_5_sigma');
    if (p.p_up != null && !(Number(p.p_up) >= 0 && Number(p.p_up) <= 1)) why.push('p_up_out_of_range');
    if (!STRATEGIES.some((s) => String(p.model_id ?? '').startsWith(s))) why.push('model_not_registered');
    if (!p.symbol || !p.horizon || !p.model_version) why.push('missing_keys');
    if (why.length) rejected.push({ model_id: p.model_id, symbol: p.symbol, why });
    else kept.push(p);
  }
  const asOfOk = resp?.as_of ? Math.abs(Date.parse(resp.as_of) - Date.parse(barTs)) <= 60_000 : false;
  const rejectRatio = preds.length ? rejected.length / preds.length : 1;
  const ok = asOfOk && kept.length > 0 && rejectRatio <= MAX_REJECT_RATIO;
  const reason = ok ? null : !asOfOk ? 'stale_or_missing_as_of' : kept.length === 0 ? 'no_valid_predictions' : 'reject_ratio_above_limit';
  return { ok, reason, kept, rejected_count: rejected.length, reject_ratio: rejectRatio, sample_rejections: rejected.slice(0, 5), regime: resp?.regime ?? null };
}

const cycle = $('Gate decision').first().json;
return [{ json: { ...validate($input.first().json, cycle.bar_ts), cycle_id: cycle.cycle_id, bar_ts: cycle.bar_ts, mode: cycle.mode } }];

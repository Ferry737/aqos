// Defence in depth before anything leaves the building: re-read the fast
// global flag and the EMS circuit breaker after the gate decided, then pick
// an execution algorithm from urgency and size. Skipped decisions expire
// unused; the next cycle re-evaluates from scratch.
const RANK = { NORMAL: 0, REDUCE_ONLY: 1, HALT: 2 };

function algoFor(d) {
  const notional = Number(d.approved_qty) * Number(d.mark_px ?? 0);
  if (d.urgency === 'high') return { algo: 'IS', algo_params: { horizon_s: 120, max_participation: 0.15 } };
  if (d.urgency === 'low') return { algo: 'PASSIVE_LIMIT', algo_params: { post_only: true, reprice_s: 30, ttl_s: 1800, fallback: 'TWAP' } };
  return notional > 25_000
    ? { algo: 'TWAP', algo_params: { horizon_s: 900, slices: 15, max_participation: 0.1, limit_offset_bps: 5 } }
    : { algo: 'LIMIT_LADDER', algo_params: { levels: 3, max_slippage_bps: 8, ttl_s: 120 } };
}

const decisions = $('Approved decisions in').all().map((i) => i.json);
const modeRaw = String($('Global mode re-check').first().json.redis_mode ?? 'NORMAL').toUpperCase();
const mode = modeRaw in RANK ? modeRaw : 'HALT';
const breakerOpen = String($('EMS breaker state').first().json.ems_breaker ?? '').toUpperCase() === 'OPEN';
const dispatch = [];
const skipped = [];
for (const d of decisions) {
  if (!d.decision_id) continue;
  if (RANK[mode] >= RANK.HALT) skipped.push({ decision_id: d.decision_id, reason: 'global_halt_after_gate' });
  else if (RANK[mode] === RANK.REDUCE_ONLY && d.reduce_only !== true) skipped.push({ decision_id: d.decision_id, reason: 'reduce_only_after_gate' });
  else if (breakerOpen) skipped.push({ decision_id: d.decision_id, reason: 'ems_circuit_open' });
  else {
    dispatch.push({
      decision_id: d.decision_id, account_id: d.account_id, venue: d.venue, symbol: d.symbol, side: d.side,
      qty: Number(d.approved_qty), order_type: d.order_type ?? 'LIMIT', limit_px: d.limit_px != null ? Number(d.limit_px) : null,
      arrival_mid: d.mark_px != null ? Number(d.mark_px) : null, ...algoFor(d),
    });
  }
}
return [{
  json: {
    dispatch, skipped, mode, breaker_open: breakerOpen,
    skipped_ids: skipped.map((s) => s.decision_id),
    skip_reason: [...new Set(skipped.map((s) => s.reason))].join(','),
  },
}];

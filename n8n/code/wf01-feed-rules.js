// Deterministic data-quality rules. These decide quarantine; the LLM triage
// that follows only explains and may request a backfill. Quarantine is
// reversible by a human only (md.restore_feed is not exposed to workflows).
// feed_status payload: { feed_id, venue, symbol, critical, status, detail }
//   status: stale | gap | checksum_mismatch | crossed_book | outlier | recovered
function rules(r) {
  const p = r.payload ?? {};
  const d = p.detail ?? {};
  const status = p.status;
  let action = 'log';
  let reason = status;
  if (status === 'checksum_mismatch' || status === 'crossed_book') {
    action = 'quarantine';
  } else if (status === 'stale' && Number(d.age_s ?? 0) > (p.critical ? 60 : 300)) {
    action = 'quarantine';
    reason = `stale ${d.age_s}s`;
  } else if (status === 'outlier' && Math.abs(Number(d.mad_z ?? 0)) > 8 && Number(d.venues_agreeing ?? 0) === 0) {
    action = 'quarantine';
    reason = `isolated outlier, MAD z=${d.mad_z}`;
  } else if (status === 'gap') {
    action = d.backfilled ? 'log' : 'backfill';
  }
  return {
    event_id: r.event_id,
    feed_id: p.feed_id,
    venue: p.venue,
    symbol: p.symbol,
    critical: p.critical === true,
    status,
    detail: d,
    action,
    reason,
    triage: action !== 'log' || p.critical === true,
  };
}
return $input.all().map((it) => ({ json: rules(it.json.r ?? {}) }));

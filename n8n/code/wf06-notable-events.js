// Alerting on execution events: liquidations and ADL page (SEV1), venue
// rejects notify (SEV2), slippage outliers are logged to the ops channel (SEV3).
const r = $input.first().json.r ?? {};
const notable = Array.isArray(r.notable) ? r.notable : [];
if (!notable.length) return [];
const severity = notable.some((n) => n.severity === 'SEV1') ? 'SEV1' : notable.some((n) => n.severity === 'SEV2') ? 'SEV2' : 'SEV3';
const lines = notable.slice(0, 20).map((n) => [
  n.severity, n.kind, n.account_id, n.symbol, n.venue,
  n.slippage_bps != null ? `${n.slippage_bps} bps` : null, n.reason,
].filter(Boolean).join(' '));
return [{
  json: {
    severity,
    count: notable.length,
    text: `[${severity}] Execution events: ${notable.length} notable\n${lines.join('\n')}`,
    dedup_key: `exec-${severity}-${new Date().toISOString().slice(0, 13)}`,
  },
}];

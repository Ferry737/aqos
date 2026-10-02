// Deduplicates escalations raised during the gate pass. Mode changes are
// applied in SQL (ratchet); kills go to the Kill Switch workflow. Kill
// request ids are bucketed per minute so repeats inside a minute collapse.
const out = $('Pre-trade checks').first().json;
const unique = new Map();
for (const e of out.escalations ?? []) {
  const k = `${e.kind}|${e.scope}|${e.scope_id}|${e.mode ?? e.action}`;
  if (!unique.has(k)) unique.set(k, e);
}
const esc = [...unique.values()];
const minute = Math.floor(Date.now() / 60_000);
const actions = esc.filter((e) => e.kind === 'mode').map((e) => ({
  scope: e.scope, scope_id: e.scope_id, mode: e.mode, reason: e.reason, tier: e.tier,
  metric: e.metric, value: e.value, limit: e.limit, fingerprint: `gate:${e.scope}:${e.scope_id}:${e.mode}`,
}));
const kills = esc.filter((e) => e.kind === 'kill').map((e) => ({
  request_id: `gate:${e.scope}:${e.scope_id}:${e.action}:${minute}`,
  scope: e.scope, scope_id: e.scope_id, action: e.action, reason: e.reason, requested_by: 'risk_gate',
}));
if (!actions.length && !kills.length) return [];
return [{ json: { snapshot_source: null, fingerprint: `gate:${minute}`, actions, kills } }];

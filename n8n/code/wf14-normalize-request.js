// Normalises a kill request from either trigger: an authenticated webhook
// (humans, ops tools, the client portal's "pause my account" button) or a
// sub-workflow call (risk gate, risk monitor).
const it = $input.first().json;
const viaWebhook = it.body !== undefined && it.headers !== undefined;
const b = viaWebhook ? it.body ?? {} : it;
const scope = String(b.scope ?? 'global').toLowerCase();
const action = String(b.action ?? 'halt_new').toLowerCase();
const scopeId = scope === 'global' ? '*' : String(b.scope_id ?? '');
const valid = ['global', 'account', 'strategy', 'venue'].includes(scope)
  && ['halt_new', 'cancel_all', 'flatten', 'reset'].includes(action)
  && (scope === 'global' || scopeId.length > 0)
  && (!viaWebhook || !!b.requested_by);
const minute = Math.floor(Date.now() / 60_000);
return [{
  json: {
    valid,
    via_webhook: viaWebhook,
    request_id: String(b.request_id ?? `${viaWebhook ? 'ops' : 'auto'}:${scope}:${scopeId}:${action}:${minute}`).slice(0, 200),
    scope,
    scope_id: scopeId,
    action,
    reason: String(b.reason ?? 'unspecified').slice(0, 300),
    requested_by: String(b.requested_by ?? 'system').slice(0, 80),
    approver_ids: Array.isArray(b.approver_ids) ? [...new Set(b.approver_ids.map(String))].slice(0, 5) : [],
  },
}];

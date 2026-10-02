// API-key permission policy, checked against the venue itself (via the EMS):
// trading allowed; withdrawals and internal transfers disabled; IP allowlist
// set; futures only if the mandate allows derivatives. Anything else is
// rejected and the stored key is destroyed.
const req = $('Key connected').first().json.body ?? {};
const perm = $input.first().json ?? {};
const reasons = [];
if (perm.error) reasons.push('permission_check_failed');
if (perm.can_trade !== true) reasons.push('trading_permission_missing');
if (perm.can_withdraw !== false) reasons.push('withdrawals_must_be_disabled');
if (perm.can_transfer === true) reasons.push('internal_transfers_must_be_disabled');
if (perm.ip_restricted !== true) reasons.push('ip_allowlist_required');
if (perm.futures_enabled === true && req.derivatives_allowed !== true) reasons.push('futures_permission_not_allowed_for_this_mandate');
const status = reasons.length ? 'REJECTED' : 'VERIFIED';
const fixes = {
  trading_permission_missing: 'enable spot (and, if your plan includes it, futures) trading on the key',
  withdrawals_must_be_disabled: 'create the key with withdrawals disabled',
  internal_transfers_must_be_disabled: 'disable universal/internal transfer permission',
  ip_allowlist_required: 'restrict the key to the IP addresses shown in your dashboard',
  futures_permission_not_allowed_for_this_mandate: 'remove futures permission; derivatives are not enabled for your account',
  permission_check_failed: 'retry in a few minutes; we could not reach the exchange',
};
return [{
  json: {
    account_id: req.account_id,
    client_id: req.client_id,
    venue: req.venue,
    key_ref: req.key_ref,
    email: req.email,
    status,
    permissions: perm,
    reasons,
    instructions: reasons.map((r) => fixes[r] ?? r),
  },
}];

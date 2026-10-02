// Maps the sanctions/PEP screening result onto the client record. A hit is
// never explained to the applicant (no tipping off); compliance reviews it.
const v = $('Validate signup').first().json;
const res = $input.first().json;
const result = String(res.result ?? (res.error ? 'ERROR' : 'REVIEW')).toUpperCase();
const status = { CLEAR: 'ACTIVE', REVIEW: 'PENDING_REVIEW', HIT: 'BLOCKED' }[result] ?? 'PENDING_REVIEW';
return [{
  json: {
    route: status,
    create: { ...v.client, status, screening: { provider_ref: res.reference ?? null, result, checked_at: new Date().toISOString() } },
    email: v.client.email,
  },
}];

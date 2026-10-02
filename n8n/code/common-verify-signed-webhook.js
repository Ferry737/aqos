// Verifies an HMAC-signed callback from an internal service (market-data
// gateway, EMS). The Crypto node already computed HMAC-SHA256 over the exact
// raw request body into json.computed_sig.
// Header: x-aqos-signature: sha256=<hex>. Body must carry event_id, type and
// a ts within 30 s (replay window); event_id makes replays idempotent in SQL.
const MAX_SKEW_MS = 30_000;

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verify(item, nowMs) {
  const headers = item.headers ?? {};
  const provided = String(headers['x-aqos-signature'] ?? '').replace(/^sha256=/i, '').toLowerCase();
  const computed = String(item.computed_sig ?? '').toLowerCase();
  if (!provided) return { valid: false, reason: 'missing_signature' };
  if (!timingSafeEqualHex(provided, computed)) return { valid: false, reason: 'bad_signature' };
  const env = item.body ?? {};
  const ts = Date.parse(env.ts);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > MAX_SKEW_MS) return { valid: false, reason: 'stale_or_missing_ts' };
  if (!env.event_id || !env.type) return { valid: false, reason: 'missing_event_id_or_type' };
  return { valid: true, reason: null };
}

return $input.all().map((it) => {
  const res = verify(it.json, Date.now());
  return {
    json: {
      ...res,
      envelope: res.valid ? it.json.body : null,
      source_ip: it.json.headers?.['x-forwarded-for'] ?? null,
    },
  };
});

// Accepts either the risk-service snapshot (JSON body) or the degraded DB
// fallback ({ s: ... }). The fallback has no VaR/ES; the breaker policy
// treats a long fallback streak as "risk not measurable".
const j = $input.first().json;
const snap = j.s ?? j;
const source = j.s ? 'db_fallback' : snap.source ?? 'risk_svc';
let trigger = 'schedule';
try { if ($('Market stress event').isExecuted) trigger = 'event'; } catch { /* trigger not in this run */ }
return [{ json: { snapshot: { ...snap, source }, trigger } }];

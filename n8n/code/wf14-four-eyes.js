// Lifting a halt needs two distinct approvers (the database re-checks this).
const r = $('Normalize request').first().json;
const approvers = [...new Set(r.approver_ids)];
const ok = approvers.length >= 2;
return [{ json: { ...r, approver_ids: approvers, four_eyes_ok: ok, reason_text: ok ? null : 'reset requires two distinct approver_ids' } }];

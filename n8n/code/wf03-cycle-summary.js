// Quiet by default: notify only on escalations or an unusual reject ratio.
const s = $input.first().json.r ?? {};
const total = Number(s.proposals ?? 0);
const rejected = Number(s.rejected ?? 0);
const ratio = total ? rejected / total : 0;
const notify = Number(s.escalations ?? 0) > 0 || (total >= 5 && ratio > 0.5);
const text = `[CYCLE] ${s.cycle_id}: ${total} proposals, ${s.approved ?? 0} approved, ${s.resized ?? 0} resized, `
  + `${rejected} rejected, ${s.escalations ?? 0} escalations, ${s.orders_registered ?? 0} orders`;
return [{ json: { ...s, reject_ratio: ratio, notify, severity: Number(s.escalations ?? 0) > 0 ? 'SEV2' : 'SEV3', text } }];

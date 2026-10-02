// Route: proceed | skip (claimed but gated) | duplicate (another trigger won).
// Fail closed on data quality: a missing dq key (supervisor down) is not OK.
const ctx = $('Cycle context').first().json;
const mode = String($('Global mode').first().json.redis_mode ?? 'NORMAL').toUpperCase();
const dq = String($('Data quality').first().json.dq_status ?? 'UNKNOWN').toUpperCase();
const claimed = $input.first().json.r?.claimed === true;
let route = 'proceed';
let skipReason = null;
if (!claimed) {
  route = 'duplicate';
} else if (dq !== 'OK') {
  route = 'skip';
  skipReason = `data_quality_${dq.toLowerCase()}`;
} else if (mode === 'HALT') {
  route = 'skip';
  skipReason = 'global_halt';
}
return [{ json: { ...ctx, mode, dq, route, skip_reason: skipReason } }];

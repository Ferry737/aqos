// Page once per distinct risk situation, not every 15 seconds.
const plan = $('Plan follow-ups').first().json;
const last = $input.first().json.last_alert_fp ?? null;
if (plan.severity === 'OK' || plan.fingerprint === last) return [];
return [{ json: { ...plan, dedup_key: `risk-${plan.fingerprint}`.slice(0, 250) } }];

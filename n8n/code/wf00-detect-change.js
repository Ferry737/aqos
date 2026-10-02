// Alerts on state transitions only, so a persistent problem pages once,
// and a recovery is announced once.
const cur = $('Evaluate system state').first().json;
const last = $input.first().json.last_fingerprint ?? null;
const changed = last !== cur.fingerprint;
const lines = cur.issues.map((i) => `- ${i.sev} ${i.code}${i.detail !== undefined ? ` (${JSON.stringify(i.detail)})` : ''}`);
const text = cur.severity === 'OK'
  ? `[RECOVERED] AQOS: all supervisor checks passing (${cur.ts})`
  : `[${cur.severity}] AQOS supervisor: data ${cur.dq_status}, global mode ${cur.escalate_to ?? cur.global_mode}\n${lines.join('\n')}`;
const notify = changed && (cur.severity !== 'OK' || last !== null);
return [{ json: { ...cur, changed, notify, text } }];

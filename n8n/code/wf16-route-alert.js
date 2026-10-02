// The one place ops alerts are routed. SEV1 pages on-call (PagerDuty) and
// posts to the ops chat; everything else posts to the ops chat only.
// ACT/WARN from the risk monitor map to SEV1/SEV2.
const MAP = { ACT: 'SEV1', WARN: 'SEV2', OK: 'INFO' };
return $input.all().map(({ json: j }) => {
  const raw = String(j.severity ?? 'INFO').toUpperCase();
  const severity = ['SEV1', 'SEV2', 'SEV3', 'INFO'].includes(raw) ? raw : MAP[raw] ?? 'INFO';
  const text = String(j.text ?? JSON.stringify(j)).slice(0, 3900);
  return {
    json: {
      severity,
      text,
      summary: text.split('\n')[0].slice(0, 1000),
      dedup_key: String(j.dedup_key ?? `${severity}:${text.split('\n')[0]}`).slice(0, 255),
    },
  };
});

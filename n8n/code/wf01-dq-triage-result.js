//@include common-claude.js
// Merges the deterministic incident with the LLM triage. A backfill is
// requested when the rules asked for one, or when the model asks for one on a
// cause that a backfill can actually repair. Backfills are idempotent.
const REPAIRABLE = new Set(['sequence_gap', 'network_path', 'gateway_bug']);
const requests = $('Build DQ triage request').all();
return $input.all().map((it, i) => {
  const incident = { ...(requests[i]?.json ?? {}) };
  delete incident.anthropic_request;
  const t = parseClaude(it.json);
  const triage = t.ok ? t.data : null;
  const llmWantsBackfill = triage?.request_backfill === true && REPAIRABLE.has(triage?.cause_class);
  const minutes = Math.min(240, Math.max(1, Number(triage?.backfill_minutes ?? 15) || 15));
  const backfill = incident.action === 'backfill' || llmWantsBackfill ? { feed_id: incident.feed_id, minutes } : null;
  const head = `[DQ] ${incident.feed_id} ${incident.status}: ${incident.action === 'quarantine' ? 'QUARANTINED' : incident.action}`;
  const body = triage
    ? `${triage.cause_class} (${triage.confidence}): ${triage.summary}\nNext: ${(triage.recommended_actions ?? []).slice(0, 4).join('; ')}`
    : `LLM triage unavailable (${t.reason}); rule reason: ${incident.reason}`;
  const severity = incident.action === 'quarantine' ? (incident.critical ? 'SEV1' : 'SEV2') : 'SEV3';
  return {
    json: {
      ...incident, triage, triage_error: t.ok ? null : t.reason, backfill, severity,
      text: `${head}\n${body}`, dedup_key: `dq:${incident.feed_id}:${incident.status}`,
    },
  };
});

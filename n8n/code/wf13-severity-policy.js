// Severity from criticality, transience and recurrence. A SEV1 failure in a
// path that guards capital puts the whole system in REDUCE_ONLY: if the
// pipeline cannot be trusted, it may only reduce risk until a human looks.
const FAIL_SAFE = new Set(['AQOS04RiskGate00', 'AQOS05ExecDisptc', 'AQOS06Settlement', 'AQOS07RiskMonitr']);
const c = $('Classify error').first().json;
const r = $input.first().json.r ?? {};
const n = Number(r.occurrences_window ?? 1);
let severity = 'SEV3';
if (c.criticality === 'critical') severity = !c.transient || n >= 3 ? 'SEV1' : 'SEV2';
else if (c.criticality === 'high') severity = !c.transient || n >= 5 ? 'SEV2' : 'SEV3';
return [{
  json: {
    ...c,
    severity,
    occurrences_window: n,
    incident_id: r.incident_id ?? null,
    fail_safe_reduce_only: severity === 'SEV1' && FAIL_SAFE.has(c.workflow_id),
    text: `[${severity}] ${c.workflow_name} > ${c.node}: ${c.message.slice(0, 300)} (x${n} in 5 min)${c.execution_url ? `\n${c.execution_url}` : ''}`,
  },
}];

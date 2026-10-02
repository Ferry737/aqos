// WF-00 Supervisor: the system heartbeat, every 30 s. Probes services, reads
// freshness from the database, decides data-quality status and, if risk
// monitoring is blind, escalates the global mode. Alerts only on state change.
// Also pings an external dead-man URL so an outage of n8n itself is noticed.
import { workflow, schedule, code, http, pgFn, redisGet, redisSet, ifNode, cond, execWf } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS00Supervisor',
  name: 'AQOS-00 Supervisor',
  active: true,
  settings: { executionTimeout: 60, saveDataSuccessExecution: 'none' },
  nodes: [
    schedule('Every 30 s', { seconds: 30 }, { misfire: 'skip' }),
    code('Service registry', 'wf00-service-registry.js'),
    http('Probe /healthz', {
      url: '={{ $json.url }}', timeoutMs: 5000, neverError: true, fullResponse: true, onError: 'continueRegularOutput',
    }),
    pgFn('Freshness report', 'ops.freshness_report', { payload: '{}', executeOnce: true }),
    redisGet('Current global mode', 'aqos:mode:global', 'global_mode', { executeOnce: true }),
    code('Evaluate system state', 'wf00-evaluate-state.js'),
    redisSet('Write dq status', 'aqos:dq:status', '={{ $json.dq_status }}'),
    redisSet('Write global mode flag', 'aqos:mode:global', '={{ $("Evaluate system state").first().json.global_mode }}'),
    redisGet('Last fingerprint', 'aqos:sup:last_fp', 'last_fingerprint', { executeOnce: true }),
    code('Detect change', 'wf00-detect-change.js'),
    ifNode('Escalate?', [cond('={{ $json.escalate_to }}', 'string:notEmpty')]),
    pgFn('Apply escalation', 'risk.apply_mode', {
      payload: "{ scope: 'global', scope_id: '*', mode: $('Detect change').first().json.escalate_to, reason: 'supervisor:risk_monitor_blind', set_by: 'supervisor' }",
    }),
    redisSet('Mirror escalation', 'aqos:mode:global', '={{ $json.r.mode }}'),
    ifNode('Notify?', [cond('={{ $json.notify }}', 'boolean:true')]),
    redisSet('Save fingerprint', 'aqos:sup:last_fp', '={{ $("Detect change").first().json.fingerprint }}'),
    execWf('Notify', 'AQOS16Notifier00', { wait: false }),
    http('Dead-man ping', { url: '@@DEADMAN_URL@@', timeoutMs: 5000, neverError: true, onError: 'continueRegularOutput', note: 'External dead-man switch: alerts if this stops arriving.' }),
  ],
  connections: [
    ['Every 30 s', 'Service registry'],
    ['Service registry', 'Probe /healthz'],
    ['Probe /healthz', 'Freshness report'],
    ['Freshness report', 'Current global mode'],
    ['Current global mode', 'Evaluate system state'],
    ['Evaluate system state', 'Write dq status'],
    ['Write dq status', 'Write global mode flag'],
    ['Write global mode flag', 'Last fingerprint'],
    ['Last fingerprint', 'Detect change'],
    ['Detect change', 'Escalate?'],
    ['Escalate?', 'Apply escalation', { out: 'true' }],
    ['Apply escalation', 'Mirror escalation'],
    ['Detect change', 'Notify?'],
    ['Notify?', 'Save fingerprint', { out: 'true' }],
    ['Save fingerprint', 'Notify'],
    ['Detect change', 'Dead-man ping'],
  ],
});

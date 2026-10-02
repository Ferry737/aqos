// WF-13 Error handler: every other workflow names this as its error workflow.
// Classifies, de-duplicates (incident fingerprint), sets severity by recurrence,
// puts the system in REDUCE_ONLY if a capital-guarding path is failing, notifies.
import { workflow, errorTrigger, code, pgFn, ifNode, cond, redisSet, execWf } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS13ErrorHandl',
  name: 'AQOS-13 Error handler',
  active: false,
  settings: { executionTimeout: 60 },
  nodes: [
    errorTrigger('Workflow failed'),
    code('Classify error', 'wf13-classify-error.js'),
    pgFn('Record incident', 'ops.record_incident', {
      payload: '{ fingerprint: $json.fingerprint, workflow_id: $json.workflow_id, workflow_name: $json.workflow_name, node: $json.node, message: $json.message, window_s: 300 }',
    }),
    code('Severity policy', 'wf13-severity-policy.js'),
    ifNode('Fail safe?', [cond('={{ $json.fail_safe_reduce_only }}', 'boolean:true')]),
    pgFn('Escalate global mode', 'risk.apply_mode', {
      payload: "{ scope: 'global', scope_id: '*', mode: 'REDUCE_ONLY', reason: 'wf_failure:' + $('Severity policy').first().json.workflow_id, set_by: 'error_handler' }",
    }),
    redisSet('Mirror mode flag', 'aqos:mode:global', '={{ $json.r.mode }}'),
    ifNode('Notify?', [cond('={{ $json.severity !== "SEV3" || $json.occurrences_window === 1 }}', 'boolean:true')]),
    execWf('Notify', 'AQOS16Notifier00', { wait: false }),
  ],
  connections: [
    ['Workflow failed', 'Classify error'],
    ['Classify error', 'Record incident'],
    ['Record incident', 'Severity policy'],
    ['Severity policy', 'Fail safe?'],
    ['Severity policy', 'Notify?'],
    ['Fail safe?', 'Escalate global mode', { out: 'true' }],
    ['Escalate global mode', 'Mirror mode flag'],
    ['Notify?', 'Notify', { out: 'true' }],
  ],
});

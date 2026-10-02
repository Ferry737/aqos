// WF-05 Execution dispatch (sub-workflow): turns risk tokens into parent
// orders and sends one idempotent batch to the EMS. Re-checks the global flag
// after the gate. An EMS circuit breaker (3 failures / 120 s -> open 30 s) skips
// dispatch; a failed or timed-out send is SEND_UNCONFIRMED, never blindly
// re-sent, and counts as exposure until the EMS or reconciliation resolves it.
import { workflow, execTrigger, code, pgFn, redisGet, redisSet, redisIncr, redisDelete, ifNode, cond, http, execWf } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS05ExecDisptc',
  name: 'AQOS-05 Execution dispatch',
  active: false,
  settings: { executionTimeout: 120 },
  nodes: [
    execTrigger('Approved decisions in'),
    redisGet('EMS breaker state', 'aqos:breaker:ems', 'ems_breaker', { executeOnce: true }),
    redisGet('Global mode re-check', 'aqos:mode:global', 'redis_mode', { executeOnce: true }),
    code('Prepare dispatch', 'wf05-prepare-dispatch.js'),
    ifNode('Any skipped?', [cond('={{ $json.skipped_ids.length }}', 'number:gt', 0)]),
    pgFn('Mark not dispatched', 'risk.mark_not_dispatched', { payload: '{ decision_ids: $json.skipped_ids, reason: $json.skip_reason }' }),
    ifNode('Any to dispatch?', [cond('={{ $json.dispatch.length }}', 'number:gt', 0)]),
    pgFn('Register parent orders', 'oms.submit_parent_orders', {
      setof: true, payload: '{ orders: $("Prepare dispatch").first().json.dispatch }',
      note: 'Consumes each risk token atomically; refuses expired, mismatched or reused tokens. parent_order_id = decision_id.',
    }),
    code('EMS batch', 'wf05-ems-batch.js'),
    http('Send to EMS', {
      method: 'POST', url: 'http://ems:8080/v1/orders/batch', cred: 'emsAuth', timeoutMs: 10000, retries: 2, retryWaitMs: 1000, onError: 'continueErrorOutput',
      body: '={{ JSON.stringify($json.payload) }}', note: 'Idempotent: the EMS de-duplicates on parent_order_id.',
    }),
    pgFn('Mark sent', 'oms.mark_sent', { payload: '{ parent_order_ids: $("EMS batch").first().json.ids }' }),
    redisDelete('Reset breaker counter', 'aqos:breaker:ems_fails'),
    redisIncr('Count EMS failure', 'aqos:breaker:ems_fails', { ttlS: 120 }),
    code('Breaker', 'wf05-breaker.js'),
    pgFn('Mark unconfirmed', 'oms.mark_unconfirmed', { payload: "{ parent_order_ids: $json.parent_order_ids, reason: 'ems_send_failed' }" }),
    ifNode('Breaker open?', [cond('={{ $json.open }}', 'boolean:true')]),
    redisSet('Open breaker', 'aqos:breaker:ems', 'OPEN', { ttlS: 30 }),
    execWf('Notify', 'AQOS16Notifier00', { wait: false }),
  ],
  connections: [
    ['Approved decisions in', 'EMS breaker state'],
    ['EMS breaker state', 'Global mode re-check'],
    ['Global mode re-check', 'Prepare dispatch'],
    ['Prepare dispatch', 'Any skipped?'],
    ['Any skipped?', 'Mark not dispatched', { out: 'true' }],
    ['Prepare dispatch', 'Any to dispatch?'],
    ['Any to dispatch?', 'Register parent orders', { out: 'true' }],
    ['Register parent orders', 'EMS batch'],
    ['EMS batch', 'Send to EMS'],
    ['Send to EMS', 'Mark sent', { out: 'success' }],
    ['Mark sent', 'Reset breaker counter'],
    ['Send to EMS', 'Count EMS failure', { out: 'error' }],
    ['Count EMS failure', 'Breaker'],
    ['Breaker', 'Mark unconfirmed'],
    ['Breaker', 'Breaker open?'],
    ['Breaker open?', 'Open breaker', { out: 'true' }],
    ['Breaker', 'Notify'],
  ],
});

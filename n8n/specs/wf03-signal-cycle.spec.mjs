// WF-03 Signal cycle: every 5-minute bar. Triggered by the gateway's bar_close
// event with a schedule backstop; alpha.claim_cycle lets exactly one run each bar.
// Gates (global HALT, data quality) -> model predictions (validated) ->
// portfolio proposals -> risk gate sub-workflow. The LLM is not on this path.
import { workflow, execTrigger, schedule, code, pgFn, redisGet, switchNode, ifNode, cond, http, setFields, execWf, noop } from '../../tools/lib/dsl.mjs';

const CYCLE = '$("Cycle context").first().json';

export default workflow({
  id: 'AQOS03SignalCycl',
  name: 'AQOS-03 Signal cycle',
  active: true,
  settings: { executionTimeout: 280 },
  nodes: [
    execTrigger('Bar close (from gateway)'),
    schedule('Backstop every 5 min', { cron: '15 */5 * * * *' }, { misfire: 'skip', note: 'Fires 15 s after the bar; claim_cycle makes the event and the backstop idempotent.' }),
    code('Cycle context', 'wf03-cycle-context.js'),
    redisGet('Global mode', 'aqos:mode:global', 'redis_mode', { executeOnce: true }),
    redisGet('Data quality', 'aqos:dq:status', 'dq_status', { executeOnce: true }),
    pgFn('Claim cycle', 'alpha.claim_cycle', { payload: CYCLE }),
    code('Gate decision', 'wf03-gate-decision.js'),
    switchNode('Route cycle', [
      { key: 'proceed', conds: [cond('={{ $json.route }}', 'string:equals', 'proceed')] },
      { key: 'skip', conds: [cond('={{ $json.route }}', 'string:equals', 'skip')] },
    ], { fallback: 'duplicate' }),
    noop('Duplicate trigger', 'Another trigger already claimed this bar'),
    pgFn('Mark cycle skipped', 'alpha.mark_cycle', {
      payload: "{ cycle_id: $json.cycle_id, status: 'SKIPPED', detail: { reason: $json.skip_reason } }",
    }),
    http('Request predictions', {
      method: 'POST', url: 'http://model-svc:8080/v1/predict', cred: 'modelSvcAuth', timeoutMs: 60000, retries: 2, retryWaitMs: 3000, onError: 'continueRegularOutput',
      body: '={{ JSON.stringify({ cycle_id: $json.cycle_id, bar_ts: $json.bar_ts, strategy_set: $json.strategy_set }) }}',
      note: 'Custom model service (Python): LightGBM/Transformer/LSTM ensemble, deterministic per cycle_id.',
    }),
    code('Validate predictions', 'wf03-validate-predictions.js'),
    ifNode('Predictions OK?', [cond('={{ $json.ok }}', 'boolean:true')]),
    pgFn('Mark cycle failed', 'alpha.mark_cycle', {
      payload: "{ cycle_id: $json.cycle_id, status: 'FAILED_VALIDATION', detail: { reason: $json.reason, rejected: $json.rejected_count, sample: $json.sample_rejections } }",
    }),
    setFields('Predictions invalid notice', {
      severity: 'SEV2',
      text: { expr: '={{ "[SEV2] Cycle " + $json.cycle_id + " not traded: predictions invalid (" + $json.reason + ")" }}' },
      dedup_key: 'cycle-predictions-invalid',
    }, { keepOthers: false }),
    http('Request proposals', {
      method: 'POST', url: 'http://portfolio-svc:8080/v1/propose', cred: 'portfolioSvcAuth', timeoutMs: 60000, retries: 2, retryWaitMs: 3000, onError: 'continueRegularOutput',
      body: '={{ JSON.stringify({ cycle_id: $json.cycle_id, bar_ts: $json.bar_ts, predictions: $json.kept }) }}',
      note: 'Custom portfolio service: HRP / risk-budget optimiser, vol-targeted sizing, no-trade bands.',
    }),
    code('Prepare cycle outputs', 'wf03-prepare-outputs.js'),
    pgFn('Record cycle outputs', 'alpha.record_cycle_outputs', { payload: '{ cycle_id: $json.cycle_id, predictions: $json.predictions, proposals: $json.proposals }' }),
    ifNode('Has proposals?', [cond('={{ $("Prepare cycle outputs").first().json.proposals.length }}', 'number:gt', 0)]),
    code('Fan out proposals', 'wf03-fan-out.js'),
    execWf('Risk gate', 'AQOS04RiskGate00', { wait: true, note: 'All proposals of the cycle go through one gate call so exposure accumulates correctly.' }),
    pgFn('Finish cycle', 'alpha.finish_cycle', { payload: '{ cycle_id: $("Prepare cycle outputs").first().json.cycle_id }' }),
    code('Cycle summary', 'wf03-cycle-summary.js'),
    ifNode('Notify?', [cond('={{ $json.notify }}', 'boolean:true')]),
    execWf('Notify', 'AQOS16Notifier00', { wait: false }),
  ],
  connections: [
    ['Bar close (from gateway)', 'Cycle context'],
    ['Backstop every 5 min', 'Cycle context'],
    ['Cycle context', 'Global mode'],
    ['Global mode', 'Data quality'],
    ['Data quality', 'Claim cycle'],
    ['Claim cycle', 'Gate decision'],
    ['Gate decision', 'Route cycle'],
    ['Route cycle', 'Request predictions', { out: 'proceed' }],
    ['Route cycle', 'Mark cycle skipped', { out: 'skip' }],
    ['Route cycle', 'Duplicate trigger', { out: 'duplicate' }],
    ['Request predictions', 'Validate predictions'],
    ['Validate predictions', 'Predictions OK?'],
    ['Predictions OK?', 'Request proposals', { out: 'true' }],
    ['Predictions OK?', 'Mark cycle failed', { out: 'false' }],
    ['Mark cycle failed', 'Predictions invalid notice'],
    ['Predictions invalid notice', 'Notify'],
    ['Request proposals', 'Prepare cycle outputs'],
    ['Prepare cycle outputs', 'Record cycle outputs'],
    ['Record cycle outputs', 'Has proposals?'],
    ['Has proposals?', 'Fan out proposals', { out: 'true' }],
    ['Fan out proposals', 'Risk gate'],
    ['Risk gate', 'Finish cycle'],
    ['Has proposals?', 'Finish cycle', { out: 'false' }],
    ['Finish cycle', 'Cycle summary'],
    ['Cycle summary', 'Notify?'],
    ['Notify?', 'Notify', { out: 'true' }],
  ],
});

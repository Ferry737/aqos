// WF-08 Portfolio agent: hourly drift rebalancing (through the same risk gate)
// and a daily meta-learner reallocation across strategies with bounded autonomy
// (max 5 pp per strategy and 15% turnover per day). Anything outside the
// envelope, or flagged by the reviewing agent, waits for a human approval link.
import { workflow, schedule, code, pgFn, http, claude, ifNode, cond, node, setFields, waitForLink, execWf } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS08PortfolioA',
  name: 'AQOS-08 Portfolio agent',
  active: true,
  settings: { executionTimeout: 21600 },
  nodes: [
    // ---- hourly drift rebalance
    schedule('Hourly drift check', { cron: '0 5 * * * *' }, { misfire: 'skip' }),
    pgFn('Drift report', 'pm.drift_report', { setof: true, payload: '{}' }),
    code('Rebalance request', 'wf08-rebalance-request.js'),
    http('Request rebalance', {
      method: 'POST', url: 'http://portfolio-svc:8080/v1/rebalance', cred: 'portfolioSvcAuth', timeoutMs: 60000, retries: 2, retryWaitMs: 3000, onError: 'continueRegularOutput',
      body: '={{ JSON.stringify($json) }}',
    }),
    code('Prepare rebalance proposals', 'wf08-prepare-proposals.js'),
    execWf('Risk gate (rebalance)', 'AQOS04RiskGate00', { wait: true }),
    // ---- daily strategy allocation
    schedule('Daily meta-learner 06:10 UTC', { cron: '0 10 6 * * *' }, { misfire: 'coalesce_owner', graceS: 7200 }),
    http('Request allocation', {
      method: 'POST', url: 'http://portfolio-svc:8080/v1/allocation/propose', cred: 'portfolioSvcAuth', timeoutMs: 60000, retries: 2, retryWaitMs: 3000, onError: 'continueRegularOutput',
      body: '={{ { as_of: $now.toISO() } }}', note: 'Custom meta-learner (online / bandit allocation over strategy sleeves).',
    }),
    code('Bounded-change policy', 'wf08-bounded-change.js'),
    code('Build review request', 'wf08-review-request.js'),
    claude('Claude review'),
    code('Decide path', 'wf08-decide-path.js'),
    ifNode('Auto-apply?', [cond('={{ $json.path }}', 'string:equals', 'apply')]),
    pgFn('Apply allocation', 'pm.apply_allocation', {
      payload: "{ weights: $json.proposed_weights, proposed_by: 'meta_learner', rationale: $json.rationale }",
    }),
    setFields('Allocation applied notice', {
      severity: 'INFO',
      text: { expr: '={{ "[ALLOCATION] v" + $json.r.version_id + " applied automatically (within bounds): " + $("Decide path").first().json.deltas.filter(d => Math.abs(d.delta) > 1e-9).map(d => d.strategy + " " + (d.delta * 100).toFixed(1) + "pp").join(", ") }}' },
    }, { keepOthers: false }),
    node('Approval token', 'n8n-nodes-base.crypto', { action: 'generate', dataPropertyName: 'token', encodingType: 'hex', stringLength: 64 }),
    pgFn('Stage allocation', 'pm.stage_allocation', {
      payload: "{ weights: $('Decide path').first().json.proposed_weights, token: $('Approval token').first().json.token, proposed_by: 'meta_learner', rationale: $('Decide path').first().json.rationale, ttl_s: 14400 }",
    }),
    code('Build approval message', 'wf08-approval-message.js'),
    execWf('Send approval request', 'AQOS16Notifier00', { wait: true }),
    waitForLink('Wait for approval', { hours: 4 }),
    code('Approval result', 'wf08-approval-result.js'),
    pgFn('Verify approval', 'pm.verify_approval', { payload: '$json' }),
    setFields('Approval outcome notice', {
      severity: 'INFO',
      text: { expr: '={{ "[ALLOCATION] v" + $("Approval result").first().json.version_id + ": " + ($json.r.approved ? "approved by " + $("Approval result").first().json.approver + " and applied" : "not applied (" + $json.r.reason + ")") }}' },
    }, { keepOthers: false }),
    execWf('Notify', 'AQOS16Notifier00', { wait: false }),
  ],
  connections: [
    ['Hourly drift check', 'Drift report'],
    ['Drift report', 'Rebalance request'],
    ['Rebalance request', 'Request rebalance'],
    ['Request rebalance', 'Prepare rebalance proposals'],
    ['Prepare rebalance proposals', 'Risk gate (rebalance)'],
    ['Daily meta-learner 06:10 UTC', 'Request allocation'],
    ['Request allocation', 'Bounded-change policy'],
    ['Bounded-change policy', 'Build review request'],
    ['Build review request', 'Claude review'],
    ['Claude review', 'Decide path'],
    ['Decide path', 'Auto-apply?'],
    ['Auto-apply?', 'Apply allocation', { out: 'true' }],
    ['Apply allocation', 'Allocation applied notice'],
    ['Allocation applied notice', 'Notify'],
    ['Auto-apply?', 'Approval token', { out: 'false' }],
    ['Approval token', 'Stage allocation'],
    ['Stage allocation', 'Build approval message'],
    ['Build approval message', 'Send approval request'],
    ['Send approval request', 'Wait for approval'],
    ['Wait for approval', 'Approval result'],
    ['Approval result', 'Verify approval'],
    ['Verify approval', 'Approval outcome notice'],
    ['Approval outcome notice', 'Notify'],
  ],
});

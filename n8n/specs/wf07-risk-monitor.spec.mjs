// WF-07 Risk monitor: every 15 s and on market-stress events. Pulls the risk
// service snapshot (falls back to a DB-only snapshot), evaluates the breaker
// ladder deterministically, applies ratcheted mode changes, fires kills, and
// hands ACT-level breaches to the risk analyst agent for explanation.
import { workflow, schedule, execTrigger, http, pgFn, code, ifNode, cond, redisSet, redisGet, execWf } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS07RiskMonitr',
  name: 'AQOS-07 Risk monitor',
  active: true,
  settings: { executionTimeout: 60, saveDataSuccessExecution: 'none' },
  nodes: [
    schedule('Every 15 s', { seconds: 15 }, { misfire: 'skip' }),
    execTrigger('Market stress event'),
    http('Risk service snapshot', {
      url: 'http://risk-svc:8080/v1/snapshot', cred: 'riskSvcAuth', timeoutMs: 4000, retries: 1, retryWaitMs: 500, onError: 'continueErrorOutput',
      note: 'Custom risk service: 99% 1-day VaR, 97.5% ES, correlation absorption, liquidation distance in sigmas, stablecoin peg, venue health.',
    }),
    pgFn('DB fallback snapshot', 'risk.snapshot_basic', { as: 's', payload: '{}' }),
    code('Normalize snapshot', 'wf07-normalize-snapshot.js'),
    pgFn('Breaker context', 'risk.breaker_context', { as: 'c', payload: '{}' }),
    code('Evaluate breakers', 'wf07-evaluate-breakers.js'),
    pgFn('Apply mode changes', 'risk.apply_actions', { payload: '$json' }),
    code('Plan follow-ups', 'wf07-plan-followups.js'),
    ifNode('Global mode changed?', [cond('={{ $json.mirror_global_mode }}', 'string:notEmpty')]),
    redisSet('Mirror global mode', 'aqos:mode:global', '={{ $json.mirror_global_mode }}'),
    ifNode('Kills needed?', [cond('={{ $json.kills.length }}', 'number:gt', 0)]),
    code('Fan out kills', 'common-fan-out-kills.js', { replace: { __SOURCE__: 'Plan follow-ups' } }),
    execWf('Kill switch', 'AQOS14KillSwitch', { wait: false }),
    redisGet('Last alert fingerprint', 'aqos:risk:last_alert_fp', 'last_alert_fp', { executeOnce: true }),
    code('Dedupe alert', 'wf07-dedupe-alert.js'),
    redisSet('Save alert fingerprint', 'aqos:risk:last_alert_fp', '={{ $json.fingerprint }}'),
    execWf('Notify', 'AQOS16Notifier00', { wait: false }),
    ifNode('Needs analyst?', [cond('={{ $json.severity }}', 'string:equals', 'ACT')]),
    execWf('Risk analyst', 'AQOS15RiskAnalys', { wait: false }),
  ],
  connections: [
    ['Every 15 s', 'Risk service snapshot'],
    ['Market stress event', 'Risk service snapshot'],
    ['Risk service snapshot', 'Normalize snapshot', { out: 'success' }],
    ['Risk service snapshot', 'DB fallback snapshot', { out: 'error' }],
    ['DB fallback snapshot', 'Normalize snapshot'],
    ['Normalize snapshot', 'Breaker context'],
    ['Breaker context', 'Evaluate breakers'],
    ['Evaluate breakers', 'Apply mode changes'],
    ['Apply mode changes', 'Plan follow-ups'],
    ['Plan follow-ups', 'Global mode changed?'],
    ['Global mode changed?', 'Mirror global mode', { out: 'true' }],
    ['Plan follow-ups', 'Kills needed?'],
    ['Kills needed?', 'Fan out kills', { out: 'true' }],
    ['Fan out kills', 'Kill switch'],
    ['Plan follow-ups', 'Last alert fingerprint'],
    ['Last alert fingerprint', 'Dedupe alert'],
    ['Dedupe alert', 'Save alert fingerprint'],
    ['Save alert fingerprint', 'Notify'],
    ['Dedupe alert', 'Needs analyst?'],
    ['Needs analyst?', 'Risk analyst', { out: 'true' }],
  ],
});

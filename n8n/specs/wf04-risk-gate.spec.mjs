// WF-04 Risk gate (sub-workflow): the only door between a trade idea and an
// order. Deterministic checks, fail-closed. Every decision becomes a
// single-use, expiring token in Postgres; escalations tighten modes / kill.
import { workflow, execTrigger, code, pgFn, redisGet, ifNode, cond, execWf } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS04RiskGate00',
  name: 'AQOS-04 Risk gate',
  active: false,
  settings: { executionTimeout: 120 },
  nodes: [
    execTrigger('Proposals in'),
    code('Gate scope', 'wf04-gate-scope.js'),
    pgFn('Load risk context', 'risk.gate_context', { as: 'ctx', payload: '$json' }),
    redisGet('Global mode (fast flag)', 'aqos:mode:global', 'redis_mode', { executeOnce: true }),
    code('Pre-trade checks', 'wf04-pretrade-checks.js'),
    pgFn('Record decisions', 'risk.record_decisions', { setof: true, payload: '{ decisions: $json.decisions }' }),
    ifNode('Approved or resized?', [cond('={{ $json.decision }}', 'string:notEquals', 'REJECT')]),
    execWf('Dispatch orders', 'AQOS05ExecDisptc', { wait: true }),
    code('Collect escalations', 'wf04-collect-escalations.js'),
    pgFn('Apply mode escalations', 'risk.apply_actions', { payload: '$json' }),
    code('Fan out kills', 'common-fan-out-kills.js', { replace: { __SOURCE__: 'Collect escalations' } }),
    execWf('Kill switch', 'AQOS14KillSwitch', { wait: false }),
  ],
  connections: [
    ['Proposals in', 'Gate scope'],
    ['Gate scope', 'Load risk context'],
    ['Load risk context', 'Global mode (fast flag)'],
    ['Global mode (fast flag)', 'Pre-trade checks'],
    ['Pre-trade checks', 'Record decisions'],
    ['Record decisions', 'Approved or resized?'],
    ['Approved or resized?', 'Dispatch orders', { out: 'true' }],
    ['Pre-trade checks', 'Collect escalations'],
    ['Collect escalations', 'Apply mode escalations'],
    ['Apply mode escalations', 'Fan out kills'],
    ['Fan out kills', 'Kill switch'],
  ],
});

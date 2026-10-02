// Classifies any workflow failure routed here by the n8n Error Trigger.
const CRITICAL = new Set(['AQOS03SignalCycl', 'AQOS04RiskGate00', 'AQOS05ExecDisptc', 'AQOS06Settlement', 'AQOS07RiskMonitr', 'AQOS14KillSwitch']);
const HIGH = new Set(['AQOS00Supervisor', 'AQOS01EventGatew', 'AQOS08PortfolioA']);
const TRANSIENT = /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|timed? ?out|\b429\b|\b502\b|\b503\b|\b504\b|Too Many Requests|overloaded)/i;
const e = $input.first().json;
const wf = e.workflow ?? {};
const ex = e.execution ?? {};
const err = ex.error ?? e.trigger?.error ?? {};
const node = ex.lastNodeExecuted ?? err.node?.name ?? 'trigger';
const message = String(err.message ?? 'unknown error').slice(0, 1500);
const transient = TRANSIENT.test(message) || TRANSIENT.test(String(err.description ?? ''));
const criticality = CRITICAL.has(wf.id) ? 'critical' : HIGH.has(wf.id) ? 'high' : 'normal';
const normalized = message.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>').replace(/\d+/g, '#').slice(0, 160);
return [{
  json: {
    workflow_id: wf.id ?? 'unknown',
    workflow_name: wf.name ?? 'unknown',
    execution_id: ex.id ?? null,
    execution_url: ex.url ?? null,
    node,
    message,
    transient,
    criticality,
    fingerprint: `${wf.id ?? 'unknown'}:${node}:${normalized}`,
  },
}];

// WF-12 Client reports (daily): the communication agent writes a short factual
// narrative from each client's own metrics; a deterministic compliance gate
// (banned phrases, numbers must exist in the data, no links) decides whether
// it is used or replaced by the template-only report. Tables and the
// disclosure footer are rendered by code. One report per client per period.
import { workflow, schedule, pgFn, pg, splitInBatches, code, claude, node, emailSend, execWf } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS12ClientRepo',
  name: 'AQOS-12 Client reports',
  active: true,
  settings: { executionTimeout: 3600 },
  nodes: [
    schedule('Daily reports 01:00 UTC', { cron: '0 0 1 * * *' }, { misfire: 'coalesce_owner', graceS: 7200 }),
    pgFn('Reports due', 'biz.reports_due', { setof: true, payload: '{}' }),
    splitInBatches('Batches of 20', 20),
    code('Build narrative request', 'wf12-narrative-request.js'),
    claude('Claude narrative'),
    code('Compliance gate', 'wf12-compliance-gate.js'),
    code('Render email', 'wf12-render-email.js'),
    node('Content hash', 'n8n-nodes-base.crypto', { action: 'hash', binaryData: false, type: 'SHA256', value: '={{ $json.hash_input }}', dataPropertyName: 'content_sha256', encoding: 'hex' }),
    emailSend('Send report', { to: '={{ $("Content hash").item.json.to }}', subject: '={{ $("Content hash").item.json.subject }}', html: '={{ $("Content hash").item.json.html }}' }),
    pgFn('Record report', 'biz.record_report', {
      payload: '{ client_id: $("Content hash").item.json.client_id, period: $("Content hash").item.json.period, content_sha256: $("Content hash").item.json.content_sha256, llm_model: $("Content hash").item.json.compliance.model, compliance: $("Content hash").item.json.compliance }',
    }),
    pg('Count run results', "SELECT count(*)::int AS sent, count(*) FILTER (WHERE (compliance->>'pass')::boolean IS NOT TRUE)::int AS fallback FROM biz.reports WHERE sent_at > now() - interval '3 hours'", { params: null, executeOnce: true }),
    code('Run summary', 'wf12-run-summary.js'),
    execWf('Notify', 'AQOS16Notifier00', { wait: false }),
  ],
  connections: [
    ['Daily reports 01:00 UTC', 'Reports due'],
    ['Reports due', 'Batches of 20'],
    ['Batches of 20', 'Count run results', { out: 'done' }],
    ['Batches of 20', 'Build narrative request', { out: 'loop' }],
    ['Build narrative request', 'Claude narrative'],
    ['Claude narrative', 'Compliance gate'],
    ['Compliance gate', 'Render email'],
    ['Render email', 'Content hash'],
    ['Content hash', 'Send report'],
    ['Send report', 'Record report'],
    ['Record report', 'Batches of 20'],
    ['Count run results', 'Run summary'],
    ['Run summary', 'Notify'],
  ],
});

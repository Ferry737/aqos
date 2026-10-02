// WF-10 Client onboarding: signup -> policy validation -> sanctions screening ->
// client record (everyone starts in PAPER mode) -> welcome. API keys are
// inspected on the venue itself: trading allowed, withdrawals and transfers
// disabled, IP allowlisted; anything else is rejected and destroyed.
// A daily job invites clients who passed the graduation gate to go live.
import { workflow, webhook, schedule, code, http, pgFn, ifNode, switchNode, cond, respond, emailSend, execWf, setFields } from '../../tools/lib/dsl.mjs';

const WELCOME = '<p>Welcome to AQOS. Your account starts in <strong>paper trading</strong>: no real money is used until you complete the knowledge check, accept the risk disclosure, and connect a trade-only exchange key.</p><p>AQOS is software that runs strategies in your own exchange account. We never hold your funds. Nothing we send you is investment advice, and results can include total loss of capital.</p>';
const INVITE = '<p>You have completed the paper-trading period and the knowledge check. You can now choose to connect a live, trade-only exchange key from your dashboard (@@DASHBOARD_URL@@).</p><p>Going live is optional. Review the fee schedule and risk disclosure again before you decide. AQOS does not provide investment advice.</p>';

export default workflow({
  id: 'AQOS10Onboarding',
  name: 'AQOS-10 Client onboarding',
  active: true,
  settings: { executionTimeout: 120 },
  nodes: [
    // ---- signup
    webhook('Signup', { path: 'aqos/signup', auth: 'inbound', respond: 'responseNode' }),
    code('Validate signup', 'wf10-validate-signup.js'),
    ifNode('Valid?', [cond('={{ $json.valid }}', 'boolean:true')]),
    respond('Reject invalid', { code: 422, body: '={{ { ok: false, errors: $json.errors } }}' }),
    ifNode('Blocked jurisdiction?', [cond('={{ $json.blocked }}', 'boolean:true')]),
    pgFn('Record blocked applicant', 'biz.create_client', {
      payload: "Object.assign({}, $json.client, { status: 'BLOCKED', screening: { result: 'JURISDICTION' } })",
    }),
    respond('Respond not served', { code: 200, body: { ok: true, status: 'unavailable', message: 'We are not able to offer this service in your region.' } }),
    http('Sanctions and PEP screening', {
      method: 'POST', url: '@@SCREENING_URL@@', cred: 'screeningAuth', timeoutMs: 15000, retries: 2, retryWaitMs: 2000, onError: 'continueRegularOutput',
      body: '={{ JSON.stringify($json.screening_request) }}', note: 'Third-party KYC/AML provider (custom integration). Result: CLEAR | REVIEW | HIT.',
    }),
    code('Screening outcome', 'wf10-screening-outcome.js'),
    pgFn('Create client', 'biz.create_client', { payload: '$json.create' }),
    respond('Respond received', { code: 200, body: '={{ { ok: true, status: $("Screening outcome").first().json.route, client_id: $json.r.client_id } }}' }),
    switchNode('Route by status', [
      { key: 'active', conds: [cond('={{ $("Screening outcome").first().json.route }}', 'string:equals', 'ACTIVE')] },
    ], { fallback: 'review' }),
    emailSend('Send welcome email', { to: '={{ $("Screening outcome").first().json.email }}', subject: 'Welcome to AQOS: paper trading is ready', html: WELCOME }),
    setFields('Compliance review notice', {
      severity: 'SEV3',
      text: { expr: '={{ "[ONBOARDING] application held for compliance review: client " + $json.r.client_id }}' },
    }, { keepOthers: false }),
    // ---- API key connected
    webhook('Key connected', { path: 'aqos/keys', auth: 'inbound', respond: 'responseNode', note: 'Called by the client portal after the key is stored in the vault. Body: { account_id, client_id, venue, key_ref, email, derivatives_allowed }.' }),
    http('Inspect key permissions', {
      method: 'POST', url: 'http://ems:8080/v1/keys/inspect', cred: 'emsAuth', timeoutMs: 15000, retries: 2, onError: 'continueRegularOutput',
      body: '={{ JSON.stringify({ venue: $json.body.venue, key_ref: $json.body.key_ref }) }}',
      note: 'The EMS reads the key permissions from the venue itself; the portal is not trusted for this.',
    }),
    code('Key policy', 'wf10-key-policy.js'),
    pgFn('Record key status', 'biz.mark_key_status', {
      payload: '{ account_id: $json.account_id, client_id: $json.client_id, venue: $json.venue, key_ref: $json.key_ref, status: $json.status, permissions: $json.permissions }',
    }),
    ifNode('Key verified?', [cond('={{ $("Key policy").first().json.status }}', 'string:equals', 'VERIFIED')]),
    respond('Respond verified', { code: 200, body: { ok: true, status: 'VERIFIED' } }),
    http('Destroy rejected key', {
      method: 'POST', url: 'http://ems:8080/v1/keys/destroy', cred: 'emsAuth', timeoutMs: 15000, retries: 3, onError: 'continueRegularOutput',
      body: '={{ JSON.stringify({ key_ref: $("Key policy").first().json.key_ref }) }}',
    }),
    respond('Respond rejected', { code: 200, body: '={{ { ok: false, status: "REJECTED", instructions: $("Key policy").first().json.instructions } }}' }),
    // ---- graduation invitations
    schedule('Daily graduation check', { cron: '0 0 9 * * *' }, { misfire: 'skip' }),
    pgFn('Graduation candidates', 'biz.graduation_candidates', { setof: true, payload: '{ min_paper_days: 14 }' }),
    emailSend('Send live-access invitation', { to: '={{ $json.email }}', subject: 'You can now choose to go live', html: INVITE }),
    execWf('Notify', 'AQOS16Notifier00', { wait: false }),
  ],
  connections: [
    ['Signup', 'Validate signup'],
    ['Validate signup', 'Valid?'],
    ['Valid?', 'Reject invalid', { out: 'false' }],
    ['Valid?', 'Blocked jurisdiction?', { out: 'true' }],
    ['Blocked jurisdiction?', 'Record blocked applicant', { out: 'true' }],
    ['Record blocked applicant', 'Respond not served'],
    ['Blocked jurisdiction?', 'Sanctions and PEP screening', { out: 'false' }],
    ['Sanctions and PEP screening', 'Screening outcome'],
    ['Screening outcome', 'Create client'],
    ['Create client', 'Respond received'],
    ['Respond received', 'Route by status'],
    ['Route by status', 'Send welcome email', { out: 'active' }],
    ['Route by status', 'Compliance review notice', { out: 'review' }],
    ['Compliance review notice', 'Notify'],
    ['Key connected', 'Inspect key permissions'],
    ['Inspect key permissions', 'Key policy'],
    ['Key policy', 'Record key status'],
    ['Record key status', 'Key verified?'],
    ['Key verified?', 'Respond verified', { out: 'true' }],
    ['Key verified?', 'Destroy rejected key', { out: 'false' }],
    ['Destroy rejected key', 'Respond rejected'],
    ['Daily graduation check', 'Graduation candidates'],
    ['Graduation candidates', 'Send live-access invitation'],
  ],
});

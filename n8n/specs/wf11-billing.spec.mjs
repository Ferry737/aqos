// WF-11 Billing sync: Stripe events are applied idempotently. A lapsed
// subscription never liquidates anyone: accounts move to reduce-only (a
// "billing:" hold that only payment can lift) and the client keeps control.
// A weekly guardrail tells clients whose plan costs more than 2% a year of
// their connected capital.
import { workflow, stripeTrigger, schedule, code, pgFn, pg, ifNode, cond, emailSend } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS11Billing000',
  name: 'AQOS-11 Billing sync',
  active: true,
  settings: { executionTimeout: 60 },
  nodes: [
    stripeTrigger('Stripe events', ['invoice.paid', 'invoice.payment_failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'checkout.session.completed']),
    code('Normalize Stripe event', 'wf11-normalize-stripe.js'),
    pgFn('Apply billing event', 'biz.apply_billing_event', { payload: '$json' }),
    ifNode('Client matched?', [
      cond('={{ $json.r.client_id }}', 'string:notEmpty'),
      cond('={{ $json.r.duplicate }}', 'boolean:false'),
    ]),
    pg('Client email', 'SELECT email FROM biz.clients WHERE client_id = $1::uuid', { params: '={{ $json.r.client_id }}' }),
    code('Billing message', 'wf11-billing-message.js'),
    emailSend('Send billing notice', { to: '={{ $json.to }}', subject: '={{ $json.subject }}', html: '={{ "<p>" + $json.text.replace(/\\n/g, "<br>") + "</p>" }}' }),
    // ---- weekly fee-burden guardrail
    schedule('Weekly fee check (Mon 08:00 UTC)', { cron: '0 0 8 * * 1' }, { misfire: 'coalesce_owner', graceS: 21600 }),
    pgFn('Fee burden report', 'biz.fee_burden_report', { setof: true, payload: '{ threshold_annual_pct: 2 }' }),
    code('Fee burden message', 'wf11-fee-burden-message.js'),
    emailSend('Send fee notice', { to: '={{ $json.to }}', subject: '={{ $json.subject }}', html: '={{ "<p>" + $json.text.replace(/\\n/g, "<br>") + "</p>" }}' }),
  ],
  connections: [
    ['Stripe events', 'Normalize Stripe event'],
    ['Normalize Stripe event', 'Apply billing event'],
    ['Apply billing event', 'Client matched?'],
    ['Client matched?', 'Client email', { out: 'true' }],
    ['Client email', 'Billing message'],
    ['Billing message', 'Send billing notice'],
    ['Weekly fee check (Mon 08:00 UTC)', 'Fee burden report'],
    ['Fee burden report', 'Fee burden message'],
    ['Fee burden message', 'Send fee notice'],
  ],
});

// Client-facing billing notices. A lapsed subscription never liquidates:
// accounts move to reduce-only and the client keeps full control.
const r = $('Apply billing event').first().json.r ?? {};
if (r.duplicate || r.unmatched || r.ignored || !r.client_id) return [];
const email = $input.first().json.email;
const copy = {
  PAST_DUE: {
    subject: 'Payment failed: your AQOS subscription',
    text: 'We could not collect your subscription payment. Nothing changes for 7 days. After that, automation for your connected accounts switches to reduce-only: no new positions are opened and existing positions are not liquidated. Update your payment method in the dashboard to avoid this.',
  },
  PAUSED_BILLING: {
    subject: 'Automation paused to reduce-only',
    text: 'Your subscription is paused, so automation for your connected accounts is now reduce-only. We have not closed any positions. You can manage positions directly on your exchange at any time, or resume the subscription in the dashboard.',
  },
  CANCELED: {
    subject: 'Your AQOS subscription has ended',
    text: 'Your subscription has ended. Automation is reduce-only and we have not closed any positions. Your exchange account and funds remain under your control. You can export your full trade and audit history from the dashboard for 90 days.',
  },
  ACTIVE: {
    subject: 'Your AQOS subscription is active',
    text: 'Your subscription is active. If automation was paused for billing, it has returned to the mode you configured.',
  },
}[r.status];
if (!copy || !email) return [];
return [{ json: { to: email, subject: copy.subject, text: `${copy.text}\n\nThis is a service notice from AQOS, a software platform. It is not investment advice.` } }];

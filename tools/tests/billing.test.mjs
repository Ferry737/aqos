// Unit tests for the wf11 billing Code-node scripts: Stripe normalization,
// client-facing billing notices and the fee-burden guardrail message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFirst, runCodeNode } from '../lib/sandbox.mjs';

// ------------------------------------------------------------------ fixtures
const price = (o = {}) => ({ lookup_key: 'tier_pro', currency: 'usd', recurring: { interval: 'month' }, unit_amount: 19900, ...o });
const stripe = (o = {}) => runFirst('wf11-normalize-stripe.js', { input: [{ id: 'evt_1', type: 'invoice.paid', data: { object: o } }] });
const invoice = (o = {}) => ({ object: 'invoice', customer: 'cus_1', subscription: 'sub_1', lines: { data: [{ price: price() }] }, ...o });

const notice = (r, email = 'c1@example.com') => runCodeNode('wf11-billing-message.js', {
  input: [{ email }], nodes: { 'Apply billing event': [{ r }] },
});
const noEmail = (r) => runCodeNode('wf11-billing-message.js', { input: [{}], nodes: { 'Apply billing event': [{ r }] } });
const only = async (r, email) => (await notice(r, email))[0]?.json;

// ------------------------------------------------------------ normalize stripe
test('normalize: an invoice copies the id, type, customer and subscription', async () => {
  const r = await stripe(invoice());
  assert.equal(r.event_id, 'evt_1');
  assert.equal(r.type, 'invoice.paid');
  assert.equal(r.customer_id, 'cus_1');
  assert.equal(r.subscription_id, 'sub_1');
  assert.equal(r.subscription_status, null);
});
test('normalize: a subscription object is its own id and carries the status', async () => {
  const r = await stripe({ object: 'subscription', id: 'sub_9', status: 'past_due', customer: 'cus_2' });
  assert.equal(r.subscription_id, 'sub_9');
  assert.equal(r.subscription_status, 'past_due');
});
test('normalize: a USD monthly price is a monthly fee in dollars', async () => {
  assert.equal((await stripe(invoice())).monthly_fee_usd, 199);
  assert.equal((await stripe(invoice({ lines: { data: [{ price: price({ unit_amount: 250 }) }] } }))).monthly_fee_usd, 2.5);
});
test('normalize: a yearly, non-USD or missing price gives no monthly fee', async () => {
  assert.equal((await stripe(invoice({ lines: { data: [{ price: price({ recurring: { interval: 'year' } }) }] } }))).monthly_fee_usd, null);
  assert.equal((await stripe(invoice({ lines: { data: [{ price: price({ currency: 'eur' }) }] } }))).monthly_fee_usd, null);
  assert.equal((await stripe(invoice({ lines: { data: [{}] } }))).monthly_fee_usd, null);
  assert.equal((await stripe({ object: 'invoice', customer: 'cus_1' })).monthly_fee_usd, null);
});
test('normalize: a zero-amount USD monthly price is zero, not missing', async () => {
  const r = await stripe(invoice({ lines: { data: [{ price: price({ unit_amount: 0 }) }] } }));
  assert.equal(r.monthly_fee_usd, 0);
});
test('normalize: the tier comes from the price lookup key, else the metadata', async () => {
  assert.equal((await stripe(invoice())).tier, 'tier_pro');
  assert.equal((await stripe(invoice({ lines: { data: [{ price: price({ lookup_key: undefined }) }] }, metadata: { tier: 'tier_basic' } }))).tier, 'tier_basic');
  assert.equal((await stripe(invoice({ lines: { data: [{}] } }))).tier, null);
});
test('normalize: client_ref comes from client_reference_id, else metadata', async () => {
  assert.equal((await stripe(invoice({ client_reference_id: 'cl_1' }))).client_ref, 'cl_1');
  assert.equal((await stripe(invoice({ metadata: { client_ref: 'cl_2' } }))).client_ref, 'cl_2');
  assert.equal((await stripe(invoice({ client_reference_id: 'cl_1', metadata: { client_ref: 'cl_2' } }))).client_ref, 'cl_1');
  assert.equal((await stripe(invoice())).client_ref, null);
});
test('normalize: a subscription reads its price from items and an empty event is all nulls', async () => {
  const sub = await stripe({ object: 'subscription', id: 'sub_3', status: 'active', items: { data: [{ price: price({ unit_amount: 1000 }) }] } });
  assert.equal(sub.monthly_fee_usd, 10);
  assert.equal(sub.tier, 'tier_pro');
  const r = await stripe({});
  assert.equal(r.customer_id, null);
  assert.equal(r.subscription_id, null);
  assert.equal(r.subscription_status, null);
  assert.equal(r.monthly_fee_usd, null);
});

// ------------------------------------------------------------- billing notices
test('billing notice: a past due payment says positions are not liquidated', async () => {
  const m = await only({ client_id: 'c1', status: 'PAST_DUE' });
  assert.equal(m.to, 'c1@example.com');
  assert.equal(m.subject, 'Payment failed: your AQOS subscription');
  assert.match(m.text, /not liquidated/);
  assert.match(m.text, /not investment advice/);
  assert.match(m.text, /reduce-only/);
});
test('billing notice: a paused subscription says no positions were closed', async () => {
  const m = await only({ client_id: 'c1', status: 'PAUSED_BILLING' });
  assert.equal(m.subject, 'Automation paused to reduce-only');
  assert.match(m.text, /have not closed any positions/);
  assert.match(m.text, /not investment advice/);
});
test('billing notice: a canceled subscription says no positions were closed', async () => {
  const m = await only({ client_id: 'c1', status: 'CANCELED' });
  assert.equal(m.subject, 'Your AQOS subscription has ended');
  assert.match(m.text, /have not closed any positions/);
  assert.match(m.text, /not investment advice/);
});
test('billing notice: an active subscription gets a notice without a liquidation claim', async () => {
  const m = await only({ client_id: 'c1', status: 'ACTIVE' });
  assert.equal(m.subject, 'Your AQOS subscription is active');
  assert.match(m.text, /not investment advice/);
  assert.ok(!/liquidat|have not closed/.test(m.text));
});
test('billing notice: duplicate, unmatched, ignored or id-less events send nothing', async () => {
  for (const r of [{ client_id: 'c1', status: 'PAST_DUE', duplicate: true }, { client_id: 'c1', status: 'PAST_DUE', unmatched: true },
    { client_id: 'c1', status: 'PAST_DUE', ignored: true }, { status: 'PAST_DUE' }, {}]) {
    assert.deepEqual(await notice(r), []);
  }
});
test('billing notice: a missing email or an unknown status sends nothing', async () => {
  assert.deepEqual(await noEmail({ client_id: 'c1', status: 'PAST_DUE' }), []);
  assert.deepEqual(await notice({ client_id: 'c1', status: 'TRIALING' }), []);
});

// --------------------------------------------------------------- fee burden
const burden = (rows) => runCodeNode('wf11-fee-burden-message.js', { input: rows });
const row = (o = {}) => ({ email: 'c1@example.com', annual_fee_pct: 2.5, monthly_fee_usd: 199, connected_equity_usd: 100000, ...o });

test('fee burden: every row gets its own message addressed to that client', async () => {
  const out = await burden([row(), row({ email: 'c2@example.com', monthly_fee_usd: 99 })]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((o) => o.json.to), ['c1@example.com', 'c2@example.com']);
  assert.equal(out[0].json.subject, 'Your plan may cost more than it should');
  assert.match(out[0].json.text, /USD 199\.00 a month/);
  assert.match(out[1].json.text, /USD 99\.00 a month/);
});
test('fee burden: the percentage is shown with two decimals and the fees in dollars', async () => {
  const [o] = await burden([row({ annual_fee_pct: 2.456, monthly_fee_usd: 199.5, connected_equity_usd: 250000 })]);
  assert.match(o.json.text, /2\.46% a year/);
  assert.match(o.json.text, /USD 199\.50 a month/);
  assert.match(o.json.text, /USD 250,000/);
});
test('fee burden: the message suggests a smaller plan and carries the non-advice line', async () => {
  const [o] = await burden([row()]);
  assert.match(o.json.text, /Consider a smaller plan/);
  assert.match(o.json.text, /not investment advice/);
  assert.match(o.json.text, /pausing is prorated/);
});

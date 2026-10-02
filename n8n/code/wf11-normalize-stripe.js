// Stripe event -> the shape biz.apply_billing_event expects.
const e = $input.first().json;
const o = e.data?.object ?? {};
const price = o.items?.data?.[0]?.price ?? o.lines?.data?.[0]?.price ?? null;
const monthly = price?.recurring?.interval === 'month' && price?.currency === 'usd' ? Number(price.unit_amount) / 100 : null;
return [{
  json: {
    event_id: e.id,
    type: e.type,
    customer_id: o.customer ?? null,
    subscription_id: o.object === 'subscription' ? o.id : o.subscription ?? null,
    subscription_status: o.object === 'subscription' ? o.status : null,
    client_ref: o.client_reference_id ?? o.metadata?.client_ref ?? null,
    tier: price?.lookup_key ?? o.metadata?.tier ?? null,
    monthly_fee_usd: monthly,
  },
}];

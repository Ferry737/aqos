// One batch request to the EMS. parent_order_id equals the risk decision id,
// so a retried POST is idempotent end to end.
const rows = $input.all().map((i) => i.json).filter((r) => r.parent_order_id);
const n = (x) => (x === null || x === undefined ? null : Number(x));
const orders = rows.map((r) => ({
  parent_order_id: r.parent_order_id,
  account_id: r.account_id,
  strategy_id: r.strategy_id,
  venue: r.venue,
  symbol: r.symbol,
  side: r.side,
  qty: n(r.qty),
  order_type: r.order_type,
  limit_px: n(r.limit_px),
  reduce_only: r.reduce_only === true,
  algo: r.algo,
  algo_params: r.algo_params ?? {},
  urgency: r.urgency,
  pair_id: r.pair_id ?? null,
  arrival_mid: n(r.arrival_mid),
}));
const ids = orders.map((o) => o.parent_order_id);
return [{
  json: {
    ids,
    payload: { request_id: `dispatch:${ids[0]}:${ids.length}`, sent_at: new Date().toISOString(), orders },
  },
}];

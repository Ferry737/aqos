// Rebalance proposals with deterministic ids per hour bucket (a retried run
// in the same hour cannot double-trade), shuffled for fair dispatch.
const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
const raw = Array.isArray($input.first().json.proposals) ? $input.first().json.proposals : [];
const props = raw
  .map((p) => ({ ...p, side: String(p?.side ?? '').toUpperCase(), qty: Number(p?.qty) }))
  .filter((p) => p.account_id && p.strategy_id && p.symbol && p.venue && (p.side === 'BUY' || p.side === 'SELL') && p.qty > 0)
  .map((p) => ({
    proposal_id: `rebal:${hour}:${p.account_id}:${p.strategy_id}:${p.venue}:${p.symbol}:${p.side}`,
    cycle_id: null,
    account_id: p.account_id,
    strategy_id: p.strategy_id,
    symbol: p.symbol,
    venue: p.venue,
    side: p.side,
    qty: p.qty,
    order_type: p.order_type ?? 'LIMIT',
    limit_px: p.limit_px ?? null,
    urgency: p.urgency ?? 'low',
    pair_id: p.pair_id ?? null,
    source: 'rebalance',
  }));
for (let i = props.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [props[i], props[j]] = [props[j], props[i]];
}
return props.map((p) => ({ json: p }));

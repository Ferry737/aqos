// Gives every proposal a deterministic id (cycle, account, strategy, venue,
// symbol, side) so retries and duplicate triggers can never create a second
// risk decision for the same intent.
const cycle = $('Validate predictions').first().json;
const resp = $input.first().json;
const raw = Array.isArray(resp?.proposals) ? resp.proposals : [];
const proposals = raw
  .map((p) => ({ ...p, side: String(p?.side ?? '').toUpperCase(), qty: Number(p?.qty) }))
  .filter((p) => p.account_id && p.strategy_id && p.symbol && p.venue && (p.side === 'BUY' || p.side === 'SELL') && p.qty > 0)
  .map((p) => ({
    proposal_id: `${cycle.cycle_id}:${p.account_id}:${p.strategy_id}:${p.venue}:${p.symbol}:${p.side}`,
    cycle_id: cycle.cycle_id,
    account_id: p.account_id,
    strategy_id: p.strategy_id,
    symbol: p.symbol,
    venue: p.venue,
    side: p.side,
    qty: p.qty,
    order_type: p.order_type ?? 'LIMIT',
    limit_px: p.limit_px ?? null,
    urgency: p.urgency ?? 'normal',
    pair_id: p.pair_id ?? null,
    reduce_only: p.reduce_only === true,
    source: 'signal_cycle',
  }));
return [{ json: { cycle_id: cycle.cycle_id, predictions: cycle.kept, proposals, dropped: raw.length - proposals.length, diagnostics: resp?.diagnostics ?? null } }];

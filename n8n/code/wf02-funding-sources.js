// Public REST endpoints for perpetual funding and marks (no keys needed).
// Venue access depends on where this infrastructure runs: several venues
// geo-block some jurisdictions. Keep this list aligned with legal review.
return [
  { venue: 'binance', url: 'https://fapi.binance.com/fapi/v1/premiumIndex' },
  { venue: 'bybit', url: 'https://api.bybit.com/v5/market/tickers?category=linear' },
].map((s) => ({ json: s }));

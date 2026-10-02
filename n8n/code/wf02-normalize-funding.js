// Normalises venue payloads to md.funding rows for the core universe.
// Rows with implausible funding (|rate| >= 5% per interval) or no mark are
// dropped and counted; a failing venue does not block the others.
const UNIVERSE = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT']);
const iso = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);

const sources = $('Funding sources').all().map((i) => i.json);
const rows = [];
const errors = [];
$input.all().forEach((it, i) => {
  const r = it.json;
  const src = sources[i] ?? {};
  if (r.error || (r.statusCode && r.statusCode >= 300)) {
    errors.push({ venue: src.venue, error: r.error?.message ?? `http_${r.statusCode}` });
    return;
  }
  const body = r.body ?? r;
  if (src.venue === 'binance' && Array.isArray(body)) {
    for (const x of body) {
      if (!UNIVERSE.has(x.symbol)) continue;
      rows.push({ venue: 'binance', symbol: x.symbol, ts: iso(x.time), funding_rate: Number(x.lastFundingRate),
        next_funding_ts: iso(x.nextFundingTime), mark_px: Number(x.markPrice), index_px: Number(x.indexPrice), open_interest: null });
    }
  } else if (src.venue === 'bybit' && Array.isArray(body?.result?.list)) {
    const ts = iso(body.time);
    for (const x of body.result.list) {
      if (!UNIVERSE.has(x.symbol)) continue;
      rows.push({ venue: 'bybit', symbol: x.symbol, ts, funding_rate: Number(x.fundingRate), next_funding_ts: iso(x.nextFundingTime),
        mark_px: Number(x.markPrice), index_px: Number(x.indexPrice), open_interest: x.openInterest != null ? Number(x.openInterest) : null });
    }
  } else {
    errors.push({ venue: src.venue, error: 'unexpected_payload_shape' });
  }
});
const valid = rows.filter((r) => r.ts && Number.isFinite(r.funding_rate) && Math.abs(r.funding_rate) < 0.05 && Number.isFinite(r.mark_px) && r.mark_px > 0);
return [{ json: { rows: valid, dropped: rows.length - valid.length, errors } }];

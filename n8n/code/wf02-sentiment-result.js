//@include common-claude.js
// Validates model output against the batch: unknown hashes and assets are
// dropped, scores and relevance are clipped. On any failure nothing is stored
// (a missing sentiment feature is handled by the models; a wrong one is not).
const ALLOWED = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'USDT', 'USDC']);
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x)));
const batch = new Set($('Build sentiment request').first().json.batch_hashes ?? []);
const t = parseClaude($input.first().json);
if (!t.ok) return [{ json: { model: CLAUDE_MODEL, scores: [], error: t.reason } }];
const seen = new Set();
const scores = [];
for (const s of t.data.scores ?? []) {
  const key = `${s.hash}|${s.asset}`;
  if (!batch.has(s.hash) || !ALLOWED.has(s.asset) || seen.has(key)) continue;
  if (!Number.isFinite(Number(s.score)) || !Number.isFinite(Number(s.relevance))) continue;
  seen.add(key);
  scores.push({ hash: s.hash, asset: s.asset, score: clip(s.score, -1, 1), relevance: clip(s.relevance, 0, 1), event_type: s.event_type });
}
return [{ json: { model: t.model, scores, error: null, usage: t.usage } }];

// --- shared: Claude Messages API helpers (inlined at build time) -----------
// One model for every LLM route; effort is tuned per route. Structured outputs
// (output_config.format) guarantee schema-valid JSON. Server-side fallbacks
// re-run a declined request on Anthropic's recommended fallback model.
// Any refusal, truncation, HTTP error or bad JSON returns ok=false so the
// caller takes its deterministic path: no LLM sits on a path that moves money.
const CLAUDE_MODEL = 'claude-opus-5-5';
function claudeRequest({ system, user, schema, effort = 'low', maxTokens = 8000 }) {
  return {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    fallbacks: 'default',
    system,
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) }],
  };
}
function parseClaude(item) {
  if (!item) return { ok: false, reason: 'no_response' };
  if (item.error) return { ok: false, reason: 'http_error', detail: String(item.error.message ?? item.error).slice(0, 300) };
  const status = item.statusCode;
  const msg = item.body ?? item;
  if (status && (status < 200 || status >= 300)) return { ok: false, reason: `http_${status}`, detail: msg?.error?.type ?? null };
  if (msg?.stop_reason === 'refusal') return { ok: false, reason: 'refusal', detail: msg.stop_details?.category ?? null };
  if (msg?.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
  const text = (msg?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { ok: true, data: JSON.parse(text), model: msg.model ?? CLAUDE_MODEL, usage: msg.usage ?? null };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}
// --- end shared --------------------------------------------------------------

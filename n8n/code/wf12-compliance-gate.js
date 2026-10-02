//@include common-claude.js
// Deterministic compliance gate for client communications:
//  * banned phrases (performance promises, advice, hype)
//  * every number in the draft must exist in the source metrics
//    (anti-hallucination), after ignoring dates and small counts
//  * no links, bounded length
// A failing draft is replaced by the template-only report and flagged.
const BANNED = [
  /guarantee/i, /risk[-\s]?free/i, /can(?:'|no)?t lose/i, /\bno[-\s]?lose\b/i, /sure[-\s]?thing/i,
  /will (?:earn|make|return|gain|profit|outperform|recover)/i, /expected (?:return|profit)s?\b/i,
  /\byou should (?:buy|sell|hold|invest|increase|decrease|add|reduce)/i, /\bwe (?:recommend|suggest|advise)\b/i,
  /\bpassive income\b/i, /\bdouble your\b/i, /\bto the moon\b/i, /\bsafe (?:bet|investment|returns?)\b/i,
];

function numbersInText(text) {
  const cleaned = String(text)
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g, ' ')   // ISO dates and timestamps
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');            // clock times
  return (cleaned.match(/-?\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [])
    .map((s) => Number(s.replace(/[$,%]/g, '')))
    .filter(Number.isFinite);
}
function collectNumbers(obj, out = []) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'number') out.push(obj);
  else if (typeof obj === 'string' && /^-?\d+(?:\.\d+)?$/.test(obj.trim())) out.push(Number(obj));
  else if (Array.isArray(obj)) obj.forEach((v) => collectNumbers(v, out));
  else if (typeof obj === 'object') Object.values(obj).forEach((v) => collectNumbers(v, out));
  return out;
}
function supported(n, src) {
  if (Number.isInteger(n) && Math.abs(n) <= 12) return true;       // counts, months, small integers
  return src.some((s) => {
    const close = (a, b) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.005);
    return close(Math.abs(n), Math.abs(s)) || close(Math.abs(n), Math.abs(s * 100));   // value or percent form
  });
}
function check(draft, metrics) {
  const issues = [];
  const text = [draft?.subject, draft?.summary_md, ...(draft?.highlights ?? []), ...(draft?.risk_notes ?? [])].join('\n');
  for (const re of BANNED) if (re.test(text)) issues.push(`banned_phrase:${re.source}`);
  const src = collectNumbers(metrics);
  const unsupported = numbersInText(text).filter((n) => !supported(n, src));
  if (unsupported.length) issues.push(`unsupported_numbers:${unsupported.slice(0, 5).join(',')}`);
  if (/https?:\/\/|www\./i.test(text)) issues.push('contains_link');
  if (String(draft?.summary_md ?? '').length > 1200) issues.push('too_long');
  if (String(draft?.subject ?? '').length > 90) issues.push('subject_too_long');
  return { pass: issues.length === 0, issues };
}

const requests = $('Build narrative request').all();
return $input.all().map((it, i) => {
  const src = { ...(requests[i]?.json ?? {}) };
  delete src.anthropic_request;
  const t = parseClaude(it.json);
  const result = t.ok ? check(t.data, src.metrics) : { pass: false, issues: [`llm_unavailable:${t.reason}`] };
  return { json: { ...src, draft: t.ok ? t.data : null, compliance: { ...result, model: t.ok ? t.model : null } } };
});

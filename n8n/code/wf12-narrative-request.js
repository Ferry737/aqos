//@include common-claude.js
// Communication agent. It writes from the client's own metrics only. A
// deterministic compliance gate checks the draft before anything is sent;
// tables and the disclosure footer are rendered by code, not by the model.
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'summary_md', 'highlights', 'risk_notes'],
  properties: {
    subject: { type: 'string' },
    summary_md: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    risk_notes: { type: 'array', items: { type: 'string' } },
  },
};
const system = [
  'You write a short, factual daily account summary for a client of a crypto trading software platform.',
  'Use only the numbers in the data, copied exactly (you may round to two decimals). Describe what happened; do not',
  'predict, promise or imply future results. Never recommend buying, selling, holding or changing allocations,',
  'and never describe trading as safe, guaranteed or low-risk. Mention any risk-mode changes plainly.',
  'Keep summary_md under 120 words, with no links and no headings. Subject under 70 characters.',
].join(' ');
return $input.all().map((it) => ({
  json: {
    ...it.json,
    anthropic_request: claudeRequest({ system, user: { period: it.json.period, metrics: it.json.metrics }, schema, effort: 'medium', maxTokens: 6000 }),
  },
}));

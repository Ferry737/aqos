//@include common-claude.js
// Portfolio agent review. It can recommend human review (adding caution)
// but cannot approve anything or widen the envelope.
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'concerns', 'recommend_human_review'],
  properties: {
    summary: { type: 'string' },
    concerns: { type: 'array', items: { type: 'string' } },
    recommend_human_review: { type: 'boolean' },
  },
};
const system = [
  'You review a proposed daily change to strategy capital weights for a systematic crypto portfolio.',
  'The change was produced by an online meta-learner and already passed or failed a bounded-change policy.',
  'Explain the change in plain language for the audit log (at most four sentences), list concrete concerns',
  '(concentration, regime fit, crowding, data quality, correlation), and set recommend_human_review to true',
  'if anything warrants a human look. You cannot approve changes. Use only the numbers provided.',
].join(' ');
const b = $input.first().json;
return [{ json: { anthropic_request: claudeRequest({ system, user: b, schema, effort: 'medium', maxTokens: 6000 }) } }];

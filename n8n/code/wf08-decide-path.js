//@include common-claude.js
// apply: inside the envelope and the agent saw no reason for review.
// stage: everything else. The agent can add caution, never remove it; if the
// review is unavailable the bounded-change policy alone decides.
const b = $('Bounded-change policy').first().json;
const t = parseClaude($input.first().json);
const review = t.ok ? t.data : null;
const auto = b.within_bounds === true && review?.recommend_human_review !== true;
return [{
  json: {
    ...b,
    review,
    review_error: t.ok ? null : t.reason,
    path: auto ? 'apply' : 'stage',
    rationale: review?.summary ?? `bounded-change policy: ${b.within_bounds ? 'within envelope' : b.violations.join(', ')}`,
  },
}];

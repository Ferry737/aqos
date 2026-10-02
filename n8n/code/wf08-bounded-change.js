// Bounded autonomy for the meta-learner: each strategy weight may move at
// most 5 percentage points per day and one-way turnover may not exceed 15%.
// Anything outside the envelope is staged for a human.
const MAX_STEP = 0.05;
const MAX_TURNOVER = 0.15;
const r = $input.first().json;
const prop = r.proposed_weights ?? {};
const cur = r.current_weights ?? {};
const keys = [...new Set([...Object.keys(prop), ...Object.keys(cur)])].sort();
const deltas = keys.map((k) => {
  const from = Number(cur[k] ?? 0);
  const to = Number(prop[k] ?? 0);
  return { strategy: k, from, to, delta: to - from };
});
const sum = Object.values(prop).reduce((a, b) => a + Number(b), 0);
const turnover = deltas.reduce((a, d) => a + Math.abs(d.delta), 0) / 2;
const violations = [];
if (!Object.keys(prop).length) violations.push('empty_proposal');
if (Math.abs(sum - 1) > 1e-6) violations.push(`weights_sum_${sum.toFixed(6)}`);
if (Object.values(prop).some((w) => !(Number(w) >= 0))) violations.push('negative_or_invalid_weight');
for (const d of deltas) if (Math.abs(d.delta) > MAX_STEP + 1e-12) violations.push(`step_${d.strategy}_${d.delta.toFixed(4)}`);
if (turnover > MAX_TURNOVER + 1e-12) violations.push(`turnover_${turnover.toFixed(4)}`);
return [{
  json: {
    proposed_weights: prop, current_weights: cur, deltas, turnover,
    within_bounds: violations.length === 0, violations, diagnostics: r.diagnostics ?? null,
  },
}];

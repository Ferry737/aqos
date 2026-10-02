// Research digest for the ops channel.
const m = $('Research Agent').first().json.output ?? {};
const list = (xs, f) => (Array.isArray(xs) && xs.length ? xs.slice(0, 6).map(f).join('\n') : '- none');
const text = [
  `[RESEARCH] ${m.date ?? new Date().toISOString().slice(0, 10)}`,
  m.summary ?? '(no summary)',
  'Model health:',
  list(m.decay_findings, (d) => `- ${d.model_id}: ${d.finding}`),
  'Experiments reviewed:',
  list(m.results_reviewed, (r) => `- ${r.experiment_id}: DSR ${r.deflated_sharpe ?? 'n/a'}, PBO ${r.pbo ?? 'n/a'} -> ${r.verdict}`),
  'Transitions proposed:',
  list(m.transitions_proposed, (t) => `- ${t.model_id} -> ${t.to_stage} (${t.status ?? 'submitted'})`),
].join('\n');
return [{ json: { severity: 'INFO', text: text.slice(0, 3900), memo: m } }];

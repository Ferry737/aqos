// Formats the analyst's structured output for the ops channel.
const o = $input.first().json.output ?? {};
const list = (xs) => (Array.isArray(xs) && xs.length ? xs.slice(0, 6).map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n') : '- none');
return [{
  json: {
    severity: 'INFO',
    text: [
      `[RISK ANALYSIS] ${o.severity_assessment ?? ''} (confidence: ${o.confidence ?? 'n/a'})`,
      o.summary ?? '(no summary)',
      'Probable causes:', list(o.probable_causes),
      'Limits tightened by the agent:', list(o.limits_tightened),
      'Recommended human actions:', list(o.recommended_human_actions),
    ].join('\n').slice(0, 3900),
  },
}];

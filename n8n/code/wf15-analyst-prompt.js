// Context for the risk analyst agent. Deterministic breakers have already
// acted; the agent explains, investigates with read-only tools and may only
// tighten limits.
const breach = $input.first().json;
return [{
  json: {
    analyst_input: JSON.stringify({
      breach: { severity: breach.severity, source: breach.snapshot_source, actions: breach.actions, warnings: breach.warnings, text: breach.text },
      note: 'Breakers already acted. Investigate the cause with the read-only tools, tighten limits only if clearly warranted, and say what a human should do next.',
    }),
    dedup_key: breach.dedup_key ?? null,
  },
}];

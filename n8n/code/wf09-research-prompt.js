// Daily brief for the research agent: model health (live vs backtest
// z-scores, feature drift), multiple-testing ledger, pending approvals.
const brief = $input.first().json.brief ?? {};
return [{
  json: {
    research_input: JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      brief,
      tasks: [
        'Review model health. Propose demotion to shadow for any production model with |live_vs_backtest_z| >= 2.5 or psi_max >= 0.25.',
        'Review experiments completed in the last 24 h. Report deflated Sharpe and PBO; reject results that fail the protocol.',
        'Submit at most 3 new experiments, each a pre-registered hypothesis with a stated economic rationale.',
        'Propose promotions only with evidence; anything above paper trading goes to humans.',
      ],
    }),
  },
}];

// Client-protective guardrail: if the subscription costs more than 2% a year
// of the capital connected, tell the client and suggest cheaper options.
return $input.all().map(({ json: r }) => ({
  json: {
    to: r.email,
    subject: 'Your plan may cost more than it should',
    text: [
      `Your plan costs about ${Number(r.annual_fee_pct).toFixed(2)}% a year of the capital you have connected `
        + `(USD ${Number(r.monthly_fee_usd).toFixed(2)} a month against about USD ${Math.round(Number(r.connected_equity_usd)).toLocaleString('en-US')}).`,
      'At that ratio, fees can absorb a large share of any gains. Consider a smaller plan, or paper mode until you connect more capital.',
      'You can change or pause your plan at any time in the dashboard; pausing is prorated.',
      '',
      'This is a service notice from AQOS, a software platform. It is not investment advice.',
    ].join('\n'),
  },
}));

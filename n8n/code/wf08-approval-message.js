// Approval request with one-time links to this execution's Wait node.
// The token is single-use and expires with the staged allocation (4 h).
// The ops chat must be restricted to authorised risk approvers.
const staged = $('Stage allocation').first().json.r;
const d = $('Decide path').first().json;
const token = $('Approval token').first().json.token;
const link = (decision) => `${$execution.resumeUrl}?decision=${decision}&v=${staged.version_id}&token=${token}&approver=YOUR_ID`;
const moves = d.deltas
  .filter((x) => Math.abs(x.delta) > 1e-9)
  .map((x) => `${x.strategy}: ${(x.from * 100).toFixed(1)}% -> ${(x.to * 100).toFixed(1)}%`);
const why = d.violations.length ? d.violations.join(', ') : 'portfolio agent requested human review';
return [{
  json: {
    version_id: staged.version_id,
    text: [
      `[APPROVAL] Strategy allocation v${staged.version_id} (expires in 4 h)`,
      ...moves,
      `Why staged: ${why}`,
      `Agent notes: ${d.review?.summary ?? 'n/a'}`,
      `Approve: ${link('approve')}`,
      `Reject: ${link('reject')}`,
    ].join('\n'),
  },
}];

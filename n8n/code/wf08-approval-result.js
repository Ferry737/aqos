// Reads the approver's click (query string) or the Wait timeout. A timeout
// is recorded as a rejection; the current allocation stays in force.
const q = $input.first().json.query ?? {};
const msg = $('Build approval message').first().json;
const timedOut = !q.decision;
return [{
  json: {
    version_id: msg.version_id,
    token: timedOut ? $('Approval token').first().json.token : String(q.token ?? ''),
    decision: timedOut ? 'timeout' : String(q.decision).toLowerCase(),
    approver: timedOut ? 'timeout' : String(q.approver ?? 'unknown').slice(0, 80),
    timed_out: timedOut,
  },
}];

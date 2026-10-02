// End-of-run summary for the ops channel, counted from the database so it
// covers every batch of the loop.
const r = $input.first().json;
const sent = Number(r.sent ?? 0);
const fallback = Number(r.fallback ?? 0);
return [{ json: { severity: 'INFO', text: `[REPORTS] ${sent} report(s) recorded in this run, ${fallback} used the template fallback` } }];

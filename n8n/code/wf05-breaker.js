// EMS link circuit breaker. Redis INCR returns { "<key>": count } over a
// sliding 120 s window. Three failures open the breaker for 30 s; while open,
// dispatches are skipped. The first dispatch after the cooldown is the
// half-open probe, and a success resets the counter.
const FAILS_TO_OPEN = 3;
const j = $input.first().json;
const fails = Number(Object.values(j)[0] ?? 0);
const ids = $('EMS batch').first().json.ids ?? [];
return [{
  json: {
    severity: 'SEV1',
    fails,
    open: fails >= FAILS_TO_OPEN,
    parent_order_ids: ids,
    text: `[SEV1] EMS dispatch failed (${fails} in 120 s). ${ids.length} order(s) marked SEND_UNCONFIRMED; `
      + `${fails >= FAILS_TO_OPEN ? 'circuit OPEN for 30 s.' : 'circuit still closed.'}`,
  },
}];

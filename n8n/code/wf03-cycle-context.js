// Idempotent cycle identity. The bar-close event and the schedule backstop
// derive the same cycle_id for the same 5-minute bar, and alpha.claim_cycle
// lets exactly one of them run it.
const BAR_MS = 5 * 60 * 1000;
const it = $input.first().json;
const eventBar = it.r?.payload?.bar_ts ?? it.payload?.bar_ts ?? it.bar_ts ?? null;
const barMs = eventBar ? Date.parse(eventBar) : Math.floor((Date.now() - 15_000) / BAR_MS) * BAR_MS;
if (!Number.isFinite(barMs)) throw new Error(`invalid bar_ts: ${eventBar}`);
const barTs = new Date(Math.floor(barMs / BAR_MS) * BAR_MS).toISOString();
return [{
  json: {
    cycle_id: `core5m:${barTs}`,
    strategy_set: 'core',
    timeframe: '5m',
    bar_ts: barTs,
    trigger: eventBar ? 'event' : 'schedule',
    started_at: new Date().toISOString(),
  },
}];

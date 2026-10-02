// WF-06 Settlement and reconciliation: fills and venue events update positions
// idempotently; every 5 min internal books are reconciled to venue snapshots
// (venue is the source of truth); a daily close snapshots P&L and lifts
// daily-loss holds at the day roll.
import { workflow, execTrigger, schedule, code, pgFn, http, setFields, execWf } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS06Settlement',
  name: 'AQOS-06 Settlement and reconciliation',
  active: true,
  settings: { executionTimeout: 240 },
  nodes: [
    // ---- execution events
    execTrigger('Execution events (from gateway)'),
    pgFn('Apply execution events', 'oms.apply_execution_events', { payload: '{ events: $json.r.payload.events, slippage_alert_bps: 25 }' }),
    code('Notable events', 'wf06-notable-events.js'),
    // ---- reconciliation
    schedule('Reconcile every 5 min', { cron: '30 */5 * * * *' }, { misfire: 'skip' }),
    http('Fetch venue snapshots', {
      method: 'POST', url: 'http://ems:8080/v1/snapshots', cred: 'emsAuth', timeoutMs: 20000, retries: 2, retryWaitMs: 2000, onError: 'continueRegularOutput',
      body: '={{ { accounts: "all" } }}', note: 'EMS returns { accounts: [{ account_id, venue, positions: [{symbol, qty}], external_orders_count, external_fills_count }] } straight from each venue.',
    }),
    pgFn('Reconcile', 'oms.reconcile', { setof: true, payload: '{ accounts: $json.accounts, tolerance_usd: 5 }' }),
    code('Break policy', 'wf06-break-policy.js'),
    pgFn('Apply recon actions', 'risk.apply_actions', { payload: '$json' }),
    // ---- day close
    schedule('Day close 00:00:30 UTC', { cron: '30 0 0 * * *' }, { misfire: 'coalesce_owner', graceS: 3600 }),
    pgFn('Close day', 'pnl.close_day', { payload: '{}' }),
    setFields('Day close notice', {
      severity: 'INFO',
      text: { expr: '={{ "[DAY CLOSE] " + $json.r.day + ": " + $json.r.accounts_closed + " accounts snapshotted, " + $json.r.daily_loss_holds_lifted + " daily-loss hold(s) lifted" }}' },
    }, { keepOthers: false }),
    execWf('Notify', 'AQOS16Notifier00', { wait: false }),
  ],
  connections: [
    ['Execution events (from gateway)', 'Apply execution events'],
    ['Apply execution events', 'Notable events'],
    ['Notable events', 'Notify'],
    ['Reconcile every 5 min', 'Fetch venue snapshots'],
    ['Fetch venue snapshots', 'Reconcile'],
    ['Reconcile', 'Break policy'],
    ['Break policy', 'Apply recon actions'],
    ['Break policy', 'Notify'],
    ['Day close 00:00:30 UTC', 'Close day'],
    ['Close day', 'Day close notice'],
    ['Day close notice', 'Notify'],
  ],
});

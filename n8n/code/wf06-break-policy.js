// Reconciliation outcome -> actions. Venue truth was already adopted in SQL.
// A HIGH unexplained break moves that account to REDUCE_ONLY until a human
// reviews it. Client-initiated activity (manual trades in their own account)
// is reported, never penalised: it is their account.
const breaks = $input.all().map((i) => i.json).filter((b) => b && b.break_id);
if (!breaks.length) return [];
const byAccount = {};
for (const b of breaks) (byAccount[b.account_id] ??= []).push(b);
const actions = [];
for (const [account, bs] of Object.entries(byAccount)) {
  const severe = bs.filter((b) => b.classification === 'unknown' && b.severity === 'HIGH');
  if (severe.length) {
    actions.push({
      scope: 'account', scope_id: account, mode: 'REDUCE_ONLY', reason: 'recon:unexplained_break', tier: 'T2',
      metric: 'recon_diff_usd', value: Math.max(...severe.map((b) => Number(b.diff_usd))), limit: 1000,
      fingerprint: `recon:${account}:${severe.map((b) => b.break_id).join(',')}`,
    });
  }
}
const external = [...new Set(breaks.filter((b) => b.classification === 'external_activity').map((b) => b.account_id))];
const text = `[RECON] ${breaks.length} break(s), ${actions.length} account(s) set REDUCE_ONLY\n`
  + breaks.slice(0, 15).map((b) => `${b.account_id} ${b.venue} ${b.symbol}: ${b.classification}/${b.severity} diff ${b.diff_qty} ($${b.diff_usd})`).join('\n');
return [{ json: { severity: actions.length ? 'SEV2' : 'SEV3', snapshot_source: null, fingerprint: `recon:${breaks.map((b) => b.break_id).join(',')}`, actions, external_accounts: external, text, severe: actions.length > 0 } }];

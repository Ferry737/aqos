// Accounts whose weights drifted outside their no-trade band this hour.
const rows = $input.all().map((i) => i.json).filter((r) => r.account_id);
return [{
  json: {
    as_of: new Date().toISOString(),
    reason: 'drift',
    accounts: rows.map((r) => ({ account_id: r.account_id, max_abs_drift: Number(r.max_abs_drift), drifted: r.drifted ?? [] })),
  },
}];

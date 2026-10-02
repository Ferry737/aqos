// Scope of one gate call: which accounts and symbols to load context for.
const items = $input.all().map((i) => i.json);
return [{
  json: {
    accounts: [...new Set(items.map((p) => p.account_id).filter(Boolean))],
    symbols: [...new Set(items.map((p) => p.symbol).filter(Boolean))],
    n: items.length,
  },
}];

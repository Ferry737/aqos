// Verifies the EMS really is flat for the scope: no open orders, and for a
// flatten, residual notional below dust on every venue.
const DUST_USD = 25;
const req = $('Normalize request').first().json;
const x = $input.first().json ?? {};
const openOrders = Number(x.open_orders ?? NaN);
const residual = Number(x.gross_notional_usd ?? NaN);
const ordersClean = openOrders === 0;
const positionsClean = req.action !== 'flatten' || (Number.isFinite(residual) && residual <= DUST_USD);
return [{
  json: {
    ...req,
    clean: ordersClean && positionsClean,
    severity: ordersClean && positionsClean ? 'SEV2' : 'SEV1',
    open_orders: Number.isFinite(openOrders) ? openOrders : null,
    residual_gross_usd: Number.isFinite(residual) ? residual : null,
    text: `[KILL ${req.action.toUpperCase()}] ${req.scope}:${req.scope_id} - open orders ${Number.isFinite(openOrders) ? openOrders : '?'}, `
      + `residual gross USD ${Number.isFinite(residual) ? residual.toFixed(2) : '?'} (${req.reason})`,
  },
}];

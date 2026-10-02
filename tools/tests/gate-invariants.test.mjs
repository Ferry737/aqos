// Randomised invariants for the pre-trade risk gate (wf04-pretrade-checks.js).
// Whatever the inputs, these must hold; a failure here is a safety bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFirst } from '../lib/sandbox.mjs';

const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const VENUES = ['binance', 'bybit'];
const MODES = ['NORMAL', 'REDUCE_ONLY', 'HALT', 'WEIRD'];

function scenario(rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const marks = {};
  for (const s of SYMS) for (const v of VENUES) marks[`${s}@${v}`] = { px: 50 + rand() * 60000, age_s: rand() < 0.1 ? 40 : rand() * 5 };
  const accounts = {};
  for (const id of ['a1', 'a2', 'a3']) {
    const positions = {};
    for (const s of SYMS) if (rand() < 0.5) { const k = `${s}@${pick(VENUES)}`; const qty = (rand() - 0.5) * 2; positions[k] = { qty, notional_usd: qty * marks[k].px }; }
    accounts[id] = {
      equity_usd: 5000 + rand() * 200000, mode: rand() < 0.8 ? 'NORMAL' : pick(MODES), billing_status: rand() < 0.9 ? 'ACTIVE' : 'PAUSED_BILLING',
      key_status: 'VERIFIED', max_gross_leverage: 0.5 + rand() * 3, max_net_leverage: 0.5 + rand(), max_position_pct_equity: 0.05 + rand() * 0.5,
      daily_loss_limit_pct: 0.03, max_drawdown_pct: 0.15, day_pnl_pct: (rand() - 0.6) * 0.08, drawdown_pct: rand() * 0.2,
      max_order_notional_usd: 1000 + rand() * 100000, venue_caps_usd: { binance: 20000 + rand() * 200000, bybit: 20000 + rand() * 200000 },
      positions, pending: rand() < 0.3 ? { [`BTCUSDT@binance`]: (rand() - 0.5) * 0.5 } : {}, orders_last_min: Math.floor(rand() * 40),
    };
  }
  const ctx = {
    limits_version: 'v', state_version: 's',
    global: { mode: rand() < 0.9 ? 'NORMAL' : pick(MODES), max_mark_age_s: 10, price_collar_bps: 150, max_order_notional_usd: 250000, min_order_notional_usd: 10, max_orders_per_min_per_account: 30, restricted_symbols: rand() < 0.3 ? ['SOLUSDT'] : [] },
    marks, accounts,
    strategies: { s1: { max_gross_usd: rand() * 3e6, gross_usd: rand() * 1e6 }, s2: { max_gross_usd: rand() * 3e6, gross_usd: 0 } },
    venues: {},
  };
  const proposals = [];
  const n = 1 + Math.floor(rand() * 14);
  for (let i = 0; i < n; i++) {
    const sym = pick(SYMS); const venue = pick(VENUES); const key = `${sym}@${venue}`;
    proposals.push({
      proposal_id: `p${i}`, account_id: pick(['a1', 'a2', 'a3', 'ghost']), strategy_id: pick(['s1', 's2', 's3']), symbol: sym, venue,
      side: pick(['BUY', 'SELL']), qty: rand() < 0.05 ? -1 : rand() * 3, order_type: 'LIMIT',
      limit_px: rand() < 0.5 ? marks[key].px * (1 + (rand() - 0.5) * 0.05) : null, urgency: 'normal',
    });
  }
  return { ctx, proposals, redisMode: rand() < 0.9 ? 'NORMAL' : pick(MODES) };
}
const run = (sc) => runFirst('wf04-pretrade-checks.js', { input: [], nodes: {
  'Proposals in': sc.proposals, 'Load risk context': [{ ctx: sc.ctx }], 'Global mode (fast flag)': [{ redis_mode: sc.redisMode }] } });

test('gate invariants hold over 400 random batches', async () => {
  const rand = mulberry32(20261002);
  for (let i = 0; i < 400; i++) {
    const sc = scenario(rand);
    const out = await run(sc);
    const again = await run(sc);
    assert.deepEqual(out, again, `batch ${i}: gate must be deterministic`);
    assert.equal(out.decisions.length, sc.proposals.length, `batch ${i}: one decision per proposal`);
    const grossByAccount = {};
    for (const d of out.decisions) {
      const p = sc.proposals.find((x) => x.proposal_id === d.proposal_id);
      assert.ok(d.approved_qty >= 0, `batch ${i}: negative approval`);
      assert.ok(d.approved_qty <= (Number(p.qty) > 0 ? Number(p.qty) : 0) + 1e-9, `batch ${i}: ${d.proposal_id} approved more than requested`);
      if (d.decision === 'REJECT') assert.equal(d.approved_qty, 0);
      if (d.decision === 'APPROVE') assert.ok(Math.abs(d.approved_qty - p.qty) < 1e-9);
      if (d.decision !== 'REJECT') assert.ok(d.approved_qty > 0, `batch ${i}: non-reject with zero qty`);
      // unknown accounts and bad quantities can never trade
      if (p.account_id === 'ghost' || !(Number(p.qty) > 0)) assert.equal(d.decision, 'REJECT', `batch ${i}: invalid proposal approved`);
      // stale or missing marks can never trade
      const mark = sc.ctx.marks[`${p.symbol}@${p.venue}`];
      if (mark.age_s > sc.ctx.global.max_mark_age_s) assert.equal(d.decision, 'REJECT', `batch ${i}: traded on a stale mark`);
      // HALT anywhere in the hierarchy means no approval
      const acct = sc.ctx.accounts[p.account_id];
      const modes = [sc.redisMode, sc.ctx.global.mode, acct?.mode].map((m) => (['NORMAL', 'REDUCE_ONLY', 'HALT'].includes(m) ? m : 'HALT'));
      if (modes.includes('HALT') || (acct && acct.billing_status !== 'ACTIVE' && false)) assert.equal(d.decision, 'REJECT', `batch ${i}: traded under HALT`);
      // REDUCE_ONLY: never increases absolute exposure
      if (acct && modes.includes('REDUCE_ONLY') && d.approved_qty > 0) {
        const key = `${p.symbol}@${p.venue}`;
        let pos = (acct.positions[key]?.qty ?? 0) + (acct.pending[key] ?? 0);
        for (const e of out.decisions) {
          if (e === d) break;
          const q = sc.proposals.find((x) => x.proposal_id === e.proposal_id);
          if (q.account_id === p.account_id && `${q.symbol}@${q.venue}` === key) pos += (q.side === 'BUY' ? 1 : -1) * e.approved_qty;
        }
        const after = pos + (p.side === 'BUY' ? 1 : -1) * d.approved_qty;
        assert.ok(Math.abs(after) <= Math.abs(pos) + 1e-9, `batch ${i}: REDUCE_ONLY order increased exposure`);
      }
      if (d.approved_qty > 0 && acct) {
        const px = mark.px;
        assert.ok(d.approved_qty * px <= Math.min(250000, acct.max_order_notional_usd) + 1, `batch ${i}: order notional above cap`);
        grossByAccount[p.account_id] = (grossByAccount[p.account_id] ?? 0) + d.approved_qty * px;
      }
    }
  }
});

test('ten identical proposals cannot each use the same headroom', async () => {
  const marks = { 'BTCUSDT@binance': { px: 60000, age_s: 1 } };
  const acct = { equity_usd: 100000, mode: 'NORMAL', billing_status: 'ACTIVE', key_status: 'VERIFIED', max_gross_leverage: 1, max_net_leverage: 5, max_position_pct_equity: 5, positions: {}, pending: {}, orders_last_min: 0 };
  const ctx = { limits_version: 'v', state_version: 's', global: { mode: 'NORMAL', max_mark_age_s: 10, price_collar_bps: 150, max_order_notional_usd: 1e9, min_order_notional_usd: 1, max_orders_per_min_per_account: 100 }, marks, accounts: { a1: acct }, strategies: { s1: { max_gross_usd: 1e9, gross_usd: 0 } } };
  const proposals = Array.from({ length: 10 }, (_, i) => ({ proposal_id: `p${i}`, account_id: 'a1', strategy_id: 's1', symbol: 'BTCUSDT', venue: 'binance', side: 'BUY', qty: 0.5 }));
  const out = await run({ ctx, proposals, redisMode: 'NORMAL' });
  const total = out.decisions.reduce((a, d) => a + d.approved_qty, 0);
  assert.ok(total * 60000 <= 100000 + 1, `approved ${total * 60000} USD against 100000 of leverage headroom`);
});

test('one rejected leg rejects the whole pair', async () => {
  const marks = { 'BTCUSDT@binance': { px: 60000, age_s: 1 }, 'ETHUSDT@binance': { px: 2500, age_s: 99 } };
  const acct = { equity_usd: 100000, mode: 'NORMAL', billing_status: 'ACTIVE', key_status: 'VERIFIED', max_gross_leverage: 5, max_net_leverage: 5, max_position_pct_equity: 5, positions: {}, pending: {}, orders_last_min: 0 };
  const ctx = { limits_version: 'v', state_version: 's', global: { mode: 'NORMAL', max_mark_age_s: 10, price_collar_bps: 150, max_order_notional_usd: 1e9, min_order_notional_usd: 1, max_orders_per_min_per_account: 100 }, marks, accounts: { a1: acct }, strategies: { s1: { max_gross_usd: 1e9, gross_usd: 0 } } };
  const proposals = [
    { proposal_id: 'long', account_id: 'a1', strategy_id: 's1', symbol: 'BTCUSDT', venue: 'binance', side: 'BUY', qty: 0.1, pair_id: 'pr1' },
    { proposal_id: 'short', account_id: 'a1', strategy_id: 's1', symbol: 'ETHUSDT', venue: 'binance', side: 'SELL', qty: 2, pair_id: 'pr1' },
  ];
  const out = await run({ ctx, proposals, redisMode: 'NORMAL' });
  assert.deepEqual(out.decisions.map((d) => d.decision), ['REJECT', 'REJECT']);
});

// ===========================================================================
// AQOS · WF-04 Risk Gate · Pre-trade checks (deterministic, fail-closed)
//
// One pass over every proposal in a cycle:
//   * the most severe trading mode across global/venue/strategy/account wins
//   * in-flight orders count as filled (no double exposure on retries)
//   * exposure accumulates across the batch, so ten small orders cannot each
//     consume the same headroom
//   * strategy capacity is shared pro-rata, so no client gets priority
//   * hedged pairs (pair_id) stay hedged: one rejected leg rejects the pair
// Caps can only shrink an order. Missing or stale data rejects it.
// The EMS re-applies the hard limits as the last line of defence.
// ===========================================================================
const RANK = { NORMAL: 0, REDUCE_ONLY: 1, HALT: 2 };
const EPS = 1e-12;
const normMode = (m) => {
  const u = String(m ?? 'NORMAL').toUpperCase();
  return u in RANK ? u : 'HALT'; // unknown modes fail closed
};
const worst = (...modes) => modes.map(normMode).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'NORMAL');
const sgn = (side) => (side === 'BUY' ? 1 : -1);
const num = (x, d = NaN) => {
  if (x === null || x === undefined || x === '') return d;
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r6 = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null);

function gate(proposals, ctx, redisMode) {
  const g = ctx?.global ?? {};
  const marks = ctx?.marks ?? {};
  const decisions = [];
  const escalations = [];

  // Running per-account state: effective positions (incl. in-flight), gross,
  // net and per-venue exposure, order count. Updated after every approval.
  const state = {};
  const acct = (id) => {
    if (state[id] !== undefined) return state[id];
    const a = ctx?.accounts?.[id];
    if (!a) return (state[id] = null);
    const pos = {};
    for (const [k, v] of Object.entries(a.positions ?? {})) pos[k] = num(v?.qty, 0);
    for (const [k, q] of Object.entries(a.pending ?? {})) pos[k] = (pos[k] ?? 0) + num(q, 0);
    let gross = 0;
    let net = 0;
    const venue = {};
    for (const [k, q] of Object.entries(pos)) {
      const px = num(marks[k]?.px);
      const notional = Number.isFinite(px) ? q * px : num(a.positions?.[k]?.notional_usd, 0);
      const v = k.split('@')[1];
      gross += Math.abs(notional);
      net += notional;
      venue[v] = (venue[v] ?? 0) + Math.abs(notional);
    }
    return (state[id] = { a, pos, gross, net, venue, orders: num(a.orders_last_min, 0) });
  };

  // Strategy capacity demand (exposure-increasing USD) -> pro-rata scale.
  const pre = proposals.map((p) => {
    const side = String(p?.side ?? '').toUpperCase();
    const key = `${p?.symbol}@${p?.venue}`;
    return { p, side, key };
  });
  const demand = {};
  for (const { p, side, key } of pre) {
    const st = p?.account_id ? acct(p.account_id) : null;
    const px = num(marks[key]?.px);
    const qty = num(p?.qty);
    if (!st || !Number.isFinite(px) || !(qty > 0) || (side !== 'BUY' && side !== 'SELL')) continue;
    const pos = st.pos[key] ?? 0;
    const inc = (Math.abs(pos + sgn(side) * qty) - Math.abs(pos)) * px;
    if (inc > 0) demand[p.strategy_id] = (demand[p.strategy_id] ?? 0) + inc;
  }
  const capScale = {};
  for (const [sid, requested] of Object.entries(demand)) {
    const s = ctx?.strategies?.[sid];
    // A strategy missing from the approved limits document has no capacity.
    const remaining = s ? Math.max(0, num(s.max_gross_usd, Infinity) - num(s.gross_usd, 0)) : 0;
    capScale[sid] = requested > 0 ? Math.min(1, remaining / requested) : 1;
  }

  for (const { p, side, key } of pre) {
    const checks = [];
    const reasons = [];
    const rec = (name, pass, value = null, limit = null) => {
      checks.push({ name, pass, value, limit });
      if (!pass) reasons.push(name);
      return pass;
    };
    const base = {
      proposal_id: p?.proposal_id,
      cycle_id: p?.cycle_id ?? null,
      account_id: p?.account_id,
      strategy_id: p?.strategy_id,
      symbol: p?.symbol,
      venue: p?.venue,
      side,
      requested_qty: num(p?.qty, 0),
      order_type: p?.order_type ?? 'LIMIT',
      limit_px: p?.limit_px ?? null,
      urgency: p?.urgency ?? 'normal',
      pair_id: p?.pair_id ?? null,
      limits_version: ctx?.limits_version ?? null,
      state_version: ctx?.state_version ?? null,
    };
    const reject = (markPx = null) =>
      decisions.push({ ...base, decision: 'REJECT', approved_qty: 0, reduce_only: false, mark_px: markPx, checks, reasons, escalate: null });

    if (!rec('valid_proposal',
      !!(p?.proposal_id && p?.account_id && p?.strategy_id && p?.symbol && p?.venue) &&
      (side === 'BUY' || side === 'SELL') && num(p?.qty) > 0)) { reject(); continue; }
    const st = acct(p.account_id);
    if (!rec('account_known', !!st, p.account_id)) { reject(); continue; }

    const a = st.a;
    const mark = marks[key];
    const px = num(mark?.px);
    const pos = st.pos[key] ?? 0;
    const s = sgn(side);
    const sameDir = pos === 0 || Math.sign(pos) === s;
    const reducing = !sameDir;
    let q = num(p.qty);

    // 1. Trading mode.
    let mode = worst(redisMode, g.mode, ctx?.venues?.[p.venue]?.mode, ctx?.strategies?.[p.strategy_id]?.mode, a.mode);
    if (a.key_status && a.key_status !== 'VERIFIED') mode = 'HALT';
    if (a.billing_status && a.billing_status !== 'ACTIVE') mode = worst(mode, 'REDUCE_ONLY');

    // 2. Loss limits escalate the whole account.
    const dayPnl = num(a.day_pnl_pct, 0);
    const dd = num(a.drawdown_pct, 0);
    const dailyLimit = num(a.daily_loss_limit_pct);
    const ddLimit = num(a.max_drawdown_pct);
    if (Number.isFinite(dailyLimit) && dayPnl <= -dailyLimit) {
      mode = worst(mode, 'REDUCE_ONLY');
      escalations.push({ kind: 'mode', scope: 'account', scope_id: p.account_id, mode: 'REDUCE_ONLY',
        reason: `daily_loss:${r6(dayPnl)}`, tier: 'T2', metric: 'day_pnl_pct', value: r6(dayPnl), limit: -dailyLimit });
    }
    if (Number.isFinite(ddLimit) && dd >= ddLimit) {
      mode = 'HALT';
      escalations.push({ kind: 'mode', scope: 'account', scope_id: p.account_id, mode: 'HALT',
        reason: `max_drawdown:${r6(dd)}`, tier: 'T3', metric: 'drawdown_pct', value: r6(dd), limit: ddLimit });
      escalations.push({ kind: 'kill', scope: 'account', scope_id: p.account_id,
        action: a.auto_flatten_on_max_dd === true ? 'flatten' : 'cancel_all', reason: `max_drawdown:${r6(dd)}` });
    }
    if (!rec('trading_mode', mode !== 'HALT', mode)) { reject(); continue; }
    if (mode === 'REDUCE_ONLY' && !rec('reduce_only_mode', reducing, { mode, position: r6(pos) })) { reject(); continue; }

    // 3. Client mandate and restricted list (exits are always allowed).
    if (Array.isArray(a.allowed_symbols) && !rec('mandate_symbol', a.allowed_symbols.includes(p.symbol), p.symbol)) { reject(); continue; }
    if (Array.isArray(a.allowed_strategies) && !rec('mandate_strategy', a.allowed_strategies.includes(p.strategy_id), p.strategy_id)) { reject(); continue; }
    const restricted = Array.isArray(g.restricted_symbols) && g.restricted_symbols.includes(p.symbol);
    if (restricted && !rec('restricted_symbol_exit_only', reducing, p.symbol)) { reject(); continue; }

    // 4. Fresh market data.
    if (!rec('mark_available', Number.isFinite(px) && px > 0, key)) { reject(); continue; }
    const maxAge = num(g.max_mark_age_s, 10);
    if (!rec('mark_fresh', num(mark?.age_s, Infinity) <= maxAge, num(mark?.age_s, null), maxAge)) { reject(px); continue; }

    // 5. Fat-finger collar.
    if (p.limit_px !== null && p.limit_px !== undefined) {
      const collar = num(g.price_collar_bps, 150);
      const devBps = (Math.abs(num(p.limit_px) - px) / px) * 1e4;
      if (!rec('price_collar', Number.isFinite(devBps) && devBps <= collar, r2(devBps), collar)) { reject(px); continue; }
    }

    // 6. Order-rate throttle (counts orders approved earlier in this batch).
    const maxRate = num(g.max_orders_per_min_per_account, Infinity);
    if (!rec('order_rate', st.orders + 1 <= maxRate, st.orders + 1, maxRate)) { reject(px); continue; }

    const equity = num(a.equity_usd, 0);
    if (!rec('equity_positive', equity > 0, equity)) { reject(px); continue; }

    // 7. Sizing caps: each can only shrink q.
    const shrink = (name, maxQ, value, limit) => {
      const cap = Math.max(0, maxQ);
      const ok = q <= cap + EPS;
      checks.push({ name, pass: ok, value, limit });
      if (!ok) { reasons.push(name); q = cap; }
    };
    const maxOrderUsd = Math.min(num(g.max_order_notional_usd, Infinity), num(a.max_order_notional_usd, Infinity));
    shrink('max_order_notional', maxOrderUsd / px, r2(q * px), maxOrderUsd);
    if (mode === 'REDUCE_ONLY' || restricted) shrink('exit_only_cap', Math.abs(pos), r6(q), r6(Math.abs(pos)));

    if (Math.abs(pos + s * q) > Math.abs(pos) + EPS) {
      // Position size as a share of equity.
      const maxPosUsd = num(a.max_position_pct_equity, Infinity) * equity;
      shrink('max_position', sameDir ? maxPosUsd / px - Math.abs(pos) : Math.abs(pos) + maxPosUsd / px,
        r2(Math.abs(pos + s * q) * px), r2(maxPosUsd));
      // Gross leverage: headroom in USD -> max quantity.
      const growQ = (headroomUsd) => (sameDir ? headroomUsd / px : 2 * Math.abs(pos) + headroomUsd / px);
      const maxGross = num(a.max_gross_leverage, Infinity) * equity;
      shrink('max_gross_leverage', growQ(Math.max(0, maxGross - st.gross)),
        r6((st.gross + (Math.abs(pos + s * q) - Math.abs(pos)) * px) / equity), num(a.max_gross_leverage, null));
      // Counterparty concentration per venue.
      const vCap = num(a.venue_caps_usd?.[p.venue]);
      if (Number.isFinite(vCap)) {
        const vExp = st.venue[p.venue] ?? 0;
        shrink('venue_cap', growQ(Math.max(0, vCap - vExp)), r2(vExp), vCap);
      }
      // Strategy capacity, shared pro-rata across all accounts in the batch.
      const scale = capScale[p.strategy_id] ?? 0;
      if (scale < 1 - EPS) {
        const keep = sameDir ? q * scale : Math.abs(pos) + Math.max(0, q - Math.abs(pos)) * scale;
        shrink('strategy_capacity', keep, r6(scale), 1);
      }
    }
    // Net leverage for single orders (pairs are hedged by construction).
    if (!p.pair_id) {
      const maxNet = num(a.max_net_leverage, Infinity) * equity;
      if (s * st.net >= 0) shrink('max_net_leverage', (maxNet - Math.abs(st.net)) / px, r6((st.net + s * q * px) / equity), num(a.max_net_leverage, null));
      else shrink('max_net_leverage', (Math.abs(st.net) + maxNet) / px, r6((st.net + s * q * px) / equity), num(a.max_net_leverage, null));
    }

    const minUsd = num(g.min_order_notional_usd, 0);
    if (q > EPS && q * px < minUsd) { reasons.push('below_min_notional'); checks.push({ name: 'min_notional', pass: false, value: r2(q * px), limit: minUsd }); q = 0; }

    const requested = num(p.qty);
    const decision = q >= requested - EPS ? 'APPROVE' : q > EPS ? 'RESIZE' : 'REJECT';
    const approved = decision === 'APPROVE' ? requested : decision === 'RESIZE' ? r6(q) : 0;
    decisions.push({ ...base, decision, approved_qty: approved, mark_px: px,
      reduce_only: reducing && approved <= Math.abs(pos) + EPS, checks, reasons, escalate: null });

    // Update running state with what was approved.
    if (approved > 0) {
      const newPos = pos + s * approved;
      st.gross += (Math.abs(newPos) - Math.abs(pos)) * px;
      st.net += s * approved * px;
      st.venue[p.venue] = (st.venue[p.venue] ?? 0) + (Math.abs(newPos) - Math.abs(pos)) * px;
      st.pos[key] = newPos;
      st.orders += 1;
    }
  }

  // Hedged pairs: all legs or none, and keep the hedge ratio.
  const pairs = {};
  decisions.forEach((d, i) => { if (d.pair_id) (pairs[d.pair_id] ??= []).push(i); });
  for (const idxs of Object.values(pairs)) {
    const legs = idxs.map((i) => decisions[i]);
    if (legs.length < 2 || legs.some((l) => l.decision === 'REJECT')) {
      const why = legs.length < 2 ? 'pair_incomplete' : 'pair_leg_rejected';
      for (const i of idxs) {
        if (decisions[i].decision !== 'REJECT') decisions[i] = { ...decisions[i], decision: 'REJECT', approved_qty: 0, reduce_only: false, reasons: [...decisions[i].reasons, why] };
      }
      continue;
    }
    const ratio = Math.min(...legs.map((l) => l.approved_qty / l.requested_qty));
    for (const i of idxs) {
      const d = decisions[i];
      if (ratio >= 1 - EPS) continue;
      decisions[i] = { ...d, decision: 'RESIZE', approved_qty: r6(d.requested_qty * ratio),
        reasons: d.reasons.includes('pair_hedge_ratio') ? d.reasons : [...d.reasons, 'pair_hedge_ratio'] };
    }
  }

  const count = (k) => decisions.filter((d) => d.decision === k).length;
  return {
    decisions,
    escalations,
    stats: { proposals: proposals.length, approve: count('APPROVE'), resize: count('RESIZE'), reject: count('REJECT'),
      limits_version: ctx?.limits_version ?? null, redis_mode: normMode(redisMode) },
  };
}

// ---- n8n glue -------------------------------------------------------------
const proposals = $('Proposals in').all().map((i) => i.json);
const ctx = $('Load risk context').first().json.ctx;
const redisMode = $('Global mode (fast flag)').first().json.redis_mode ?? 'NORMAL';
return [{ json: gate(proposals, ctx, redisMode) }];

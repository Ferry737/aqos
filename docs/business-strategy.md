# AQOS Business Strategy

> Agent-loop output, Cycles 1–5. Draft v1, 2 October 2026. Written for investors and the receiving agent.

## Engagement Inputs

| Field | Value |
|---|---|
| Company / product | AQOS (Agentic Quant OS), a working name. [fill-in: legal entity and final brand] |
| Industry vertical | AI-native investment technology: systematic crypto trading software for individuals |
| Primary objective | [fill-in: objective]. Working assumption: validate product-market fit for a compliant, non-custodial launch (A1) |
| Constraints | Operate as software, not unregistered advice (stated). Budget: [fill-in]. Timeline: [fill-in]. Team: [fill-in]. Target jurisdictions: [fill-in] |

Tag key:
- `[Data-backed: source]`: verified during this engagement.
- `[Assumption]`: an inference, explained in the Assumptions Ledger.
- `[fill-in: …]`: input the user must provide.

---

## 1. Market Context & Opportunity

**Plan.** Self-directed crypto investors want systematic, 24/7 strategies. Today they must trade control (custody, their own limits) against sophistication (institutional risk management). Scope: individual clients, non-custodial software, centralised exchanges first, an 18-month horizon.

**Compute: market sizing.** Method only; the figures are pending.

| Layer | Logic | Inputs |
|---|---|---|
| TAM | Active self-directed crypto traders × annual trading-software spend | [fill-in: active trader count]; [fill-in: spend per trader] |
| SAM | TAM × serviceable-jurisdiction share × share using API automation × share above tier capital minimum | [fill-in: jurisdiction mix]; [fill-in: % using bots/APIs]; [fill-in: capital distribution] |
| SOM (18 months) | Qualified visitors × Lab sign-up × paper-to-live graduation × paid conversion × retention | [fill-in: beta funnel rates] |

Tier capital minimum = 12 × monthly price ÷ 1% fee-burden target. This places the core segment among mass-affluent investors [Assumption A2–A3].

**Compute: trends for the next 18 months.**
1. **The regulatory perimeter is hardening.** MiCA's grandfathering period ended on 1 July 2026. Advice, portfolio management and order handling for EU clients now need CASP authorisation [Data-backed: ESMA]. The FCA published final UK cryptoasset rules on 30 June 2026, and authorisation applications open in September 2026 [Data-backed: FCA policy statements; Dentons]. The US CLARITY Act failed a Senate cloture vote on 15 September 2026 [Data-backed: Reuters]. Compliant-by-design software gains relative to grey-zone bots [Assumption].
2. **US crypto derivatives are moving onshore.** CFTC-regulated perpetual-style futures launched in July 2025, and further perpetual approvals followed in May 2026 [Data-backed: Coinbase; WSJ]. Funding and basis strategies may become offerable to US clients on regulated venues [Assumption; legal review needed].
3. **Leverage is fragile.** About $19B was liquidated on 10 October 2025, with widespread auto-deleveraging [Data-backed: FTI Consulting; CoinDesk Data]. Buyers now weight risk control above headline returns [Assumption].
4. **Frontier AI is getting cheaper.** Anthropic's Opus-tier list price is $4/$20 per million input/output tokens, down from $5/$25 for the previous Opus [Data-backed: Anthropic pricing, September 2026]. AI-written reports cost cents per client [Assumption A4].
5. **24/7 orchestration is commoditising.** n8n 2.x's durable scheduler runs each schedule once across instances and applies misfire policies [Data-backed: n8n docs]. A lean team can operate around the clock [Assumption].

**Verify.** Every market claim is tagged. Market sizes are formulas with fill-ins, not estimates. No traction, financials or user counts are asserted.

### CYCLE STATUS: COMPLETE

---

## 2. Competitive Strategy & Positioning

**Plan.** Map the options a target client weighs today, then choose a position AQOS can defend with [fill-in: budget and team].

**Compute: landscape.** Categories come from public positioning; verify features and pricing before external use [Assumption A12].

| Category | Examples | Strength | Gap AQOS targets |
|---|---|---|---|
| Exchange-native bots | Binance, OKX, Bybit bot suites | Free, zero setup | Single venue; basic risk tooling; the exchange is both vendor and counterparty |
| Bot platforms | 3Commas, Cryptohopper, Bitsgap | Multi-exchange templates | Rule-based; marketplace incentives; API-key security concerns |
| Copy trading and signals | Exchange copy trading, Telegram groups | Social proof | Opaque risk; performance chasing |
| Open-source frameworks | Freqtrade, Hummingbot | Free, flexible | Needs engineers; no 24/7 operations or compliance layer |
| Passive regulated products | Spot crypto ETFs, index funds | Simple, regulated | No active or market-neutral strategies |

**Value proposition.** Institutional-style systematic strategies that run in the client's own exchange accounts. The client sets the limits, deterministic code enforces them, and every decision goes on a tamper-evident audit trail.

**Positioning statement.** For self-directed crypto investors with meaningful capital who want automation without giving up custody, AQOS is the AI-native trading operating system that runs risk-first systematic strategies in their own accounts. Unlike bot marketplaces and copy trading, AQOS never holds funds, never sells signals, enforces risk in three independent layers, and prices so that fees stay a small share of the client's capital.

**Moat, most durable first.**
1. **Trust architecture.** Built in the database layer and passing its tests [Data-backed: aqos repo, 74/74 tests]:
   - single-use risk tokens
   - escalate-only risk modes
   - two-person de-escalation
   - a hash-chained audit log

   The kill switch and exchange dead-man switches are designed but not yet built.
2. **Compliance-by-design perimeter.** No custody; client-configured mandates; paper trading before live; a licensed-partner route for performance fees [Assumption A7].
3. **Execution-data network effect.** Transaction-cost analysis across accounts improves impact models and routing [Assumption A10].
4. **Operating leverage.** Signals are computed once per cycle and executed per account [Design].

**Why customers choose AQOS** [Assumption A6; validate in interviews]:
- custody stays with them
- their limits are provably enforced
- execution spans venues
- AI reports explain outcomes in plain language
- fees track their capital
- they can paper trade free first

**Verify.** The position holds only if AQOS avoids the fronts where incumbents win: price against free exchange bots, and breadth against marketplaces. A trust lead can be copied, so speed to external proof matters: a security audit, a published methodology and an operator-capital track record [Assumption]. With the budget unknown, a narrow, trust-led position is the choice that fits the constraints.

### CYCLE STATUS: COMPLETE

---

## 3. Revenue Model & Unit Economics

**Plan.** Charge as a software vendor, not an adviser. Align incentives without performance fees at launch.

**Compute: revenue streams.**

| Stream | Mechanics | Timing |
|---|---|---|
| Subscriptions (core) | Lab (free, paper) → Core → Pro → Desk. Tiers differ by venues, strategies, rebalance frequency and research credits | Launch |
| Usage credits | Extra backtests and research-agent runs | Day 60+ |
| B2B licensing | White-label for licensed advisers or CASPs, who own the client relationship and the licences | Pilot by day 90 |
| Exchange broker rebates | Only if disclosed, passed through as fee credits, and turnover-capped | Evaluate [Assumption A9] |
| Performance fees | Only through a licensed entity, for qualified clients (US: $1.4M AUM or $2.7M net worth from 29 June 2026) | Phase 2 [Data-backed: SEC order] |

**Pricing logic.** Flat tier prices: [fill-in: price points after a willingness-to-pay test]. A guardrail flags any client whose annual fee exceeds 2% of connected capital [Data-backed: aqos repo, `biz.fee_burden_report`, tested]; the target is 1% [Assumption A3]. Flat pricing, rather than pricing by capital band, avoids asset-based compensation [Assumption A7]. Win-win terms:
- billing is prorated and can be paused at any time
- a billing lapse moves accounts to reduce-only and never liquidates them [Data-backed: aqos repo tests]
- SLA credits for missed rebalances [Assumption]
- strategy capacity caps protect existing clients

**Acquisition framework.** Research content → free paper Lab → graduation gate → paid live account → disclosed referrals → better execution data → retention. The graduation gate requires 14 days of paper trading, a passed knowledge quiz and a verified trade-only API key [Data-backed: aqos repo tests].

**Target metrics.**

| Metric | Target or formula | Basis |
|---|---|---|
| CAC (blended) | [fill-in: from beta channels] | Not yet measured |
| ARPA | Tier mix × price: [fill-in] | Not yet set |
| Gross margin | ≥ 75% at scale | [Assumption A5] |
| AI reporting cost | ≈ $0.03–0.08 per daily report; ≈ $1–2.50 per client-month | [Assumption A4], using the [Data-backed] list price |
| LTV | ARPA × GM ÷ monthly churn | [fill-in: churn] |
| LTV : CAC | ≥ 3 : 1 | [Assumption A5] |
| CAC payback | CAC ÷ (ARPA × GM) ≤ 12 months | [Assumption A5] |

**Verify.** The model is internally consistent: a 75% gross margin needs variable cost per account of no more than 25% of ARPA. AI cost is small next to any plausible ARPA. Market-data licences and support are not yet priced [fill-in] and may dominate. Deferring performance fees keeps the model within the regulatory constraint. The guardrail shrinks SAM (Discrepancy D2).

### CYCLE STATUS: COMPLETE

---

## 4. Go-to-Market & Execution Roadmap

**Plan.** Launch with paper trading first, then go live in [fill-in: one or two jurisdictions with favourable legal opinions].

**Compute: 90-day roadmap.** Timelines are suggestions; feasibility depends on [fill-in: team and budget].

| Days | Workstream | Exit criterion |
|---|---|---|
| 0–30 | Legal opinion per target jurisdiction; disclosures v1 | Signed opinions; perimeter memo |
| 0–30 | Engineering spine: assemble and validate the n8n workflows; EMS on one venue; risk-service MVP | Paper trades end-to-end; kill-switch drill passed |
| 0–30 | Recruit design partners | [fill-in: e.g., 20–30] signed [Assumption A11] |
| 31–60 | Closed Lab beta (paper) | Weekly active ≥ [fill-in]% |
| 31–60 | Operator-capital live pilot, with results published | [fill-in: capital]; no SEV1 open longer than 24 h |
| 31–60 | Security review: key handling, penetration test | All findings closed |
| 31–60 | Willingness-to-pay interviews | Price points set |
| 61–90 | Limited live launch: Core tier, approved jurisdictions | First [fill-in] paid accounts |
| 61–90 | Referral programme with compliance kit; publish methodology and operator dashboard | Live |
| 61–90 | B2B pilot with one licensed partner | Letter of intent signed |

**Channels.** Research-led content and SEO, a moderated community, exchange partner programmes, licensed-adviser partnerships and disclosed affiliates. Paid social plays a small role [Assumption A8].

**Key partnerships** ([fill-in] for each):
- 2–3 exchanges (API access, broker programme)
- a sanctions and KYC screening provider
- a market-data vendor
- a security auditor
- a licensed adviser or CASP, for B2B and the Phase-2 licensed tier

**Top 3 operational risks.**

| Risk | Mitigation | Owner and timing |
|---|---|---|
| Regulators treat the product as advice, portfolio management or a CASP service | Legal opinions before launch; no custody or pooling; client-configured mandates; geo-gating; licensed-partner route | Legal, days 0–30, then ongoing |
| Strategies under-perform or get crowded | Paper first; promotion gated on deflated Sharpe ratio and probability of backtest overfitting; capacity caps; automatic demotion; no performance promises | Research, continuous |
| Failure during volatility: key leak, outage, duplicate orders | Trade-only, IP-allowlisted keys behind a vault signer; deterministic gate with single-use tokens; exchange dead-man switches; kill-switch drills; runbooks | Engineering, days 0–60 |

**Verify.** The plan is realistic with at least [fill-in: N] engineers and a funded legal workstream. With fewer, cut to one venue and two strategies (trend and funding carry) and stay paper-only until day 60. The plan assumes no existing traction or revenue.

### CYCLE STATUS: COMPLETE

---

## 5. Executive Summary & Assumptions Ledger

**Executive summary.**

AQOS is AI-native software that lets self-directed crypto investors run institutional-style systematic strategies in their own exchange accounts. It never takes custody, pools funds or sells signals. Clients set their limits; deterministic code enforces them and records every decision on a tamper-evident audit trail.

The timing favours compliant, risk-first products. MiCA's grandfathering period ended in July 2026, US market-structure legislation stalled in September 2026, regulated US perpetual futures now exist, and the October 2025 crash showed what unmanaged leverage costs. Market size is not yet sourced.

AQOS competes on trust, not price. Revenue comes from flat-tier subscriptions with a free paper-trading Lab. Fees are flagged above 2% of a client's capital, a billing lapse never liquidates an account, and performance fees wait for a licensed partner. AI reporting is estimated at about $1–2.50 per client per month.

The 90-day plan: legal opinions and the engineering foundation first, then a paper beta and a pilot on the operator's own capital, then a limited live launch. Budget, team, objective and target jurisdictions are still required.

**Assumptions Ledger.**

| ID | Assumption | Basis / inference logic |
|---|---|---|
| A1 | Objective is product-market fit for a compliant launch | Inferred from the brief: "sellable, win-win investing business for individuals" |
| A2 | Core segment is mass-affluent investors | The fee target implies a minimum capital per tier |
| A3 | Fee burden targeted at 1%, flagged at 2% | Keeps fees a small share of plausible returns |
| A4 | AI reporting costs ≈ $1–2.50 per client-month | 3–5k input + 1–3k output tokens × $4/$20 per million × 30 |
| A5 | Gross margin ≥ 75%, LTV:CAC ≥ 3, payback ≤ 12 months | SaaS heuristics; signals are shared across accounts |
| A6 | Trust and custody drive purchase decisions | Market history of custody and key failures |
| A7 | The product stays outside the advice/CASP perimeter | Design intent; needs a legal opinion per jurisdiction |
| A8 | Paid social is constrained | Platform ad policies (to verify) |
| A9 | Broker rebates can be passed through | Varies by venue (to verify) |
| A10 | Execution data compounds into an advantage | More fills sharpen impact models |
| A11 | 20–30 design partners within 30 days | Depends on the founders' network |
| A12 | Competitor categories are as described | Public positioning (to verify) |

**Discrepancy List.**
- **D1:** Objective, budget, timeline, team and jurisdictions are missing, so feasibility is conditional.
- **D2:** The fee guardrail narrows "individuals" to mass-affluent investors.
- **D3:** The brief allowed performance fees; this plan defers them. Confirm.
- **D4:** Market-size inputs are missing.
- **D5:** About 40% of engineering is done; the core trading services are not built yet.
- **D6:** Some jurisdictions restrict derivatives for retail clients, e.g. the UK [Data-backed: FCA].

**Final Quality Rubric** (one revision: Cycle 3 moved from capital-band to flat-tier pricing to fit the regulatory constraint).
- [x] All claims are data-backed or labelled assumptions
- [x] Actionable within the constraints, subject to D1
- [x] No unresolved contradictions; D2 and D3 await confirmation
- [x] Next steps have timelines
- [x] Executive tone

### CYCLE STATUS: COMPLETE

---

## Agent Handoff Notes

**(a) Completed**
- Cycles 1–5 of this strategy.
- Engineering in this repository:
  - `db/schema.sql` and `db/seed_example.sql`: 74 of 74 invariant tests pass (`npm run test:db`).
  - `n8n/code/`: about 60 Code-node scripts for 17 workflows (`AQOS00Supervisor` … `AQOS16Notifier00`). Not yet syntax-checked or tested.
  - The workflow wiring is not yet on disk. Each script's `$('Node name')` references show which nodes the workflow builder must create and connect.
- Sources verified during this engagement:
  - ESMA (MiCA)
  - SEC order IA-6961 via Holland & Knight (qualified-client thresholds)
  - Reuters and NPR (CLARITY Act)
  - Coinbase and WSJ (US perpetual futures)
  - FTI Consulting and CoinDesk Data (10 October 2025)
  - FCA (UK rules)
  - n8n documentation
  - Anthropic pricing

**(b) Placeholders that need user input**
- Legal entity and brand
- Objective
- Budget, timeline and team size
- Target jurisdictions
- Market-size inputs
- Price points
- CAC, churn and ARPA
- Partner names
- Operator-capital pilot size
- Design-partner target

**(c) Recommended next actions**

| # | Action | Owner | When |
|---|---|---|---|
| 1 | Supply the D1 inputs | User | Day 0 |
| 2 | Source the TAM/SAM inputs (exchange-reported active users, ownership surveys, share of traders using automation) and recompute Section 1 | Agent | Week 1 |
| 3 | Commission a legal opinion per jurisdiction | User and counsel | Weeks 1–4 |
| 4 | Design the willingness-to-pay study and interview script | Agent | Weeks 1–2 |
| 5 | Build `tools/build-workflows.mjs` from `n8n/code/`, validate the result against the n8n 2.41 node catalog, and unit-test the risk gate | Engineering agent | Weeks 1–3 |
| 6 | Turn this document into an investor deck once D1–D4 are resolved | Agent | Week 4 |

# AQOS Market-Sizing Inputs

> Deliverable for `docs/business-strategy.md` Section 1 (D4: "Market-size inputs are missing").
> Compiled 2 October 2026. All web sources retrieved 2 Oct 2026; publication dates noted per source.

**Tag key**
- `[S: <url>]` sourced figure (URL + date given inline)
- `[E]` estimate derived from sourced figures, reasoning stated
- `[A]` explicit assumption with stated range

**Method in one line.** TAM = active self-directed crypto traders × annual trading-software spend. SAM = TAM × serviceable-jurisdiction share × automation-adopting share × mass-affluent share. SOM stays a qualitative beta funnel (no funnel rates are invented here).

---

## 1. Active self-directed crypto traders (global)

Registered users ≠ active users. Exchanges tout registered counts; only Coinbase discloses a clean monthly-transacting metric.

| Exchange | Metric | Figure | Date | Source |
|---|---|---|---|---|
| Coinbase | Monthly Transacting Users (MTU), FY avg | **9.2M** (8.4M in 2024; 8.2M in Q1 2026) | FY2025 10-K, filed Feb 2026 | [S: https://companiesmarketcap.com/inr/coinbase/sec-reports-10k/0001679788-26-000015/] |
| Binance | Registered users | **300M** (year-end 2025); ~1M registrations/week mid-2025 | Dec 2025 year-end letter | [S: https://www.binance.com/en/square/post/34810833703817] |
| Binance | Active users | Not disclosed for 2025–26. Third-party tracker claims ~8.5M DAU (low confidence) | 2026 | [S: https://ourcryptotalk.com/blog/top-10-crypto-exchanges-by-volume-in-2026] |
| OKX | Registered customers | **120M+** (year-end 2025) | Jan 2026 | [S: https://www.okx.com/learn/2025-a-steady-progression] |
| OKX | Active | Not disclosed (CEX); ~3M DAU claimed by same low-confidence tracker; OKX Wallet ~5M MAU Q2 2025 | 2026 | [S: https://ourcryptotalk.com/blog/top-10-crypto-exchanges-by-volume-in-2026], [S: https://architectpartners.com/okx-receives-200m-investment-from-intercontinental-exchange-at-25b-valuation/] |
| Bybit | Registered users | **80M** (early 2026) | 2026 | [S: https://www.datawallet.com/crypto/bybit-vs-okx] |
| Bybit | Active | Not disclosed; ~3.8M DAU claimed (low confidence, same tracker) | 2026 | [S: https://ourcryptotalk.com/blog/top-10-crypto-exchanges-by-volume-in-2026] |
| Industry | "Active crypto users" (a16z methodology) | **40–70M** global; 716M owners | Oct 2025 | [S: https://a16zcrypto.com/posts/article/state-of-crypto-report-2025/] |
| Industry | Active crypto traders (trader-beats aggregator) | **50–100M** depending on "active" definition | 2026 | [S: https://tradingbeasts.com/how-many-traders-are-there-in-the-world/] |

**Caveats.** (a) Coinbase MTU includes passive transactions (staking, USDC rewards), so it *overstates* traders. (b) Binance/OKX/Bybit disclose only registered counts; registered/active ratios are typically 10:1 to 30:1. (c) DAU→MAU ≈ 2.5–3× for trading apps `[E]`.

**Triangulation `[E]`.** Sum of MAU-equivalents: Coinbase 9.2M + Binance ~25M (8.5M DAU × ~3) + OKX ~8M + Bybit ~10M ≈ 52M before de-duplicating multi-exchange users; overlaps are heavy (power users hold 3+ exchange accounts). The a16z 40–70M band brackets the same territory. **Band: 30M (low) / 40M (mid) / 50M (high) active self-directed traders.**

## 2. Share using API automation / bots

| Data point | Figure | Date | Source |
|---|---|---|---|
| Crypto-community survey (n=10,388, self-report) | **38%** say they use bots; 86% of *value* moved is bot-driven | Aug 2019 — STALE, only direct survey found; selection bias upward | [S: https://en.cryptonomist.ch/2019/08/21/research-crypto-trading-bots/] |
| 3Commas users | **118,000+ active members** (self-published); "500k+ users" claimed by market reports | 2026 | [S: https://3commas.io/], [S: https://dataintelo.com/report/ai-crypto-trading-bot-market] |
| Cryptohopper users | **550k–759k** registered users (review-site estimates) | 2025 | [S: https://coinweb.com/comparison/best-trading-bot/cryptohopper/], [S: https://www.kucoin.com/learn/trading/best-crypto-trading-bots] |
| Algo share of volume | ~70% of global trading volume algorithmic (mostly institutional) | 2026 | [S: https://coinlaw.io/ai-trading-bot-statistics/] |
| "65% of retail traders use automation" (WunderTrading blog) | Unreliable: vendor content, no method given; likely conflates traditional markets | 2026 | [S: https://wundertrading.com/journal/en/navigating-the-latest-algorithms-for-success] — treated as marketing, not evidence |

**Reading `[E]`.** Demonstrable *paying* third-party bot users ≈ 3Commas ~120k active + Cryptohopper (registered 550k+ → paid plausibly 100–200k) + Bitsgap/others ≈ 0.3–1M ≈ **1–3% of active traders**. But free exchange-native bot suites (Binance/OKX/Bybit) and self-hosted Freqtrade/Hummingbot users are uncounted, and the only usage survey says 38% (2019, biased). The automation-*adopting* population AQOS can sell into sits far above the paying-today floor and at/below the self-report ceiling.

**Band `[A]`: 15% (low) / 25% (mid) / 38% (high)** — floor near paying+free-native evidence, ceiling at the stale survey. If evidence is demanded for the mid figure, treat **1–3% paying today** as the hard floor and 25% as target-market potential.

## 3. Annual spend per trader on trading software (price anchors)

Official pricing pages, retrieved 2 Oct 2026 (all USD, ex-VAT):

| Platform | Entry (annual-billed)/mo | Mid /mo | Top /mo | Monthly-billed range | Source |
|---|---|---|---|---|---|
| 3Commas | $15 (Starter) | $40 (Pro) | $110 (Expert) | $20–140 | [S: https://3commas.io/pricing] |
| Cryptohopper | $24.16 (Explorer) | $57.50 (Adventurer) | $107.50 (Hero) | $29–129; free tier scrapped Jun 2026 | [S: https://www.cryptohopper.com/pricing], [S: https://airdropalert.com/blogs/cryptohopper-review/] |
| Bitsgap | $23 (Basic) | $55 (Advanced) | $119 (Pro) | $29–149 | [S: https://bitsgap.com/pricing] |
| TradingView (reference) | $12.95 (Essential) | $29.95 (Plus) | $199.95 (Ultimate) | $14.95–239.95; price rise Apr 2026 | [S: https://www.tradingview.com/pricing/], [S: https://chartinglens.com/blog/tradingview-price-increase-2026] |

**Spend per trader `[E]`.** Serious bot-tier subscriptions cluster at **$29–69/mo** ($348–828/yr list). Realised category spend is lower: annual discounts, churn, free tiers, and TradingView-only users drag the average down. **Band: $250 (low) / $500 (mid) / $800 (high) per active trader-year.** Mid = a ~$40–42/mo annual-billed plan held for a year.

## 4. Serviceable jurisdictions (retail derivatives + automation)

| Jurisdiction | Retail crypto derivatives | Notes for a non-custodial automation vendor | Source |
|---|---|---|---|
| US | **Allowed onshore** — CFTC-regulated perps since Jul 2025 (Coinbase, ≤10x; Bitnomial/Kraken 2026). Offshore perps to US persons unlawful | Largest single market; CLARITY Act stalled Sep 2026; software-as-execution-agent may trip FCM/CTA questions — legal opinion needed | [S: https://www.coinbase.com/blog/perpetual-futures-have-arrived-in-the-us], [S: https://theindustryspread.com/us-crypto-perpetual-futures-split-uk-eu-rules-2026/] |
| EU (MiCA) | Spot allowed via CASPs; **derivatives stay under MiFID II** — crypto CFDs capped at **2:1** leverage for retail; order-execution/agent activity = CASP service needing authorisation | Post-grandfathering (ended 1 Jul 2026), an agent that concludes contracts on behalf of clients is presumptively providing execution services (ESMA: presumption of agency for retail) | [S: https://www.esma.europa.eu/sites/default/files/library/esma71-98-125_faq_esmas_product_intervention_measures.pdf], [S: https://www.esma.europa.eu/publications-data/questions-answers/2653] |
| UK (FCA) | **Banned** — retail sale of crypto derivatives prohibited since Jan 2021; cETN ban lifted Oct 2025 but the derivatives ban "will remain in place" | Spot-only + automation; final cryptoasset rules published 30 Jun 2026, authorisations from Sep 2026 | [S: https://www.fca.org.uk/news/press-releases/fca-bans-sale-crypto-derivatives-retail-consumers], [S: https://www.fca.org.uk/news/press-releases/fca-opens-retail-access-crypto-etns] |
| Singapore (MAS) | Heavily restricted — no leverage/margin/credit for retail DPT customers; only derivatives on Approved Exchanges | Retail automation into offshore derivatives non-compliant for SG retail | [S: https://www.morganlewis.com/pubs/2023/11/mas-introduces-further-investor-protection-measures-for-digital-payment-token-service-providers], [S: https://www.moneysense.gov.sg/risks-of-trading-payment-token-derivatives/] |
| UAE | Permitted via licensed venues — VARA Dubai (Binance FZE, OKX ME, Crypto.com, Deribit incl. derivatives for retail under conditions); federal SCA/CMA licences from Oct 2025 (Bybit first) | Serviceable but fragmented across VARA/SCA/ADGM layers | [S: https://www.vara.ae/en/licenses-and-register/public-register/deribit-fze/], [S: https://www.datawallet.com/crypto/best-crypto-exchanges-uae] |
| Brazil | Permitted — B3 bitcoin futures since Apr 2024 (~$860M/mo volume); ETH/SOL futures and BTC options followed; event contracts professional-only | Large retail base; CVM rules apply | [S: https://www.b3.com.br/en_us/products-and-services/trading/cryptoassets/bitcoin-futures.htm], [S: https://coinstats.app/news/33f8239ab4bc86d7fb906a242f097a42735ac3e8392e6baca16584bb89acb8d0_Brazils-B3-Strengthens-Crypto-Market-with-New-Bitcoin-and-Altcoin-Futures/] |
| India | Legal to trade but hostile: 30% tax + 1% TDS + no loss offset; FIU blocked 25+ offshore exchanges (Oct 2025–Jan 2026); 91.5% of volume already offshore | Not serviceable for a compliant launch | [S: https://www.koinx.com/stats/india-crypto-offshore-trading-statistics] |
| China | Outright ban (reference only) | Not serviceable | — |

**Activity-share anchor `[S]`.** North America ≈ 26% of global transaction value ($2.3T received Jul 2024–Jun 2025); Europe received $2.6T (42% growth). Value share overweights institutions vs retail headcount. [S: https://www.chainalysis.com/blog/north-america-crypto-adoption-2025/], [S: https://www.chainalysis.com/blog/2025-global-crypto-adoption-index/]

**Serviceable share `[A]`: 25% (low) / 33% (mid) / 45% (high)** of global active traders — NA+EU+UAE+BR+other open markets, discounted for the UK derivatives ban, EU 2:1 leverage cap, and India/China exclusion. Mid assumes roughly one-third of active traders sit in jurisdictions where AQOS could operate at launch.

## 5. Mass-affluent share (capital ≥ tier minimum)

Best available distribution (US, n=10,000 holders):
- **45% hold ≥ $10,000** in crypto (55% hold less); **11% hold > $100,000**; 15% hold <$500.
- Source: National Cryptocurrency Association / Harris Poll, early 2025 [S: https://nca.org/2025%20State%20of%20Crypto%20Holders%20Report.pdf], corroborated [S: https://www.panewslab.com/en/articles/dw2fvlne]

**AQOS fee-burden gate.** Tier capital minimum = 12 × monthly price ÷ 1% (business-strategy.md §1):

| Tier price (anchor) | Capital minimum | Share of holders above it `[E]` |
|---|---|---|
| $29/mo (Cryptohopper Explorer) | **$34,800** | ~30% (log-linear interpolation between 45%≥$10k and 11%≥$100k) |
| $50/mo (3Commas Pro zone) | **$60,000** | ~25% |
| $129/mo (Cryptohopper Hero) | **$154,800** | ~10% |

Caveats: US distribution applied globally `[A]` — global skew is poorer, so these are optimistic for non-US segments; distribution is of *holders*, not of *traders* (traders plausibly hold more). Generic mass-affluent band for the headline SAM: **30% (low) / 45% (mid) / 45% (high)**.

---

## 6. Computation

### TAM = active traders × annual software spend

| Band | Traders | Spend/yr | TAM |
|---|---|---|---|
| Low | 30M | $250 | **$7.5B** |
| Mid | 40M | $500 | **$20.0B** |
| High | 50M | $800 | **$40.0B** |

Honesty note: this is a *capacity* TAM (every active trader spending category-average). Actual current third-party-bot category revenue is ~2 orders of magnitude smaller (see §2 paying floor); investors will probe this — present TAM as "all active traders × realistic software spend", never as current category revenue.

### SAM = TAM × jurisdiction share × automation share × mass-affluent share

| Band | TAM | × Juris | × Auto | × Mass-affluent | SAM |
|---|---|---|---|---|---|
| Low | $7.5B | 25% | 15% | 30% | **≈ $84M** |
| Mid | $20.0B | 33% | 25% | 45% | **≈ $743M** |
| High | $40.0B | 45% | 38% | 45% | **≈ $3.08B** |

**Mid-band: TAM ≈ $20B; SAM ≈ $0.74B.** The single most uncertain multiplier is automation share (§2): paying-today floor 1–3% would put SAM at $30–90M, i.e. today's revenue-addressable market; $743M assumes automation adoption far above today's paid base. State both when presenting.

### SOM (18 months)

Formula per business-strategy.md §1: qualified visitors × Lab sign-up × paper-to-live graduation × paid conversion × retention. **No rates are asserted** — all five inputs require beta data. Qualitatively: the graduation gate (14-day paper trading + quiz + trade-only key) and the fee-burden guardrail both cut SOM hard; expect SOM to be measured in hundreds of accounts, not a SAM percentage, in the first 18 months. [A]

---

## 7. Data-quality register

| Item | Quality | Issue |
|---|---|---|
| Active trader count | Medium | Only Coinbase discloses clean actives; Binance/OKX/Bybit give registered only; DAU figures from a weak aggregator |
| Automation share | **Low** | Only survey is 2019 and self-selected; paying-user floor (1–3%) vs self-report (38%) span >10×; biggest research gap |
| Spend/trader | Medium-high | Official pricing pages, but no published ARPU; churn/discount drag is estimated |
| Jurisdiction share | Medium | Regulatory facts well-sourced; the 25–45% share itself is an assumption |
| Mass-affluent share | Medium | Solid US survey (2025); applied globally by assumption |
| Bot-platform user counts | Low-medium | Vendor self-reports and review-site estimates; "active" undefined |

Pre-2023 source used: the 2019 Cochran bot-usage survey (nothing better found; flagged stale). All others 2024–2026.

---

## 8. Recompute of business-strategy.md Section 1

Restating the doc's own SAM logic — TAM × serviceable-jurisdiction share × share using API automation × **share above tier capital minimum** (the doc's fourth multiplier, stricter than the generic mass-affluent cut):

| Band | TAM | × Juris | × Auto | × Above tier-min capital | SAM (doc basis) |
|---|---|---|---|---|---|
| Low | $7.5B | 25% | 15% | 30% (≥$34.8k) | **≈ $84M** |
| Mid | $20.0B | 33% | 25% | 25% (≥$60k) | **≈ $413M** |
| High | $40.0B | 45% | 38% | 10% (≥$154.8k) | **≈ $684M** |

Notes: each band pairs a pricing scenario with its own capital gate ($29/$50/$129 → $34.8k/$60k/$154.8k), so the capital-share multiplier *falls* as the band rises — the doc's fee-burden guardrail compresses the SAM range from $84M–$3.1B to **$84M–$684M**, with mid ≈ **$413M**. This is the honest number to carry into Section 1; the $743M figure in §6 uses a looser ≥$10k mass-affluent cut and should be labelled the ceiling case. SOM inputs still need beta data (no funnel rates asserted).

**Suggested fill-ins for the Section 1 table:** TAM inputs = 30–50M active traders (§1) × $250–800/yr (§3) → $7.5–40B (mid $20B). SAM inputs = jurisdiction 25–45% (§4), automation 15–38% (§2), above-tier-capital 10–30% (§5) → $84M–684M (mid $413M). SOM = pending beta funnel data.

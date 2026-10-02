# AQOS Willingness-to-Pay (WTP) Study

**Purpose.** Set the Core tier launch price from evidence, not intuition. This protocol is executable by a non-technical founder: no stats software, no survey platform — a call scheduler, a spreadsheet, and 25 conversations.

**Status.** Prices verified 2 October 2026. No pricing has been tested; roadmap places WTP interviews in days 31–60.

---

## 1. Study Design

**Core method: Van Westendorp Price Sensitivity Meter (PSM).** Each interviewee answers four questions about the AQOS Core tier (monthly subscription, non-custodial software that runs systematic strategies in the client's own exchange accounts):

1. At what price is it **so cheap you'd doubt its quality**? (too cheap)
2. At what price is it a **bargain**? (cheap)
3. At what price does it **start to feel expensive** — you'd still consider it? (expensive)
4. At what price is it **so expensive you'd never consider it**? (too expensive)

The four cumulative curves and their crossings yield an acceptable price range and an optimal price point (Section 4). PSM is chosen over Gabor-Granger or conjoint because it is fast to administer verbally, needs no survey tooling, and exposes the *cheapness credibility bound* — critical for a trust-sensitive, non-custodial product.

**Competitor anchoring.** Read a neutral competitor summary (below) *after* the four PSM questions, then re-ask "does that change your numbers?" This separates internal willingness from market reference. Verified prices, 2 Oct 2026:

| Competitor | Current list price (monthly) | Annual discount | Source |
|---|---|---|---|
| 3Commas — Starter / Pro / Expert | $20 / $50 / $140 | $15 / $40 / $110 | https://3commas.io/pricing |
| Cryptohopper — Explorer / Adventurer / Hero | $29 / $69 / $129 | $24.16 / $57.50 / $107.50 | https://www.cryptohopper.com/pricing |
| Bitsgap — Basic / Advanced / Pro | $29 / $69 / $149 | $23 / $55 / $119 | https://bitsgap.com/pricing |
| Exchange-native bots (Binance, OKX, Bybit) | $0 (trading fees apply; single venue, basic risk tooling) | — | https://www.binance.com/en/trading-bots |

Note: these verified prices **supersede earlier assumed ranges** ($29–99 for 3Commas, $19–99 for Cryptohopper, $23–79 for Bitsgap). Mass-market bot pricing now clusters at $20–50 entry and $69–149 mid/top.

**Sample.** n ≥ 25 completed interviews (target 30; stop-satiation when the last 5 interviews produce no new price-band arguments). Segment: mass-affluent self-directed crypto investors with **> $10k connected trading capital** who **currently use or have seriously considered** automation. Stratify quota: at least 8 per capital band ($10–50k / $50–150k / > $150k) — fee burden (Section 4) makes capital band the key moderator.

---

## 2. Recruitment

**Channels (in priority order):**
- **Existing waitlist** — highest-intent; email first 50 with 3 slots each. Expect ~30% conversion.
- **r/DailyAlgorithmicTrading** (and r/algotrading) — post a research-participation request (not a product pitch; check subreddit self-promotion rules, offer to share anonymised results back).
- **Telegram algo-trading groups** — ask group admins for a pinned research post; offer the incentive publicly.
- **Twitter/X crypto quant circles** — quote-tweet traders discussing bot platforms or API automation; DM those who engage.

**Screener (Google Form, 6 questions, < 2 min).** Recruit if S1 ✓ and S2 ✓ and S5 ✓:
- S1. Roughly how much crypto capital do you actively trade? (under $10k ✗ / $10–50k / $50–150k / over $150k)
- S2. Do you use, or have you evaluated, trading bots or automation in the last 6 months? (yes / no ✗)
- S3. Which tools do you pay for today? (3Commas / Cryptohopper / Bitsgap / exchange bots / none / other)
- S4. What do you spend monthly on trading tools? (0 / <$25 / $25–75 / $75–150 / >$150)
- S5. Your jurisdiction? (EU / UK / US / other) — track for regulatory fit; don't exclude.
- S6. Do you work for a trading-tool company? (yes ✗)

**Incentive.** $50 equivalent in USDT or an exchange voucher, paid within 48h of the call — pay for *time*, never contingent on answers or signup, to avoid biasing WTP upward. Alternative for waitlist: 3 months free Core at launch.

**4-week schedule (fits roadmap days 31–60):**

| Week | Focus | Output |
|---|---|---|
| 1 | Finalise script, open screener, email waitlist, post to Reddit/Telegram; run 3 pilot interviews and fix confusing wording | 6+ bookings |
| 2 | 10 interviews (waitlist-heavy) | 10 transcripts |
| 3 | 10 interviews (community-heavy), rolling coding of price bands | 20 total |
| 4 | Final 5+ interviews, spreadsheet analysis (Section 4), pricing decision memo | Priced tier ladder |

---

## 3. Interview Script (verbatim)

**Interviewer instructions.**
- 30 minutes, video or voice. Record with permission; otherwise take verbatim notes on numbers.
- **Do not reveal any price, competitor price, or tier name before Q6.** If asked "how much will it cost?", say: "That's exactly what I'm trying to figure out — you tell me."
- One-line product description only (see intro). No demo, no feature list beyond the intro.
- **After every price question, stay silent for 5 seconds.** First number is the answer; note it before speaking.
- Do not correct "unrealistic" numbers. Do not react to high or low answers.
- Ask questions in order; Q8 price points in the randomised order listed on your sheet.

---

**Read aloud at the start (compliance disclaimer — do not paraphrase):**

> "Thanks for joining. I'm researching pricing for trading software. To be clear up front: this is not investment advice, and nothing I show you promises or predicts any return. AQOS is software you'd run against your own exchange account with your own API keys — we never hold your funds. Your answers are anonymised and used only for product research."

**Intro framing (read):** "AQOS is non-custodial software that runs systematic, institutional-style strategies — the kind a fund might use — inside your own exchange accounts. You set limits like position size and maximum drawdown; the code enforces them around the clock and logs every decision to a tamper-evident trail. There's a free paper-trading tier, and a paid tier for live trading. Today I want to understand what the paid tier would be worth to you."

**Q1.** "Walk me through how you trade today — which venues, what's manual, what's automated?"
**Q2.** "What do you currently spend per month, in total, on trading tools and subscriptions — bots, data, signals, all of it?" *(baseline; probe: "and what do you get for that?")*
**Q3.** "What's the single most frustrating thing about the tools you use or have tried?"

**Q4–Q7 — Van Westendorp (about the paid Core tier; read slowly, pause 5s after each):**
**Q4.** "At what price per month would AQOS Core be so cheap that you'd doubt it was any good?"
**Q5.** "At what price per month would AQOS Core be a bargain — great value for money?"
**Q6.** "At what price per month would AQOS Core start to get expensive — you'd think about it, but still consider paying?"
**Q7.** "At what price per month would AQOS Core be so expensive that you would never consider it?"

**Competitor anchor (read after Q7, then re-ask):** "For context — 3Commas charges $20 to $140 a month depending on plan, Cryptohopper $29 to $129, Bitsgap $29 to $149, and exchanges like Binance include basic bots free. Does that change any of your four numbers?"

**Q8 — price-point reactions (randomise order of $49 / $99 / $199):**
"For a Core tier with multi-exchange live trading, risk limits you control, and a tamper-evident audit trail —
- **$49/month:** would you pay this? What would it have to include? What would be missing?
- **$99/month:** same questions — and at this price, what would you expect that $49 shouldn't include?
- **$199/month:** same questions — who, if anyone, should this tier be for?"

**Q9 — feature-vs-price tradeoffs (show as a list):** "Four things AQOS could build. For each: would it justify **+ $50/month** to you, could you live without it at **– $30/month**, or no difference?
- Multi-venue execution (several exchanges, one risk view)
- Institutional-style risk layers (drawdown brakes, per-strategy kill switches, reduce-only fallback)
- AI-written daily reports explaining what the system did and why
- Free paper-trading Lab with graduation gate before live money"

**Q10.** "Last question. If we launched tomorrow at [repeat their Q5 bargain price], what would still stop you from paying for it?"

Close: thank, confirm incentive delivery, ask for one referral ("who else trades systematically and might give me 30 minutes?").

---

## 4. Analysis Plan

**Step 1 — compute the curves (spreadsheet, ~1 hour).** For each of the four questions, sort answers ascending and compute cumulative % of respondents at each price. Plot four lines on one chart, price on the x-axis:
- "Too cheap": cumulative % saying *at or below* this price (falls as price rises)
- "Cheap", "Expensive", "Too expensive": cumulative % saying *at or below* this price (rise with price)

**Step 2 — read the crossings:**
- **Lower bound (Point of Marginal Cheapness):** "too cheap" crosses "expensive" — below this, too many people doubt quality.
- **Upper bound (Point of Marginal Expensiveness):** "cheap" crosses "too expensive" — above this, resistance dominates.
- **Range between them = acceptable price range.**
- **Optimal price point:** "too cheap" crosses "too expensive" — equal rejection on both sides; the defensible single price.
- **Stress check (indifference point):** "cheap" crosses "expensive" — median psychology anchor; optimal should sit near it.

Report crossings **overall and per capital band** (S1 strata). n = 25 gives ±~10pp on cumulative curves — treat crossings as bands, read to the nearest $10.

**Step 3 — map to the tier ladder.**
- Acceptable range → **Core** price. Set **Pro ≈ 1.8–2× Core** (top of acceptable range or Q8 $199 acceptance rate > 30%), **Lab stays free** (acquisition per business-strategy §3), **Desk priced from B2B conversations, not this study.**
- Q9 results decide what Core *includes*: any feature where > 50% answer "+$50" moves from Core to Pro; any feature where > 50% say "–$30 to drop" is Pro-or-bust regardless.

**Step 4 — fee-burden check.** Minimum connected capital at the 1% target = `12 × monthly price ÷ 1%` (= 1,200 × price). At the 2% flag: `600 × price`.

| Core price | Min capital @ 1% target | Min capital @ 2% flag |
|---|---|---|
| $49 | $58,800 | $29,400 |
| $99 | $118,800 | $59,400 |
| $199 | $238,800 | $119,400 |

**Note:** an earlier draft cited "$99/mo ⇒ ~$12k minimum" — that implies a 10% burden, inconsistent with the 1% target; use the formula above. Consequence: at any Core price ≥ ~$17/mo, a $10k account breaches even the 2% flag. The guardrail therefore pushes either (a) a sub-$20 entry tier, (b) targeting the $50k+ bands, or (c) explicitly tolerating flags for small accounts. Stratified results (Step 2 by S1 band) decide which.

**Step 5 — decision rules.**
1. **Optimal point < $49:** do not cut price — revisit positioning first. The "institutional-style, non-custodial" frame is not landing; retest with a rewritten intro before accepting a lower number.
2. **Optimal $49–79, and > 50% of the $10–50k band rejects $49 as too expensive:** launch Core at $49 but make the free Lab → Core graduation the volume path; recheck whether the target segment should be $50k+ capital.
3. **Optimal $80–129:** launch Core at $99, Pro at $199; confirm ≥ 30% accept $199 in Q8.
4. **Optimal ≥ $130:** price Core at $129 and investigate whether "Desk-style" features belong in Core; run a second PSM on Pro before setting it.
5. **Any result:** verify `1,200 × chosen Core price` against the *median* capital of the interview sample. If median capital < min capital at 1%, the price is safe only at the 2% flag level — choose a lower price or a higher-capital segment, and say so in the pricing memo.

---

## 5. Compliance Note

- **Never promise, project, or imply returns** — in the script, the incentive message, recruitment posts, or the final memo. The disclaimer in Section 3 is read verbatim at the start of every interview.
- Positioning throughout: **non-custodial software vendor**, not adviser, not asset manager. No performance fees discussed.
- Do not collect exchange credentials, account statements, or portfolio holdings. Capital band is self-reported ranges only (S1).
- Store answers in one spreadsheet, first-name or ID only; delete recordings after the pricing memo is written.
- Any public write-up of results (e.g., Reddit thank-you post) must use aggregates only, no quotes attributable to individuals.

// Onboarding policy. These are product guardrails, not investment advice:
//  * blocked jurisdictions are refused (list owned by compliance; the KYC
//    provider also screens addresses for sanctioned regions)
//  * where the platform's derivatives venues are not available to retail
//    clients, derivatives strategies are disabled
//  * the appropriateness score caps the risk profile; everyone starts in PAPER
//  * every required disclosure must be accepted, version and hash recorded
const BLOCKED = new Set(['KP', 'IR', 'CU']);                  // illustrative; compliance maintains
const NO_RETAIL_DERIVATIVES = new Set(['GB', 'US']);          // illustrative; see the jurisdiction matrix
const REQUIRED_DOCS = ['terms', 'risk_disclosure', 'privacy', 'non_advice_ack', 'fee_schedule'];

function score(q) {
  const exp = { none: 0, lt1: 10, '1to3': 20, gt3: 30 }[q?.experience] ?? 0;
  const quiz = Math.max(0, Math.min(8, Number(q?.quiz_correct ?? 0)));
  const knowledge = Math.round((quiz / 8) * 50);
  const capacity = q?.can_bear_total_loss === true ? 20 : 0;
  return { total: exp + knowledge + capacity, quizPassed: quiz >= 6 };
}

const b = $input.first().json.body ?? {};
const errors = [];
const email = String(b.email ?? '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('invalid_email');
const jurisdiction = String(b.jurisdiction ?? '').toUpperCase().slice(0, 5);
if (!/^[A-Z]{2}(-[A-Z0-9]{1,2})?$/.test(jurisdiction)) errors.push('invalid_jurisdiction');
const consents = Array.isArray(b.consents) ? b.consents : [];
for (const doc of REQUIRED_DOCS) {
  const c = consents.find((x) => x?.doc_type === doc);
  if (!c || !c.doc_version || !/^[0-9a-f]{64}$/i.test(String(c.doc_sha256 ?? ''))) errors.push(`missing_consent_${doc}`);
}
const s = score(b.questionnaire);
const share = Number(b.questionnaire?.share_of_liquid_net_worth_pct ?? 100);
let riskProfile = 'CONSERVATIVE';
if (b.questionnaire?.can_bear_total_loss === true) {
  if (s.total >= 75 && share <= 25) riskProfile = 'DYNAMIC';
  else if (s.total >= 55) riskProfile = 'BALANCED';
}
const country = jurisdiction.split('-')[0];
const blocked = BLOCKED.has(country);
return [{
  json: {
    valid: errors.length === 0,
    errors,
    blocked,
    blocked_reason: blocked ? 'jurisdiction_not_served' : null,
    screening_request: { full_name: String(b.full_name ?? '').slice(0, 200), date_of_birth: b.date_of_birth ?? null, country, external_ref: b.external_ref ?? null },
    client: {
      external_ref: b.external_ref ?? null,
      email,
      jurisdiction,
      risk_profile: riskProfile,
      appropriateness_score: s.total,
      quiz_passed: s.quizPassed,
      derivatives_allowed: !NO_RETAIL_DERIVATIVES.has(country) && riskProfile !== 'CONSERVATIVE',
      tier: 'LAB',
      consents: consents.filter((c) => REQUIRED_DOCS.includes(c?.doc_type)).map((c) => ({ doc_type: c.doc_type, doc_version: String(c.doc_version), doc_sha256: String(c.doc_sha256).toLowerCase() })),
    },
  },
}];

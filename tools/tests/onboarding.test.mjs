// Unit tests for the onboarding Code-node scripts: signup validation,
// screening outcome mapping and the API-key permission policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFirst } from '../lib/sandbox.mjs';

const DOCS = ['terms', 'risk_disclosure', 'privacy', 'non_advice_ack', 'fee_schedule'];
const UPPER_SHA = 'A'.repeat(64);
// A signup that passes validation; `q` overrides questionnaire answers, `over` the rest.
const signup = (over = {}, q = {}) => ({
  full_name: 'Ada Lovelace',
  email: 'Ada@Example.COM',
  jurisdiction: 'DE',
  date_of_birth: '1990-01-01',
  external_ref: 'ref-1',
  questionnaire: { experience: '1to3', quiz_correct: 8, can_bear_total_loss: true, share_of_liquid_net_worth_pct: 20, ...q },
  consents: DOCS.map((doc_type) => ({ doc_type, doc_version: '1.0', doc_sha256: UPPER_SHA })),
  ...over,
});
const validate = (over = {}, q = {}) => runFirst('wf10-validate-signup.js', { input: [{ body: signup(over, q) }] });

// ------------------------------------------------------------------ validate signup
test('signup: a complete signup is valid, unblocked and normalised', async () => {
  const r = await validate();
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
  assert.equal(r.blocked, false);
  assert.equal(r.blocked_reason, null);
  assert.equal(r.client.email, 'ada@example.com');
  assert.equal(r.client.tier, 'LAB');
  assert.deepEqual(r.screening_request, { full_name: 'Ada Lovelace', date_of_birth: '1990-01-01', country: 'DE', external_ref: 'ref-1' });
});
test('signup: a malformed or missing email is rejected', async () => {
  for (const email of ['ada@example', 'ada @example.com', '', 'a@b']) {
    assert.deepEqual((await validate({ email })).errors, ['invalid_email'], email);
  }
});
test('signup: the jurisdiction must be a two-letter code, optionally with a region', async () => {
  assert.deepEqual((await validate({ jurisdiction: 'DEU' })).errors, ['invalid_jurisdiction']);
  assert.deepEqual((await validate({ jurisdiction: 'D' })).errors, ['invalid_jurisdiction']);
  assert.deepEqual((await validate({ jurisdiction: '12' })).errors, ['invalid_jurisdiction']);
  assert.deepEqual((await validate({ jurisdiction: 'DE-BY' })).errors, []);
});
test('signup: every required disclosure must be accepted with a version and a hash', async () => {
  for (const doc of DOCS) {
    const missing = DOCS.filter((d) => d !== doc);
    const r = await validate({ consents: missing.map((doc_type) => ({ doc_type, doc_version: '1.0', doc_sha256: UPPER_SHA })) });
    assert.deepEqual(r.errors, [`missing_consent_${doc}`]);
    assert.equal(r.valid, false);
  }
});
test('signup: a consent without a version or with a malformed hash is rejected', async () => {
  const unversioned = DOCS.map((doc_type) => ({ doc_type, doc_version: doc_type === 'terms' ? '' : '1.0', doc_sha256: UPPER_SHA }));
  assert.deepEqual((await validate({ consents: unversioned })).errors, ['missing_consent_terms']);
  const badHash = DOCS.map((doc_type) => ({ doc_type, doc_version: '1.0', doc_sha256: doc_type === 'terms' ? 'ZZ'.repeat(32) : UPPER_SHA }));
  assert.deepEqual((await validate({ consents: badHash })).errors, ['missing_consent_terms']);
});
test('signup: sanctioned countries are blocked with a reason, everything else is served', async () => {
  for (const jurisdiction of ['KP', 'IR', 'CU']) {
    const r = await validate({ jurisdiction });
    assert.equal(r.blocked, true);
    assert.equal(r.blocked_reason, 'jurisdiction_not_served');
    assert.equal(r.screening_request.country, jurisdiction);
  }
  assert.equal((await validate({ jurisdiction: 'GB-ENG' })).blocked, false);
});
test('signup: experience bands are worth 0, 10, 20 and 30 points', async () => {
  const points = { none: 0, lt1: 10, '1to3': 20, gt3: 30, unknown_band: 0 };
  for (const [experience, expected] of Object.entries(points)) {
    const r = await validate({}, { experience, quiz_correct: 0, can_bear_total_loss: false });
    assert.equal(r.client.appropriateness_score, expected, experience);
  }
});
test('signup: quiz knowledge is clamped to 0..8 answers and scaled to 50 points', async () => {
  for (const [quiz_correct, expected] of [[0, 0], [-5, 0], [4, 25], [8, 50], [20, 50]]) {
    const r = await validate({}, { experience: 'none', quiz_correct, can_bear_total_loss: false });
    assert.equal(r.client.appropriateness_score, expected, `quiz ${quiz_correct}`);
  }
});
test('signup: the knowledge quiz passes at six correct answers', async () => {
  const at = (n) => validate({}, { quiz_correct: n }).then((r) => r.client.quiz_passed);
  assert.equal(await at(5), false);
  assert.equal(await at(6), true);
  assert.equal(await at(8), true);
});
test('signup: the capacity for total loss is worth 20 points', async () => {
  assert.equal((await validate({}, { experience: 'none', quiz_correct: 0, can_bear_total_loss: true })).client.appropriateness_score, 20);
  assert.equal((await validate({}, { experience: 'none', quiz_correct: 0, can_bear_total_loss: false })).client.appropriateness_score, 0);
});
test('signup: a client who cannot bear a total loss is capped at CONSERVATIVE', async () => {
  const r = await validate({}, { experience: 'gt3', quiz_correct: 8, can_bear_total_loss: false, share_of_liquid_net_worth_pct: 5 });
  assert.equal(r.client.appropriateness_score, 80);
  assert.equal(r.client.risk_profile, 'CONSERVATIVE');
});
test('signup: a client who can bear the loss reaches BALANCED from a score of 55', async () => {
  assert.equal((await validate({}, { experience: 'gt3', quiz_correct: 1, share_of_liquid_net_worth_pct: 20 })).client.appropriateness_score, 56);
  assert.equal((await validate({}, { experience: 'gt3', quiz_correct: 1, share_of_liquid_net_worth_pct: 20 })).client.risk_profile, 'BALANCED');
  const low = await validate({}, { experience: 'lt1', quiz_correct: 0, share_of_liquid_net_worth_pct: 20 });
  assert.equal(low.client.appropriateness_score, 30);
  assert.equal(low.client.risk_profile, 'CONSERVATIVE');
});
test('signup: DYNAMIC needs a score of 75 or more and at most 25 percent of net worth', async () => {
  assert.equal((await validate({}, { experience: 'gt3', quiz_correct: 4, share_of_liquid_net_worth_pct: 25 })).client.appropriateness_score, 75);
  assert.equal((await validate({}, { experience: 'gt3', quiz_correct: 4, share_of_liquid_net_worth_pct: 25 })).client.risk_profile, 'DYNAMIC');
  assert.equal((await validate({}, { experience: 'gt3', quiz_correct: 4, share_of_liquid_net_worth_pct: 26 })).client.risk_profile, 'BALANCED');
  assert.equal((await validate({}, { experience: 'gt3', quiz_correct: 3, share_of_liquid_net_worth_pct: 25 })).client.risk_profile, 'BALANCED');
});
test('signup: derivatives are off in GB and US even for an otherwise dynamic client', async () => {
  for (const jurisdiction of ['GB', 'US', 'GB-ENG']) {
    const r = await validate({ jurisdiction });
    assert.equal(r.client.risk_profile, 'DYNAMIC', jurisdiction);
    assert.equal(r.client.derivatives_allowed, false, jurisdiction);
  }
  assert.equal((await validate({ jurisdiction: 'DE' })).client.derivatives_allowed, true);
});
test('signup: derivatives are off for a conservative profile anywhere', async () => {
  const r = await validate({ jurisdiction: 'DE' }, { experience: 'none', quiz_correct: 0, can_bear_total_loss: false });
  assert.equal(r.client.risk_profile, 'CONSERVATIVE');
  assert.equal(r.client.derivatives_allowed, false);
});
test('signup: only the required disclosures are stored, lower-cased and versioned', async () => {
  const extra = { doc_type: 'marketing', doc_version: '9', doc_sha256: 'B'.repeat(64) };
  const r = await validate({ consents: [...DOCS.map((doc_type) => ({ doc_type, doc_version: '1.0', doc_sha256: UPPER_SHA })), extra] });
  assert.deepEqual(r.client.consents.map((c) => c.doc_type), DOCS);
  assert.deepEqual(r.client.consents[0], { doc_type: 'terms', doc_version: '1.0', doc_sha256: 'a'.repeat(64) });
});

// ------------------------------------------------------------------ screening outcome
const V = { client: { email: 'ada@example.com', external_ref: 'ref-1', risk_profile: 'BALANCED', derivatives_allowed: true } };
const screen = (res) => runFirst('wf10-screening-outcome.js', { input: [res], nodes: { 'Validate signup': [V] }, now: '2026-10-02T12:00:00Z' });

test('screening: CLEAR activates, REVIEW holds for review and a HIT blocks', async () => {
  assert.equal((await screen({ result: 'CLEAR' })).route, 'ACTIVE');
  assert.equal((await screen({ result: 'clear' })).route, 'ACTIVE');
  assert.equal((await screen({ result: 'REVIEW' })).route, 'PENDING_REVIEW');
  assert.equal((await screen({ result: 'HIT' })).route, 'BLOCKED');
});
test('screening: an unknown result or a provider error never auto-activates', async () => {
  for (const res of [{ result: 'WEIRD' }, {}, { result: '' }, { error: { message: 'timeout' } }]) {
    assert.equal((await screen(res)).route, 'PENDING_REVIEW', JSON.stringify(res));
  }
  assert.equal((await screen({ error: { message: 'timeout' } })).create.screening.result, 'ERROR');
});
test('screening: the created record carries the client and the screening result', async () => {
  const r = await screen({ result: 'HIT', reference: 'screen-9' });
  assert.equal(r.create.email, 'ada@example.com');
  assert.equal(r.create.external_ref, 'ref-1');
  assert.equal(r.create.risk_profile, 'BALANCED');
  assert.equal(r.create.derivatives_allowed, true);
  assert.deepEqual(r.create.screening, { provider_ref: 'screen-9', result: 'HIT', checked_at: '2026-10-02T12:00:00.000Z' });
  assert.equal(r.email, 'ada@example.com');
});
test('screening: the route and the stored status always agree', async () => {
  for (const result of ['CLEAR', 'REVIEW', 'HIT', 'MYSTERY']) {
    const r = await screen({ result });
    assert.equal(r.route, r.create.status, result);
    assert.ok(['ACTIVE', 'PENDING_REVIEW', 'BLOCKED'].includes(r.create.status), result);
  }
  assert.equal((await screen({ result: 'CLEAR' })).create.screening.provider_ref, null);
});

// ------------------------------------------------------------------ key policy
const GOOD = { can_trade: true, can_withdraw: false, can_transfer: false, ip_restricted: true, futures_enabled: false };
const key = (perm, req = {}) => runFirst('wf10-key-policy.js', { input: [perm], nodes: { 'Key connected': [{ body: { account_id: 'a1', client_id: 'c1', venue: 'binance', key_ref: 'k1', email: 'ada@example.com', derivatives_allowed: false, ...req } }] } });

test('key policy: a compliant key is verified with no reasons', async () => {
  const r = await key(GOOD);
  assert.equal(r.status, 'VERIFIED');
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.instructions, []);
  assert.deepEqual(r.permissions, GOOD);
  assert.deepEqual([r.account_id, r.client_id, r.venue, r.key_ref, r.email], ['a1', 'c1', 'binance', 'k1', 'ada@example.com']);
});
test('key policy: each permission failure is reported on its own', async () => {
  for (const [perm, reason] of [
    [{ ...GOOD, can_withdraw: true }, 'withdrawals_must_be_disabled'],
    [{ ...GOOD, can_transfer: true }, 'internal_transfers_must_be_disabled'],
    [{ ...GOOD, ip_restricted: false }, 'ip_allowlist_required'],
    [{ ...GOOD, can_trade: false }, 'trading_permission_missing'],
    [{ ...GOOD, futures_enabled: true }, 'futures_permission_not_allowed_for_this_mandate'],
    [{ ...GOOD, error: 'exchange unreachable' }, 'permission_check_failed'],
  ]) {
    const r = await key(perm);
    assert.equal(r.status, 'REJECTED', reason);
    assert.deepEqual(r.reasons, [reason]);
  }
});
test('key policy: futures are allowed when the mandate enables derivatives', async () => {
  const r = await key({ ...GOOD, futures_enabled: true }, { derivatives_allowed: true });
  assert.equal(r.status, 'VERIFIED');
  assert.deepEqual(r.reasons, []);
  const off = await key({ ...GOOD, futures_enabled: true }, { derivatives_allowed: false });
  assert.deepEqual(off.reasons, ['futures_permission_not_allowed_for_this_mandate']);
});
test('key policy: several failures are all reported together', async () => {
  const r = await key({ can_trade: false, can_withdraw: true, can_transfer: true, ip_restricted: false, error: 'boom' });
  assert.equal(r.status, 'REJECTED');
  assert.deepEqual(r.reasons, ['permission_check_failed', 'trading_permission_missing', 'withdrawals_must_be_disabled', 'internal_transfers_must_be_disabled', 'ip_allowlist_required']);
});
test('key policy: there is one client-readable instruction line per reason', async () => {
  const r = await key({ can_trade: false, can_withdraw: true, ip_restricted: false, error: 'boom' });
  assert.equal(r.instructions.length, r.reasons.length);
  assert.equal(r.instructions.length, 4);
  for (const line of r.instructions) {
    assert.equal(typeof line, 'string');
    assert.ok(line.length > 10 && !line.includes('_'), line);
  }
  assert.ok(r.instructions.some((i) => /withdrawals disabled/.test(i)));
  assert.ok(r.instructions.some((i) => /IP addresses/.test(i)));
});
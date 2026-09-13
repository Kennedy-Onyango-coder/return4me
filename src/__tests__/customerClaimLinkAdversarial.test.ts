import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';
import {
  compareVerificationAnswers,
  isAnswerValidationSuccess,
  isAnswerValidationFailure,
  LEGACY_EVIDENCE_KEYS,
} from '../services/verificationValidation';
import { verificationProfiles, getVerificationFields } from '../config/verificationProfiles';

// ---------------------------------------------------------------------------
// ADVERSARIAL suite for the claim-link proof, run at the HTTP boundary.
//
// Where customerClaimRoutes.test.ts proves the authorization/shape contract,
// this file attacks the PROOF itself: OTP replay across challenges and across
// claims, session swapping between the two steps, fabricated client state,
// concurrent linking races, and the answer matcher's normalisation (including
// whether "normalisation" accidentally makes materially different answers
// compare equal).
// ---------------------------------------------------------------------------

const sms = vi.hoisted(() => ({ sent: [] as Array<{ phone: string; code: string }> }));

vi.mock('../services/auth', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    sendCodeViaSms: vi.fn(async (phone: string, code: string) => {
      sms.sent.push({ phone, code });
      return { success: true, message: 'simulated in test' };
    }),
  };
});

const { registerCustomerClaimRoutes } = await import('../routes/customerClaims');

const RUN = testRunId;
const base = Math.floor(10000000 + Math.random() * 89999999);
const phone = (o: number) => '+2547' + String(base + o).slice(-8);

const PHONE_A = phone(0);
const PHONE_B = phone(1);

const CUSTOMER_A = `TEST-ADV-CUS-A-${RUN}`;
const CUSTOMER_B = `TEST-ADV-CUS-B-${RUN}`;
const TOKEN_A = 'p'.repeat(64);
const TOKEN_B = 'q'.repeat(64);

const AGENT = `TEST-ADV-AGENT-${RUN}`;
const item = (n: number) => `TEST-ADV-ITEM-${n}-${RUN}`;
const claim = (n: number) => `TEST-ADV-CLAIM-${n}-${RUN}`;

// Distinct stored answers per claim so "answers for claim A" cannot be reused
// on claim B by accident.
const ANSWERS_A = { lastDigits: '1234', fullName: 'Asha Mwangi' };
const ANSWERS_B = { lastDigits: '9876', fullName: 'Brian Otieno' };

let server: any;
let baseUrl = '';

function claimRow(id: string, itemId: string, ownerPhone: string, answers: any) {
  return {
    id,
    item_id: itemId,
    owner_phone: ownerPhone,
    security_answers: answers,
    verification_tier: 1 as const,
    status: 'at_agent',
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
  } as any;
}

async function seed() {
  await db.createCustomer(CUSTOMER_A, 'Asha Mwangi', PHONE_A);
  await db.createCustomer(CUSTOMER_B, 'Brian Otieno', PHONE_B);
  const in7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.createCustomerSession(`TEST-ADV-SESS-A-${RUN}`, CUSTOMER_A, hashCode(TOKEN_A), in7);
  await db.createCustomerSession(`TEST-ADV-SESS-B-${RUN}`, CUSTOMER_B, hashCode(TOKEN_B), in7);
  await db.createAgent({
    id: AGENT, business_name: 'Adv Agent', contact_phone: '+254722222222',
    location_address: 'Test Rd', latitude: null, longitude: null,
  } as any);
  await ensureTestCategory('national-id');

  // 1-13: A owns 1,2,3,5,7,8,9,10,11,12,13; B owns 4 and 6.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
    await db.createItem({
      id: item(n), category_id: 'national-id', photo_url: null,
      ocr_extracted_number: null, ocr_extracted_name: null, document_number_hash: null,
      document_name_fuzzy: 'National ID', location_description: 'Test', latitude: null,
      longitude: null, finder_phone: null, assigned_agent_id: AGENT, status: 'at_agent',
      flaggedForReview: false, isDescriptionOnly: false, description: null,
      is_sensitive_document: true, rejection_reason: null,
    } as any);
  }
  for (const n of [1, 2, 3, 5, 7, 8, 9, 10, 11, 12, 13]) {
    await db.createClaim(claimRow(claim(n), item(n), PHONE_A, ANSWERS_A));
  }
  for (const n of [4, 6]) {
    await db.createClaim(claimRow(claim(n), item(n), PHONE_B, ANSWERS_B));
  }
}

beforeAll(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  registerCustomerClaimRoutes(app, {
    checkClaimExpiry: async (c: any) => c,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function api(method: string, urlPath: string, token?: string, body?: any) {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = 'r4m_customer_session=' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + urlPath, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// Requests a link OTP through the real route and returns the code that was
// actually generated and "SMSed".
async function requestCode(token: string, claimId: string) {
  sms.sent.length = 0;
  const res = await api('POST', '/api/customer/claims/link/request-otp', token, { claimId });
  return { res, code: sms.sent.length ? sms.sent[sms.sent.length - 1].code : null };
}

async function verify(token: string, claimId: string, code: string | null, answers: any) {
  return api('POST', '/api/customer/claims/link/verify', token, {
    claimId, code, securityAnswers: answers,
  });
}

describe('OTP proof: binding, freshness, single-use', () => {
  it('A–G. the issued challenge is claim-specific, server-side hashed, expiring, attempt-capped and single-use', async () => {
    const { res, code } = await requestCode(TOKEN_A, claim(1));
    expect(res.status).toBe(200);
    expect(code).toMatch(/^\d{4}$/);

    const record = await db.getClaimOtp(claim(1));
    expect(record).toBeDefined();
    // A: stored against THIS claim id (not a customer/session-wide challenge).
    // E: the plaintext code is never stored — only its hash.
    expect(record!.code_hash).toBe(hashCode(code!));
    expect(record!.code_hash).not.toBe(code);
    // C: expires in the near future (5-minute window).
    const ttl = record!.expires_at.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    // D: attempt counter starts at zero and is capped by the route.
    expect(record!.attempts).toBe(0);
    // B: issued only to the claim's registered owner phone (the SMS target).
    expect(sms.sent[sms.sent.length - 1]?.phone).toBe(PHONE_A);

    // G/F: a successful verification consumes the challenge BEFORE creating
    // anything, so replay is impossible.
    const ok = await verify(TOKEN_A, claim(1), code, ANSWERS_A);
    expect(ok.status).toBe(200);
    expect(await db.getClaimOtp(claim(1))).toBeUndefined();

    const replay = await verify(TOKEN_A, claim(1), code, ANSWERS_A);
    // Already linked -> the route short-circuits idempotently and does NOT
    // mint a new challenge; either way no second proof was accepted.
    expect(replay.status).toBe(200);
    expect(replay.body.alreadyLinked).toBe(true);
    expect(await db.getClaimOtp(claim(1))).toBeUndefined();
  });

  it('H. a wrong OTP cannot create a link, and cannot consume the real one', async () => {
    const { code } = await requestCode(TOKEN_A, claim(2));
    const wrong = String((Number(code) + 7) % 10000).padStart(4, '0');
    const bad = await verify(TOKEN_A, claim(2), wrong, ANSWERS_A);
    expect(bad.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(claim(2))).toBeUndefined();
    // The genuine challenge still works afterwards.
    expect((await verify(TOKEN_A, claim(2), code, ANSWERS_A)).status).toBe(200);
  });

  it('I. an expired OTP cannot create a link', async () => {
    await db.setClaimOtp(claim(7), hashCode('2468'), new Date(Date.now() - 1));
    const res = await verify(TOKEN_A, claim(7), '2468', ANSWERS_A);
    expect(res.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(claim(7))).toBeUndefined();
    expect(await db.getClaimOtp(claim(7))).toBeUndefined();
  });

  it('J. an OLD code cannot authorize a LATER challenge for the same claim', async () => {
    // Issue challenge #1 through the real route...
    const { code: oldCode } = await requestCode(TOKEN_A, claim(3));
    expect(oldCode).toMatch(/^\d{4}$/);
    // ...then supersede it, as any later request (or a Track Claim request-otp)
    // for the same claim would.
    const newCode = '8642';
    await db.setClaimOtp(claim(3), hashCode(newCode), new Date(Date.now() + 5 * 60 * 1000));

    const stale = await verify(TOKEN_A, claim(3), oldCode, ANSWERS_A);
    expect(stale.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(claim(3))).toBeUndefined();

    // The CURRENT challenge is the only one that works.
    expect((await verify(TOKEN_A, claim(3), newCode, ANSWERS_A)).status).toBe(200);
  });

  it('K. an OTP issued for claim A cannot authorize claim B', async () => {
    const { code } = await requestCode(TOKEN_A, claim(5));
    // claim(5) and claim(7) are BOTH this customer's, so the phone check passes
    // for both — only the per-claim challenge can tell them apart. claim(7) has
    // no live challenge at this point.
    const cross = await verify(TOKEN_A, claim(7), code, ANSWERS_A);
    expect(cross.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(claim(7))).toBeUndefined();
    // The failed cross-claim attempt did NOT consume claim(5)'s challenge.
    expect(await db.getClaimOtp(claim(5))).toBeDefined();
    expect((await verify(TOKEN_A, claim(5), code, ANSWERS_A)).status).toBe(200);
  });

  it('L. a browser-supplied otpVerified flag cannot bypass server verification', async () => {
    // claim(9) has no challenge at all.
    expect(await db.getClaimOtp(claim(9))).toBeUndefined();
    const res = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: claim(9), code: '0000', securityAnswers: ANSWERS_A,
      otpVerified: true, otp_verified: true, verified: true, attempts: 0,
      code_hash: hashCode('0000'), expires_at: new Date(Date.now() + 60000).toISOString(),
    });
    expect(res.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(claim(9))).toBeUndefined();
  });

  it('O. a correct OTP with wrong security answers cannot create a link', async () => {
    const { code } = await requestCode(TOKEN_A, claim(8));
    const res = await verify(TOKEN_A, claim(8), code, { lastDigits: '0000', fullName: 'Nobody Here' });
    expect(res.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(claim(8))).toBeUndefined();
    // The code was consumed (fail-closed): the proof cannot be reused to try
    // answers repeatedly.
    expect(await db.getClaimOtp(claim(8))).toBeUndefined();
  });

  it('the CLIENT cannot choose the verification profile — the category comes from the server-side item', async () => {
    const { res, code } = await requestCode(TOKEN_A, claim(13));
    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBe('national-id');

    // The submitted answers are national-id shaped. If the route honoured a
    // body-supplied category, 'national-id' answers would be rejected against
    // 'other-item' (which requires `description` and does not allow
    // `lastDigits`/`fullName`) and this would 400.
    const ok = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: claim(13), code, securityAnswers: ANSWERS_A,
      categoryId: 'other-item', category_id: 'other-item', category: 'other-item',
    });
    expect(ok.status).toBe(200);
    expect(await db.getCustomerClaimLinkForClaim(claim(13))).toBeDefined();
  });
});

describe('session binding and cross-customer attempts', () => {
  it('N. swapping the authenticated session between request and verify cannot create a cross-customer link', async () => {
    // claim(4) belongs to customer B's phone. B starts the flow...
    const { code } = await requestCode(TOKEN_B, claim(4));
    expect(code).toMatch(/^\d{4}$/);
    // ...then customer A (a DIFFERENT authenticated session) tries to finish it
    // with B's code and B's answers. A's account phone does not match the
    // claim's registered owner phone, so this must fail — and it must not reveal
    // whether the claim exists.
    const stolen = await verify(TOKEN_A, claim(4), code, ANSWERS_B);
    expect(stolen.status).toBe(404);
    expect(await db.getCustomerClaimLinkForClaim(claim(4))).toBeUndefined();
    // A's attempt must NOT have burned B's challenge.
    expect(await db.getClaimOtp(claim(4))).toBeDefined();

    // B completes normally.
    expect((await verify(TOKEN_B, claim(4), code, ANSWERS_B)).status).toBe(200);
    expect((await db.getCustomerClaimLinkForClaim(claim(4)))!.customer_id).toBe(CUSTOMER_B);

    // A never gains access to it.
    const aList = await api('GET', '/api/customer/claims', TOKEN_A);
    expect(aList.body.claims.map((c: any) => c.id)).not.toContain(claim(4));
  });

  it('M. a body-supplied customerId cannot override req.customer', async () => {
    const { code } = await requestCode(TOKEN_A, claim(10));
    const res = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: claim(10), code, securityAnswers: ANSWERS_A,
      customerId: CUSTOMER_B, customer_id: CUSTOMER_B, customer: CUSTOMER_B,
    });
    expect(res.status).toBe(200);
    // The link landed on the SESSION's customer, never the body's.
    expect((await db.getCustomerClaimLinkForClaim(claim(10)))!.customer_id).toBe(CUSTOMER_A);
    const bList = await api('GET', '/api/customer/claims', TOKEN_B);
    expect(bList.body.claims.map((c: any) => c.id)).not.toContain(claim(10));
  });

  it('P. correct security answers for claim A cannot authorize claim B', async () => {
    // claim(6) belongs to B and stores DIFFERENT answers.
    const { code } = await requestCode(TOKEN_B, claim(6));
    // A's answers (valid for A's claims) must not work here.
    expect((await verify(TOKEN_B, claim(6), code, ANSWERS_A)).status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(claim(6))).toBeUndefined();
    // The rejected attempt consumed the proof (fail-closed), so a retry needs a
    // fresh challenge — seeded directly here because the route's 30s resend
    // throttle would otherwise (correctly) refuse a second SMS this quickly.
    expect(await db.getClaimOtp(claim(6))).toBeUndefined();
    const fresh = '1357';
    await db.setClaimOtp(claim(6), hashCode(fresh), new Date(Date.now() + 5 * 60 * 1000));
    // B's OWN answers do work.
    expect((await verify(TOKEN_B, claim(6), fresh, ANSWERS_B)).status).toBe(200);
    expect(await db.getCustomerClaimLinkForClaim(claim(6))).toBeDefined();
  });

  it('a foreign session cannot use another customer\'s phone as an authorization shortcut', async () => {
    sms.sent.length = 0;
    const res = await api('POST', '/api/customer/claims/link/request-otp', TOKEN_A, {
      claimId: claim(6), phone: PHONE_B, owner_phone: PHONE_B,
    });
    expect(res.status).toBe(404);
    // No SMS was dispatched to anyone.
    expect(sms.sent.length).toBe(0);
  });
});

describe('concurrency and idempotency', () => {
  it('two different customers racing the same claim: at most one wins, ownership cannot be overwritten', async () => {
    const results = await Promise.all([
      db.linkClaimToCustomer(`TEST-ADV-RACE-A-${RUN}`, CUSTOMER_A, claim(11), 'race'),
      db.linkClaimToCustomer(`TEST-ADV-RACE-B-${RUN}`, CUSTOMER_B, claim(11), 'race'),
    ]);
    // Exactly one insert wins; the loser is refused as belonging to the other
    // account. It can never silently overwrite ownership, and it is never told
    // it succeeded.
    expect(results.filter((r) => r === 'linked')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_linked_other')).toHaveLength(1);

    const link = await db.getCustomerClaimLinkForClaim(claim(11));
    expect(link).toBeDefined();
    const owner = link!.customer_id;
    expect([CUSTOMER_A, CUSTOMER_B]).toContain(owner);

    // Only the winner sees it; the loser does not.
    const ownerToken = owner === CUSTOMER_A ? TOKEN_A : TOKEN_B;
    const otherToken = owner === CUSTOMER_A ? TOKEN_B : TOKEN_A;
    const ownerList = await api('GET', '/api/customer/claims', ownerToken);
    const otherList = await api('GET', '/api/customer/claims', otherToken);
    expect(ownerList.body.claims.map((c: any) => c.id)).toContain(claim(11));
    expect(otherList.body.claims.map((c: any) => c.id)).not.toContain(claim(11));
  });

  it('the loser of a race can neither unlink nor re-link the winner\'s claim', async () => {
    const owner = (await db.getCustomerClaimLinkForClaim(claim(11)))!.customer_id;
    const loser = owner === CUSTOMER_A ? CUSTOMER_B : CUSTOMER_A;
    // Unlink: refused, ownership intact.
    expect(await db.unlinkClaimFromCustomer(loser, claim(11))).toBe(false);
    expect((await db.getCustomerClaimLinkForClaim(claim(11)))!.customer_id).toBe(owner);
    // Re-link: still refused.
    const retry = await db.linkClaimToCustomer(`TEST-ADV-RACE-RETRY-${RUN}`, loser, claim(11), 'race');
    expect(retry).toBe('already_linked_other');
    expect((await db.getCustomerClaimLinkForClaim(claim(11)))!.customer_id).toBe(owner);
  });

  it('the same customer linking the same claim concurrently is idempotent', async () => {
    const results = await Promise.all([
      db.linkClaimToCustomer(`TEST-ADV-IDEM-1-${RUN}`, CUSTOMER_A, claim(12), 'idem'),
      db.linkClaimToCustomer(`TEST-ADV-IDEM-2-${RUN}`, CUSTOMER_A, claim(12), 'idem'),
    ]);
    expect(results.filter((r) => r === 'linked')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_linked_self')).toHaveLength(1);
    // Sequential repeats stay idempotent and never change ownership.
    expect(await db.linkClaimToCustomer(`TEST-ADV-IDEM-3-${RUN}`, CUSTOMER_A, claim(12), 'idem')).toBe('already_linked_self');
    expect((await db.getCustomerClaimLinkForClaim(claim(12)))!.customer_id).toBe(CUSTOMER_A);
  });
});

// ---------------------------------------------------------------------------
// §7 — the answer matcher itself, exercised across EVERY supported category
// (not just the one the HTTP fixtures use), so a category-specific rule cannot
// silently break linking for that item type.
// ---------------------------------------------------------------------------
describe('security-answer matcher', () => {
  const sampleFor = (field: any) => (field.key === 'lastDigits' ? 'A1B2' : 'Sample');
  function answersFor(categoryId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of getVerificationFields(categoryId)) out[f.key] = sampleFor(f);
    return out;
  }

  it('is exercised against every supported verification category', () => {
    expect(Object.keys(verificationProfiles).length).toBeGreaterThanOrEqual(30);
  });

  for (const categoryId of Object.keys(verificationProfiles)) {
    it(`category "${categoryId}": correct answers match, a wrong required answer does not`, () => {
      const stored = answersFor(categoryId);
      expect(isAnswerValidationSuccess(compareVerificationAnswers(categoryId, stored, { ...stored }))).toBe(true);

      const required = getVerificationFields(categoryId).filter((f) => f.required);
      expect(required.length).toBeGreaterThan(0);
      for (const field of required) {
        const bad = { ...stored, [field.key]: field.key === 'lastDigits' ? 'ZZZZ' : 'Definitely Wrong' };
        expect(isAnswerValidationFailure(compareVerificationAnswers(categoryId, stored, bad))).toBe(true);
      }
    });
  }

  it('normalisation is deliberate and bounded — case/whitespace/punctuation only', () => {
    // Case-only difference on lastDigits.
    expect(isAnswerValidationSuccess(
      compareVerificationAnswers('national-id', { lastDigits: 'A1B2', fullName: 'Asha Mwangi' },
        { lastDigits: 'a1b2', fullName: '  asha   MWANGI  ' })
    )).toBe(true);

    // Punctuation on lastDigits is stripped before comparison, but only for
    // inputs whose RAW length already satisfies the profile's maxLength: 4
    // (the cap is applied to the trimmed value before any cleaning), so
    // 'a-12' (4 raw chars) is accepted and normalises to 'A12'.
    expect(isAnswerValidationSuccess(
      compareVerificationAnswers('national-id', { lastDigits: 'A12', fullName: 'Asha Mwangi' },
        { lastDigits: 'a-12', fullName: 'Asha Mwangi' })
    )).toBe(true);
  });

  it('a stored lastDigits longer than the profile allows can never be matched (shape rule wins)', () => {
    // validateVerificationAnswers caps the CLEANED lastDigits at 4 characters
    // for every submission. A pre-profile claim whose stored value is longer
    // (e.g. a full document number) therefore cannot be linked — the
    // submission that would match it is rejected as malformed before any
    // comparison happens. Same class of documented limitation as the legacy
    // key formats below; both are pre-refactor data only.
    const storeWithLongDigits = { lastDigits: 'KX123A', fullName: 'Asha Mwangi' };
    expect(isAnswerValidationFailure(
      compareVerificationAnswers('national-id', storeWithLongDigits, { lastDigits: 'kx-123a', fullName: 'Asha Mwangi' })
    )).toBe(true);
  });

  it('normalisation does NOT make materially different answers compare equal', () => {
    const stored = { lastDigits: 'A1B2', fullName: 'Asha Mwangi' };
    const mustFail: Array<Record<string, string>> = [
      { lastDigits: 'A1B2', fullName: 'Asha Mwangii' },
      { lastDigits: 'A1B2', fullName: 'Asha Mwange' },
      { lastDigits: 'A1B3', fullName: 'Asha Mwangi' },
      { lastDigits: 'A1B', fullName: 'Asha Mwangi' },
      { lastDigits: 'A1B23', fullName: 'Asha Mwangi' },
      { lastDigits: 'A1B2', fullName: '' },
      { lastDigits: 'A1B2', fullName: 'Mwangi Asha' },
    ];
    for (const submitted of mustFail) {
      expect(isAnswerValidationFailure(compareVerificationAnswers('national-id', stored, submitted))).toBe(true);
    }
  });

  it('a wrong OPTIONAL answer does not block linking (required fields are the identity proof)', () => {
    // Pinned deliberately: only required fields are compared, matching the
    // existing model where the assigned agent visually verifies optional
    // evidence. Changing this must be a conscious decision.
    const stored = { lastDigits: 'A1B2', fullName: 'Asha Mwangi', lostLocation: 'Nairobi' };
    expect(isAnswerValidationSuccess(
      compareVerificationAnswers('national-id', stored, { lastDigits: 'A1B2', fullName: 'Asha Mwangi', lostLocation: 'Mombasa' })
    )).toBe(true);
  });
});

describe('security-answer matcher: fail-closed cases', () => {
  it('rejects forbidden and unknown fields', () => {
    const stored = { lastDigits: 'A1B2', fullName: 'Asha Mwangi' };
    for (const bad of [{ cvv: '123' }, { password: 'x' }, { otp: '1234' }, { token: 'x' }, { secret: 'x' }, { cardNumber: '4111' }, { totallyUnknown: 'x' }]) {
      expect(isAnswerValidationFailure(compareVerificationAnswers('national-id', stored, bad))).toBe(true);
    }
  });

  it('fails closed when the claim has no usable stored answers', () => {
    const submitted = { lastDigits: 'A1B2', fullName: 'Asha Mwangi' };
    for (const stored of [undefined, null, {}, '', [], { lastDigits: '', fullName: '' }, { lastDigits: '   ' }]) {
      expect(isAnswerValidationFailure(compareVerificationAnswers('national-id', stored, submitted))).toBe(true);
    }
  });

  it('fails closed when the submission is missing entirely', () => {
    const stored = { lastDigits: 'A1B2', fullName: 'Asha Mwangi' };
    for (const submitted of [undefined, null, {}, [], 'Asha Mwangi']) {
      expect(isAnswerValidationFailure(compareVerificationAnswers('national-id', stored, submitted))).toBe(true);
    }
  });

  it('never returns or echoes the expected answer in a failure', () => {
    const stored = { lastDigits: 'A1B2', fullName: 'Asha Mwangi' };
    const result = compareVerificationAnswers('national-id', stored, { lastDigits: 'A1B2', fullName: 'Nobody' });
    expect(isAnswerValidationFailure(result)).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('A1B2');
    expect(serialized).not.toContain('fullName');
    expect(serialized).not.toContain('lastDigits');
  });

  it('legacy pre-profile answer keys fail closed (documented limitation)', () => {
    // Exactly four historical key formats exist. They predate the category
    // profile system, and validateVerificationAnswers rejects them for new
    // submissions, so they can only exist on claims created before the refactor.
    expect([...LEGACY_EVIDENCE_KEYS].sort()).toEqual(
      ['colorDetail', 'lastNameOnDoc', 'lostDetails', 'whereLost'].sort()
    );

    // A claim storing ONLY legacy keys cannot be linked: the current profile's
    // required fields are absent from the stored record, so the matcher fails
    // rather than falling back to "anything matches".
    const legacyOnly = { lostDetails: 'near the market', colorDetail: 'black' };
    expect(isAnswerValidationFailure(
      compareVerificationAnswers('national-id', legacyOnly, { lastDigits: 'A1B2', fullName: 'Asha Mwangi' })
    )).toBe(true);

    // A claim that has BOTH the current required keys and legacy extras still
    // links — legacy keys are simply not part of the comparison.
    const mixed = { lastDigits: 'A1B2', fullName: 'Asha Mwangi', lostDetails: 'legacy noise' };
    expect(isAnswerValidationSuccess(
      compareVerificationAnswers('national-id', mixed, { lastDigits: 'A1B2', fullName: 'Asha Mwangi' })
    )).toBe(true);
  });
});

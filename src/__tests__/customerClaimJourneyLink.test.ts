import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import {
  resolveOptionalCustomer,
  linkVerifiedClaimToCustomer,
  JOURNEY_CLAIM_LINK_VIA,
} from '../services/customerAuth';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';

// ---------------------------------------------------------------------------
// PHASE 7C.3 / F11 — AUTOMATIC CUSTOMER-CLAIM LINK AT OTP VERIFICATION.
//
// Three verification layers, because the implementation is split across three
// places and each needs the strongest evidence that is actually available:
//
//  LAYER 1 (behavioural, real HTTP): `resolveOptionalCustomer` is a real
//  exported function, so it is exercised over an actual TCP socket against the
//  REAL db (customer sessions, revocation, expiry, account status) and against
//  forged request input. This is what proves "identity comes only from the
//  session" and "an invalid session is treated exactly as anonymous".
//
//  LAYER 2 (behavioural, real db + real primitive): `linkVerifiedClaimToCustomer`
//  is called directly against the REAL customer_claim_links table, so the
//  phone-normalisation rule, the outcome mapping, idempotency, the refusal to
//  re-point another account's link and the non-fatal failure path are all
//  observed rather than asserted from source text.
//
//  LAYER 3 (source audit, server.ts): server.ts calls startServer() at import
//  time (Vite middleware, background sweeps, listeners), so it CANNOT be
//  imported by a test — the same constraint documented in
//  routes/customerClaims.ts's header. The route's wiring is therefore asserted
//  against the route's own source text: that the hook runs strictly AFTER the
//  committed transition and the single-use OTP consumption, that it never
//  touches requireCustomerAuth, that it cannot fail the request, and that
//  /api/claims/submit is untouched. Everything the hook delegates to is
//  covered behaviourally by layers 1 and 2.
//
// The HTTP harness in layer 1 is deliberately tiny: it mounts the REAL
// resolver and the REAL link helper with the same additive glue server.ts
// uses, so session resolution can be observed end-to-end without duplicating
// any claim logic (the claim comes straight from the fixture).
// ---------------------------------------------------------------------------

const RUN = testRunId;
const base = Math.floor(10000000 + Math.random() * 89999999);
const last8 = (offset: number) => String(base + offset).slice(-8);
/** International form, e.g. +254712345678. */
const intl = (offset: number) => '+2547' + last8(offset);
/** The SAME number in local form, e.g. 0712345678 — used to prove the
 *  comparison runs through the shared normaliser rather than raw strings. */
const local = (offset: number) => '07' + last8(offset);

const PHONE_A = intl(0);
const PHONE_B = intl(1);
const PHONE_SUSPENDED = intl(2);

const CUST_A = `TEST-P7C3-CUS-A-${RUN}`;
const CUST_B = `TEST-P7C3-CUS-B-${RUN}`;
const CUST_SUSPENDED = `TEST-P7C3-CUS-SUSPENDED-${RUN}`;
const CUST_MISSING = `TEST-P7C3-CUS-MISSING-${RUN}`;

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_SUSPENDED = 's'.repeat(64);
const TOKEN_EXPIRED = 'e'.repeat(64);
const TOKEN_REVOKED = 'r'.repeat(64);
const TOKEN_MISSING_CUSTOMER = 'm'.repeat(64);
const TOKEN_GARBAGE = 'not-a-real-session-token';

const SESS_A = `TEST-P7C3-SESS-A-${RUN}`;
const SESS_SUSPENDED = `TEST-P7C3-SESS-SUSPENDED-${RUN}`;
const SESS_EXPIRED = `TEST-P7C3-SESS-EXPIRED-${RUN}`;
const SESS_REVOKED = `TEST-P7C3-SESS-REVOKED-${RUN}`;
const SESS_MISSING = `TEST-P7C3-SESS-MISSING-${RUN}`;

const AGENT = `TEST-P7C3-AGENT-${RUN}`;

// One dedicated claim per scenario: a claim link is one-shot (unique per
// claim) and the OTP challenge is single-use, so scenarios cannot share rows.
const SCENARIOS = [
  'MATCH',       // authenticated A, claim phone identical to A's
  'MATCHFMT',    // authenticated A, claim phone is the SAME number in 07… form
  'OTHER',       // authenticated A, claim phone belongs to B
  'ANON',        // no session at all
  'BADSESS',     // every invalid-session variant (none of them link)
  'BODY',        // valid A session + a forged body customer id
  'SELF',        // already legitimately linked to A
  'OTHERLINK',   // already linked to B (a different account)
  'FAIL',        // link primitive fails
  'HTTP',        // harness success path
  'HTTPMISS',    // harness phone-mismatch path
] as const;

const ITEM = (name: string) => `TEST-P7C3-ITEM-${name}-${RUN}`;
const CLAIM = (name: string) => `TEST-P7C3-CLAIM-${name}-${RUN}`;

const ITEM_OWNER_PHONE: Record<string, string> = {
  MATCH: PHONE_A,
  MATCHFMT: local(0),
  OTHER: PHONE_B,
  ANON: PHONE_A,
  BADSESS: PHONE_A,
  BODY: PHONE_A,
  SELF: PHONE_A,
  OTHERLINK: PHONE_A,
  FAIL: PHONE_A,
  HTTP: PHONE_A,
  HTTPMISS: PHONE_B,
};

// Deliberately distinctive secrets: the audit assertions below prove none of
// them can reach an audit row.
const SECRET_ANSWERS = { lastDigits: '9182', fullName: 'Journey Secret Name' };
const SECRET_ID_PROOF = `https://secret.example/journey-${RUN}.png`;
const SECRET_PAYMENT_REF = `REF-P7C3-SECRET-${RUN}`;
const SECRET_FINDER_PHONE = '+254799999001';
const SECRET_AGENT_TILL = 'TILL-P7C3-777';
const SECRET_OTP = '4471';

function itemRow(id: string) {
  return {
    id,
    category_id: 'national-id',
    photo_url: 'photo.jpg',
    ocr_extracted_number: 'OCR-P7C3-999',
    ocr_extracted_name: 'OCR P7C3 Name',
    document_number_hash: 'HASH-P7C3-SECRET',
    document_name_fuzzy: 'National ID',
    location_description: 'Nairobi CBD',
    latitude: null,
    longitude: null,
    finder_phone: SECRET_FINDER_PHONE,
    assigned_agent_id: AGENT,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: true,
    rejection_reason: null,
  } as any;
}

function claimRow(id: string, itemId: string, ownerPhone: string) {
  return {
    id,
    item_id: itemId,
    owner_phone: ownerPhone,
    security_answers: SECRET_ANSWERS,
    verification_tier: 1,
    status: 'pending_verification',
    owner_id_proof_url: SECRET_ID_PROOF,
    payment_reference: SECRET_PAYMENT_REF,
    owner_identifying_details: 'scar on left hand (P7C3)',
  } as any;
}

let server: any;
let baseUrl = '';

async function seed() {
  await db.createCustomer(CUST_A, 'Asha Mwangi', PHONE_A);
  await db.createCustomer(CUST_B, 'Brian Otieno', PHONE_B);
  await db.createCustomer(CUST_SUSPENDED, 'Suspended User', PHONE_SUSPENDED);
  await db.updateCustomerStatus(CUST_SUSPENDED, 'suspended');

  const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.createCustomerSession(SESS_A, CUST_A, hashCode(TOKEN_A), in7Days);
  await db.createCustomerSession(SESS_SUSPENDED, CUST_SUSPENDED, hashCode(TOKEN_SUSPENDED), in7Days);
  await db.createCustomerSession(SESS_EXPIRED, CUST_A, hashCode(TOKEN_EXPIRED), new Date(Date.now() - 1000));
  await db.createCustomerSession(SESS_REVOKED, CUST_A, hashCode(TOKEN_REVOKED), in7Days);
  await db.revokeCustomerSession(SESS_REVOKED);
  // Session row that outlives its account: the customer lookup must fail.
  await db.createCustomerSession(SESS_MISSING, CUST_MISSING, hashCode(TOKEN_MISSING_CUSTOMER), in7Days);

  await db.createAgent({
    id: AGENT,
    business_name: 'P7C3 Test Agent',
    contact_phone: '+254711111002',
    location_address: 'Moi Avenue, Nairobi',
    latitude: -1.28,
    longitude: 36.82,
    mpesa_till_or_paybill: SECRET_AGENT_TILL,
    national_id_hash: 'AGENT-ID-HASH-P7C3',
    refundable_deposit: '5000',
    warning_count: 0,
    last_warning_reason: null,
    id_document_photo_url: 'https://secret.example/agent-p7c3.png',
  } as any);

  await ensureTestCategory('national-id');

  for (const name of SCENARIOS) {
    await db.createItem(itemRow(ITEM(name)));
    await db.createClaim(claimRow(CLAIM(name), ITEM(name), ITEM_OWNER_PHONE[name]));
    // A live, unused challenge for every claim (the real journey always issues
    // one before verify-otp can succeed), so the single-use assertion below
    // operates on the same primitive the route uses.
    await db.setClaimOtp(CLAIM(name), hashCode(SECRET_OTP), new Date(Date.now() + 5 * 60 * 1000));
  }

  // SELF: the legitimate link already exists (idempotency scenario).
  await db.linkClaimToCustomer(`CCL-P7C3-SEED-SELF-${RUN}`, CUST_A, CLAIM('SELF'), 'claim_otp+security_answers');
  // OTHERLINK: the claim already belongs to a DIFFERENT account.
  await db.linkClaimToCustomer(`CCL-P7C3-SEED-OTHER-${RUN}`, CUST_B, CLAIM('OTHERLINK'), 'claim_otp+security_answers');
}

beforeAll(async () => {
  await seed();

  const app = express();
  app.use(express.json());

  // HARNESS ONLY. This route is not a copy of the claim-verification logic —
  // the claim is read straight from the fixture and no OTP/transition/state
  // logic is duplicated. It exists so the REAL resolveOptionalCustomer and the
  // REAL link helper can be driven over a real HTTP request with the same
  // additive glue server.ts uses. The server.ts wiring itself is covered by
  // the source audit at the bottom of this file.
  app.post('/harness/verify-otp/:id', async (req: any, res: any) => {
    const claim = await db.getClaim(String(req.params.id));
    if (!claim) return res.status(404).json({ error: 'claim not found' });
    let linked = false;
    try {
      const journeyCustomer = await resolveOptionalCustomer(req);
      if (journeyCustomer) {
        linked = (await linkVerifiedClaimToCustomer(journeyCustomer, claim)).linked;
      }
    } catch {
      linked = false;
    }
    return res.json({ success: true, linked });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function post(urlPath: string, token?: string, body?: any) {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = 'r4m_customer_session=' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + urlPath, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

async function verify(claimName: string, token?: string, body?: any) {
  return post(`/harness/verify-otp/${CLAIM(claimName)}`, token, body);
}

async function linkFor(claimName: string) {
  return db.getCustomerClaimLinkForClaim(CLAIM(claimName));
}

// ===========================================================================
// LAYER 1 — optional session resolution, over real HTTP against the real db.
// ===========================================================================
describe('F11 layer 1 — resolveOptionalCustomer (real HTTP, real sessions)', () => {
  it('1. no session at all is simply anonymous: the request still succeeds and nothing is linked', async () => {
    const res = await verify('ANON', undefined, { code: SECRET_OTP });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, linked: false });
    expect(await linkFor('ANON')).toBeUndefined();
    // The claim itself is untouched — anonymous verification stays valid.
    expect(await db.getClaim(CLAIM('ANON'))).toBeDefined();
  });

  it('2. a forged customer id (body + query) cannot select an account without a session', async () => {
    const res = await post(
      `/harness/verify-otp/${CLAIM('ANON')}?customer_id=${CUST_A}&id=${CUST_A}`,
      undefined,
      { code: SECRET_OTP, customer_id: CUST_A, customerId: CUST_A, id: CUST_A }
    );
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    expect(await linkFor('ANON')).toBeUndefined();
  });

  it('3. a valid session with a matching phone links the claim, linked_via = journey_verify_otp', async () => {
    const res = await verify('HTTP', TOKEN_A, { code: SECRET_OTP });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, linked: true });
    const link = await linkFor('HTTP');
    expect(link).toBeDefined();
    expect(link!.customer_id).toBe(CUST_A);
    expect(link!.linked_via).toBe(JOURNEY_CLAIM_LINK_VIA);
    expect(JOURNEY_CLAIM_LINK_VIA).toBe('journey_verify_otp');
  });

  it('4. a valid session with a DIFFERENT phone gets linked:false and no customer link', async () => {
    const res = await verify('HTTPMISS', TOKEN_A, { code: SECRET_OTP });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, linked: false });
    expect(await linkFor('HTTPMISS')).toBeUndefined();
  });

  it('5. a forged body customer id cannot override the session identity', async () => {
    const res = await verify('BODY', TOKEN_A, {
      code: SECRET_OTP,
      customer_id: CUST_B,
      customerId: CUST_B,
      id: CUST_B,
    });
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    const link = await linkFor('BODY');
    expect(link).toBeDefined();
    // The cookie won. The forged body/param value selected nothing.
    expect(link!.customer_id).toBe(CUST_A);
    expect(link!.customer_id).not.toBe(CUST_B);
  });

  it('6. invalid, expired, revoked, suspended and account-less sessions are all treated as anonymous', async () => {
    const variants: Array<[string, string]> = [
      ['garbage token', TOKEN_GARBAGE],
      ['valid token, deleted account', TOKEN_MISSING_CUSTOMER],
      ['expired session', TOKEN_EXPIRED],
      ['revoked session', TOKEN_REVOKED],
      ['suspended account', TOKEN_SUSPENDED],
    ];
    for (const [label, token] of variants) {
      const res = await verify('BADSESS', token, { code: SECRET_OTP });
      // 200, not 401/403: the optional lookup must not terminate the request.
      expect(res.status, label).toBe(200);
      expect(res.body, label).toMatchObject({ success: true, linked: false });
    }
    expect(await linkFor('BADSESS')).toBeUndefined();
  });

  it('7. the resolver never writes a response of its own (it returns null, it does not reject)', async () => {
    // If the resolver terminated the request we would see its 401/403 bodies.
    for (const token of [TOKEN_GARBAGE, TOKEN_EXPIRED, TOKEN_REVOKED, TOKEN_SUSPENDED]) {
      const res = await verify('BADSESS', token, { code: SECRET_OTP });
      expect(res.body.error).toBeUndefined();
      expect(res.body.success).toBe(true);
    }
    // A caller that only awaits the resolver also gets a value, not a rejection.
    const fakeReq: any = { headers: { cookie: 'r4m_customer_session=' + TOKEN_GARBAGE }, body: {}, query: {}, params: {} };
    await expect(resolveOptionalCustomer(fakeReq)).resolves.toBeNull();
  });
});

// ===========================================================================
// LAYER 2 — the link decision, against the real link primitive and real rows.
// ===========================================================================
describe('F11 layer 2 — linkVerifiedClaimToCustomer (real db + real link primitive)', () => {
  it('1. matching phone links through the existing primitive and records journey_verify_otp', async () => {
    const customer = await db.getCustomerById(CUST_A);
    const claim = await db.getClaim(CLAIM('MATCH'));
    const result = await linkVerifiedClaimToCustomer(customer, claim);
    expect(result).toEqual({ linked: true, outcome: 'linked' });

    const link = await linkFor('MATCH');
    expect(link).toBeDefined();
    expect(link!.customer_id).toBe(CUST_A);
    expect(link!.claim_id).toBe(CLAIM('MATCH'));
    expect(link!.linked_via).toBe('journey_verify_otp');
    expect(String(link!.id).startsWith('CCL-')).toBe(true);

    const audits = (await db.getAuditLogs()).filter(
      (l) => l.action === 'CUSTOMER_CLAIM_LINK' && l.details.includes(CLAIM('MATCH'))
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].admin_user).toBe('CUSTOMER');
    expect(audits[0].details).toContain(CUST_A);
  });

  it('2. the comparison uses the shared normaliser, not raw strings (07… == +2547…)', async () => {
    const customer = await db.getCustomerById(CUST_A);
    const claim = await db.getClaim(CLAIM('MATCHFMT'));
    // Different raw strings…
    expect(customer.phone).toBe(PHONE_A);
    expect(claim.owner_phone).toBe(local(0));
    expect(customer.phone).not.toBe(claim.owner_phone);
    // …same normalized number, so the link is created.
    const result = await linkVerifiedClaimToCustomer(customer, claim);
    expect(result).toEqual({ linked: true, outcome: 'linked' });
    expect((await linkFor('MATCHFMT'))!.customer_id).toBe(CUST_A);
  });

  it('3. a DIFFERENT phone never auto-links and never throws', async () => {
    const result = await linkVerifiedClaimToCustomer(
      await db.getCustomerById(CUST_A),
      await db.getClaim(CLAIM('OTHER'))
    );
    expect(result).toEqual({ linked: false, outcome: 'phone_mismatch' });
    expect(await linkFor('OTHER')).toBeUndefined();
    // The claim is NOT rejected or mutated — it still exists in its own state.
    expect((await db.getClaim(CLAIM('OTHER')))!.status).toBe('pending_verification');
  });

  it('7. an existing link to the SAME customer is idempotent: no duplicate, no re-point, no audit noise', async () => {
    const result = await linkVerifiedClaimToCustomer(
      await db.getCustomerById(CUST_A),
      await db.getClaim(CLAIM('SELF'))
    );
    expect(result).toEqual({ linked: true, outcome: 'already_linked_self' });
    const link = await linkFor('SELF');
    expect(link!.customer_id).toBe(CUST_A);
    expect(String(link!.id)).toBe(`CCL-P7C3-SEED-SELF-${RUN}`); // the original row, untouched
    expect(link!.linked_via).toBe('claim_otp+security_answers'); // not rewritten
    // No second row and no second link audit entry were written by the no-op
    // call (the only other entry mentioning this claim is its creation audit).
    const linkAudits = (await db.getAuditLogs()).filter(
      (l) =>
        (l.action === 'CUSTOMER_CLAIM_LINK' || l.action === 'CUSTOMER_CLAIM_LINK_FAILED') &&
        l.details.includes(CLAIM('SELF'))
    );
    expect(linkAudits).toHaveLength(0);
  });

  it('8. a link owned by ANOTHER account is never re-pointed (no ownership transfer)', async () => {
    const before = await linkFor('OTHERLINK');
    const result = await linkVerifiedClaimToCustomer(
      await db.getCustomerById(CUST_A),
      await db.getClaim(CLAIM('OTHERLINK'))
    );
    expect(result).toEqual({ linked: false, outcome: 'already_linked_other' });
    const after = await linkFor('OTHERLINK');
    expect(after!.customer_id).toBe(CUST_B);
    expect(after!.id).toBe(before!.id);
    expect(after!.linked_via).toBe('claim_otp+security_answers');
    // The refusal is recorded as a SYSTEM failure, never as a successful link.
    const failures = (await db.getAuditLogs()).filter(
      (l) => l.action === 'CUSTOMER_CLAIM_LINK_FAILED' && l.details.includes(CLAIM('OTHERLINK'))
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].admin_user).toBe('SYSTEM');
    expect(
      (await db.getAuditLogs()).filter(
        (l) => l.action === 'CUSTOMER_CLAIM_LINK' && l.details.includes(CLAIM('OTHERLINK'))
      )
    ).toHaveLength(0);
  });

  it('9. a failing link primitive is non-fatal: linked:false, failure audit, never a throw', async () => {
    const spy = vi
      .spyOn(db as any, 'linkClaimToCustomer')
      .mockRejectedValueOnce(new Error('injected linkage failure'));
    const result = await linkVerifiedClaimToCustomer(
      await db.getCustomerById(CUST_A),
      await db.getClaim(CLAIM('FAIL'))
    );
    expect(result).toEqual({ linked: false, outcome: 'error' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await linkFor('FAIL')).toBeUndefined();
    const failures = (await db.getAuditLogs()).filter(
      (l) => l.action === 'CUSTOMER_CLAIM_LINK_FAILED' && l.details.includes(CLAIM('FAIL'))
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].admin_user).toBe('SYSTEM');
  });

  it('10. single-use: the challenge is consumed before the hook, and the hook cannot double-link', async () => {
    // The route consumes the challenge BEFORE resolving the customer, so a
    // replayed OTP never reaches the hook (layer-3 ordering audit) and the
    // route's `!record` gate rejects the replay. Both halves are real:
    expect(await db.getClaimOtp(CLAIM('SELF'))).toBeDefined();
    await db.deleteClaimOtp(CLAIM('SELF'));
    expect(await db.getClaimOtp(CLAIM('SELF'))).toBeUndefined();
    // …and even a hypothetical second run of the hook is a no-op.
    const again = await linkVerifiedClaimToCustomer(
      await db.getCustomerById(CUST_A),
      await db.getClaim(CLAIM('SELF'))
    );
    expect(again).toEqual({ linked: true, outcome: 'already_linked_self' });
  });

  it('11. journey-link audit rows never carry phones, answers, OTPs or proof artefacts', async () => {
    const entries = (await db.getAuditLogs()).filter(
      (l) => l.action === 'CUSTOMER_CLAIM_LINK' || l.action === 'CUSTOMER_CLAIM_LINK_FAILED'
    );
    expect(entries.length).toBeGreaterThan(0);
    const forbidden = [
      PHONE_A,
      PHONE_B,
      local(0),
      SECRET_ANSWERS.lastDigits,
      SECRET_ANSWERS.fullName,
      SECRET_ID_PROOF,
      SECRET_PAYMENT_REF,
      SECRET_FINDER_PHONE,
      SECRET_AGENT_TILL,
      'scar on left hand',
      'code_hash',
      'token_hash',
    ];
    for (const entry of entries) {
      for (const secret of forbidden) {
        expect(entry.details).not.toContain(secret);
      }
    }
  });
});

// ===========================================================================
// LAYER 3 — server.ts wiring (source audit: server.ts is not importable).
//
// server.ts boots the whole application at import time, so these assertions
// are made against its source text — the same technique the rest of this
// suite uses for routes that live in it. They assert only WIRING (order,
// delegation, response shape, and that nothing was re-used incorrectly);
// every delegated behaviour is covered behaviourally above.
// ===========================================================================
const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
const authSource = fs.readFileSync(path.resolve(__dirname, '../services/customerAuth.ts'), 'utf8');

const verifyStart = serverSource.indexOf("'/api/claims/:id/verify-otp'");
const verifyEnd = serverSource.indexOf("'/api/claims/:id/payment-auth'", verifyStart);
const verifyRoute = serverSource.slice(verifyStart, verifyEnd);

const submitStart = serverSource.indexOf("'/api/claims/submit'");
const submitEnd = serverSource.indexOf('\n  app.', submitStart + 10);
const submitRoute = serverSource.slice(submitStart, submitEnd);

const resolverStart = authSource.indexOf('export async function resolveOptionalCustomer');
const resolverEnd = authSource.indexOf('\nexport ', resolverStart + 10);
const resolverBody = authSource.slice(resolverStart, resolverEnd);

const journeyStart = authSource.indexOf('export async function linkVerifiedClaimToCustomer');
const journeyBody = authSource.slice(journeyStart);

describe('F11 layer 3 — server.ts wiring (source audit)', () => {
  it('the route performs the additive link strictly AFTER the transition and the OTP consumption', () => {
    expect(verifyStart).toBeGreaterThan(-1);
    expect(verifyRoute.length).toBeGreaterThan(2000);
    const transitionIdx = verifyRoute.indexOf('await db.transitionClaimStatus(');
    const consumeIdx = verifyRoute.lastIndexOf('await db.deleteClaimOtp(claimId);');
    const resolveIdx = verifyRoute.indexOf('resolveOptionalCustomer(req)');
    const linkIdx = verifyRoute.indexOf('linkVerifiedClaimToCustomer(');
    expect(transitionIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeGreaterThan(-1);
    expect(transitionIdx).toBeLessThan(consumeIdx);
    expect(consumeIdx).toBeLessThan(resolveIdx);
    expect(resolveIdx).toBeLessThan(linkIdx);
  });

  it('the claim journey stays anonymous: verify-otp never requires customer auth', () => {
    expect(verifyRoute).not.toContain('requireCustomerAuth');
    expect(verifyRoute).toContain('resolveOptionalCustomer');
  });

  it('the additive block cannot respond, cannot fail the request, and defaults to linked:false', () => {
    const blockStart = verifyRoute.indexOf('F11 (Phase 7C.3)');
    const blockEnd = verifyRoute.indexOf('res.json(', blockStart);
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const block = verifyRoute.slice(blockStart, blockEnd);
    expect(block).not.toContain('res.status(');
    expect(block).not.toContain('res.json(');
    expect(block).toContain('try {');
    expect(block).toContain('catch');
    // Once as the default, once in the catch — an error can only downgrade to false.
    expect((block.match(/journeyLinked = false/g) || []).length).toBe(2);
  });

  it('the success response keeps its existing fields and adds only `linked`', () => {
    expect(verifyRoute).toContain('linked: journeyLinked');
    expect(verifyRoute).toContain('success: true,');
    expect(verifyRoute).toContain('Msimbo umethibitishwa kikamilifu!');
    expect(verifyRoute).not.toContain('customer_id');
  });

  it('/api/claims/submit is untouched: no session lookup, no link, no auth middleware', () => {
    expect(submitStart).toBeGreaterThan(-1);
    expect(submitRoute.length).toBeGreaterThan(5000);
    const forbidden = [
      'resolveOptionalCustomer',
      'linkVerifiedClaimToCustomer',
      'requireCustomerAuth',
      'linkClaimToCustomer',
      'customer_claim_links',
    ];
    for (const needle of forbidden) {
      expect(submitRoute).not.toContain(needle);
    }
    expect(submitRoute).toContain('db.createClaim');
    expect(submitRoute).toContain('db.createDispute');
  });
});

describe('F11 layer 3 — customerAuth.ts contract (source audit)', () => {
  it('the resolver reads identity only from the cookie and never responds', () => {
    expect(resolverBody.length).toBeGreaterThan(300);
    for (const forbidden of ['req.body', 'req.query', 'req.params', 'res.status', 'res.json', 'next(']) {
      expect(resolverBody).not.toContain(forbidden);
    }
    expect(resolverBody).toContain('readCookie(req, CUSTOMER_SESSION_COOKIE)');
    expect(resolverBody).toContain('getCustomerSessionByTokenHash(hashCode(');
    expect(resolverBody).toContain('session.revoked_at');
    expect(resolverBody).toContain('expires_at');
    expect(resolverBody).toContain("customer.status !== 'active'");
  });

  it('the journey helper reuses the single existing link primitive and builds no rows itself', () => {
    expect(journeyBody).toContain('db.linkClaimToCustomer(');
    expect(journeyBody).toContain("generateSecureId('CCL')");
    expect(journeyBody).toContain('JOURNEY_CLAIM_LINK_VIA');
    expect(journeyBody).toContain('toE164Kenyan(');
    expect(journeyBody).not.toContain('req.');
    expect(journeyBody).not.toContain('customerClaimLinksTable');
    expect(journeyBody).not.toContain('.insert(');
    expect(journeyBody).not.toContain('.update(');
    expect(journeyBody).not.toContain('.delete(');
    expect(authSource).toContain("export const JOURNEY_CLAIM_LINK_VIA = 'journey_verify_otp';");
  });

  it('no bulk / phone-based automatic linking API was introduced anywhere', () => {
    const databaseSource = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');
    const forbidden = [
      'linkClaimToCustomerByPhone',
      'linkAllCustomerClaims',
      'linkClaimsForCustomer',
      'autoLinkClaims',
    ];
    for (const needle of forbidden) {
      expect(authSource).not.toContain(needle);
      expect(databaseSource).not.toContain(needle);
      expect(serverSource).not.toContain(needle);
    }
  });

  it('the schema and the explicit manual link routes are untouched by this change', () => {
    const routesSource = fs.readFileSync(path.resolve(__dirname, '../routes/customerClaims.ts'), 'utf8');
    expect(routesSource).not.toContain('journey_verify_otp');
    expect(routesSource).toContain("'claim_otp+security_answers'");
    const schemaSource = fs.readFileSync(path.resolve(__dirname, '../db/schema.ts'), 'utf8');
    expect(schemaSource).not.toContain('journey_verify_otp');
  });

  it('the customer claims module exposes no second linking path', () => {
    // The manual flow is the only other caller of the primitive, and it must
    // keep its own proof requirements untouched.
    const routesSource = fs.readFileSync(path.resolve(__dirname, '../routes/customerClaims.ts'), 'utf8');
    expect(routesSource).toContain('db.linkClaimToCustomer(');
    expect(routesSource).toContain('requireCustomerAuth');
    expect(routesSource).toContain('compareVerificationAnswers(');
  });
});




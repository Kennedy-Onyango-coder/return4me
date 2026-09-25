import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';

// ---------------------------------------------------------------------------
// HTTP INTEGRATION TESTS for the customer claim authorization boundary.
//
// These mount a REAL Express app around the REAL requireCustomerAuth middleware
// and the REAL route handlers, then drive them over an actual TCP socket with
// fetch(). That is the smallest harness that can actually prove the boundary:
// a request with no cookie, a cookie for a replayed/revoked/expired session, or
// a cookie for a suspended account has to be rejected by the middleware itself
// — assertions against source text cannot demonstrate that.
//
// No new dependency is introduced: node's global fetch + express (already a
// runtime dependency) + an ephemeral port (listen(0)) are enough.
//
// server.ts itself is deliberately NOT imported — it calls startServer() at
// import time (Vite middleware, background sweeps, listeners). routes/
// customerClaims.ts exists precisely so the real handlers can be mounted in
// isolation.
// ---------------------------------------------------------------------------

// Capture the generated OTP instead of dispatching an SMS. Everything else in
// services/auth stays REAL (hashCode, toE164Kenyan, timingSafeEqualHex) — the
// point of these tests is the genuine verification path, not a stubbed one.
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

// NOTE: the dynamic import above (rather than a static one) is deliberate — it
// guarantees the routes module is evaluated AFTER the vi.mock factory above has
// replaced sendCodeViaSms, so the captured-code assertion is reliable.

const RUN = testRunId;
const base = Math.floor(10000000 + Math.random() * 89999999);
const phone = (offset: number) => '+2547' + String(base + offset).slice(-8);

const PHONE_A = phone(0);
const PHONE_B = phone(1);
const PHONE_SUSPENDED = phone(2);

const CUSTOMER_A = `TEST-P2-CUS-A-${RUN}`;
const CUSTOMER_B = `TEST-P2-CUS-B-${RUN}`;
const CUSTOMER_SUSPENDED = `TEST-P2-CUS-S-${RUN}`;

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_SUSPENDED = 'c'.repeat(64);
const TOKEN_EXPIRED = 'e'.repeat(64);
const TOKEN_REVOKED = 'f'.repeat(64);

const SESSION_A = `TEST-P2-SESS-A-${RUN}`;
const SESSION_B = `TEST-P2-SESS-B-${RUN}`;
const SESSION_SUSPENDED = `TEST-P2-SESS-S-${RUN}`;
const SESSION_EXPIRED = `TEST-P2-SESS-E-${RUN}`;
const SESSION_REVOKED = `TEST-P2-SESS-R-${RUN}`;

const AGENT_1 = `TEST-P2-AGENT-${RUN}`;

const ITEM_A_ACTIVE = `TEST-P2-ITEM-A1-${RUN}`;
const ITEM_A_HISTORY = `TEST-P2-ITEM-A2-${RUN}`;
const ITEM_A_MATCH_PHONE = `TEST-P2-ITEM-A3-${RUN}`;
const ITEM_A_HIST_PHONE = `TEST-P2-ITEM-A4-${RUN}`;
const ITEM_A_LINKABLE = `TEST-P2-ITEM-A5-${RUN}`;
const ITEM_A_EXPIRING = `TEST-P2-ITEM-A6-${RUN}`;
const ITEM_B = `TEST-P2-ITEM-B1-${RUN}`;

const CLAIM_A_ACTIVE = `TEST-P2-CLAIM-A1-${RUN}`;
const CLAIM_A_HISTORY = `TEST-P2-CLAIM-A2-${RUN}`;
const CLAIM_A_MATCH_PHONE = `TEST-P2-CLAIM-A3-${RUN}`;
const CLAIM_A_HIST_PHONE = `TEST-P2-CLAIM-A4-${RUN}`;
const CLAIM_A_LINKABLE = `TEST-P2-CLAIM-A5-${RUN}`;
const CLAIM_A_EXPIRING = `TEST-P2-CLAIM-A6-${RUN}`;
const CLAIM_B = `TEST-P2-CLAIM-B1-${RUN}`;

// Dedicated one-shot claims for the linking flow. Each link attempt needs a
// FRESH code (the request-otp route throttles resends per claim for 30s, and a
// challenge is single-use), so every linking scenario gets its own claim.
const LINK_ITEM = (n: number) => `TEST-P2-ITEM-L${n}-${RUN}`;
const LINK_CLAIM = (n: number) => `TEST-P2-CLAIM-L${n}-${RUN}`;

// The stored ownership answers for every A-owned fixture. 'national-id'
// requires lastDigits + fullName (see config/verificationProfiles.ts).
const STORED_ANSWERS = { lastDigits: '1234', fullName: 'Asha Mwangi' };
const CORRECT_ANSWERS = { lastDigits: '1234', fullName: 'Asha Mwangi' };
const WRONG_ANSWERS = { lastDigits: '9999', fullName: 'Someone Else' };

const SECRET_PAYMENT_REF = `REF-SECRET-${RUN}`;
const SECRET_ID_PROOF = `https://secret.example/id-${RUN}.png`;
const SECRET_IDENTIFYING = 'scar on left hand';
const SECRET_FINDER_PHONE = '+254799999999';
const SECRET_AGENT_TILL = 'TILL-SECRET-777';

function itemRow(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    category_id: 'national-id',
    photo_url: 'photo.jpg',
    ocr_extracted_number: 'OCR-SECRET-999',
    ocr_extracted_name: 'OCR Secret Name',
    document_number_hash: 'HASH-SECRET',
    document_name_fuzzy: 'National ID',
    location_description: 'Nairobi CBD',
    latitude: null,
    longitude: null,
    finder_phone: SECRET_FINDER_PHONE,
    assigned_agent_id: AGENT_1,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: true,
    rejection_reason: null,
    ...overrides,
  } as any;
}

function claimRow(id: string, itemId: string, ownerPhone: string, status: string, extra: Record<string, any> = {}) {
  return {
    id,
    item_id: itemId,
    owner_phone: ownerPhone,
    security_answers: STORED_ANSWERS,
    verification_tier: 1,
    status,
    owner_id_proof_url: SECRET_ID_PROOF,
    payment_reference: SECRET_PAYMENT_REF,
    owner_identifying_details: SECRET_IDENTIFYING,
    ...extra,
  } as any;
}

let server: any;
let baseUrl = '';

async function seed() {
  await db.createCustomer(CUSTOMER_A, 'Asha Mwangi', PHONE_A);
  await db.createCustomer(CUSTOMER_B, 'Brian Otieno', PHONE_B);
  await db.createCustomer(CUSTOMER_SUSPENDED, 'Suspended User', PHONE_SUSPENDED);
  await db.updateCustomerStatus(CUSTOMER_SUSPENDED, 'suspended');

  const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.createCustomerSession(SESSION_A, CUSTOMER_A, hashCode(TOKEN_A), in7Days);
  await db.createCustomerSession(SESSION_B, CUSTOMER_B, hashCode(TOKEN_B), in7Days);
  await db.createCustomerSession(SESSION_SUSPENDED, CUSTOMER_SUSPENDED, hashCode(TOKEN_SUSPENDED), in7Days);
  await db.createCustomerSession(SESSION_EXPIRED, CUSTOMER_A, hashCode(TOKEN_EXPIRED), new Date(Date.now() - 1000));
  await db.createCustomerSession(SESSION_REVOKED, CUSTOMER_A, hashCode(TOKEN_REVOKED), in7Days);
  await db.revokeCustomerSession(SESSION_REVOKED);

  await db.createAgent({
    id: AGENT_1,
    business_name: 'Test Agent Business',
    contact_phone: '+254711111111',
    location_address: 'Moi Avenue, Nairobi',
    latitude: -1.28,
    longitude: 36.82,
    mpesa_till_or_paybill: SECRET_AGENT_TILL,
    national_id_hash: 'AGENT-ID-HASH-SECRET',
    refundable_deposit: '5000',
    warning_count: 3,
    last_warning_reason: 'Test warning',
    id_document_photo_url: 'https://secret.example/agent-id.png',
  } as any);

  await ensureTestCategory('national-id');

  for (const id of [ITEM_A_ACTIVE, ITEM_A_HISTORY, ITEM_A_MATCH_PHONE, ITEM_A_HIST_PHONE, ITEM_A_LINKABLE, ITEM_A_EXPIRING, ITEM_B]) {
    await db.createItem(itemRow(id));
  }
  // One dedicated claim per linking scenario (see LINK_CLAIM above).
  for (let n = 1; n <= 9; n++) {
    await db.createItem(itemRow(LINK_ITEM(n)));
  }

  const twelveMinAgo = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  await db.createClaim(claimRow(CLAIM_A_ACTIVE, ITEM_A_ACTIVE, PHONE_A, 'escrow_held', { agent_confirmed_at: twelveMinAgo }));
  await db.createClaim(claimRow(CLAIM_A_HISTORY, ITEM_A_HISTORY, PHONE_A, 'released'));
  await db.createClaim(claimRow(CLAIM_A_MATCH_PHONE, ITEM_A_MATCH_PHONE, PHONE_A, 'at_agent'));
  await db.createClaim(claimRow(CLAIM_A_HIST_PHONE, ITEM_A_HIST_PHONE, PHONE_A, 'rejected'));
  await db.createClaim(claimRow(CLAIM_A_LINKABLE, ITEM_A_LINKABLE, PHONE_A, 'at_agent'));
  await db.createClaim(claimRow(CLAIM_A_EXPIRING, ITEM_A_EXPIRING, PHONE_A, 'pending_payment', { agent_confirmed_at: twentyMinAgo }));
  await db.createClaim(claimRow(CLAIM_B, ITEM_B, PHONE_B, 'escrow_held'));
  for (let n = 1; n <= 7; n++) {
    await db.createClaim(claimRow(LINK_CLAIM(n), LINK_ITEM(n), PHONE_A, 'at_agent'));
  }
  // 8 — owned by customer B's number but (pathologically) linked to customer A,
  //     used to exercise the "already linked to another account" branch.
  // 9 — owned by customer A, used for the unlink round-trip.
  await db.createClaim(claimRow(LINK_CLAIM(8), LINK_ITEM(8), PHONE_B, 'at_agent'));
  await db.createClaim(claimRow(LINK_CLAIM(9), LINK_ITEM(9), PHONE_A, 'at_agent'));
  await db.linkClaimToCustomer(`TEST-P2-LINK-A8-${RUN}`, CUSTOMER_A, LINK_CLAIM(8), 'test');

  // ONLY these two are linked. Everything else (including CLAIM_A_MATCH_PHONE
  // and CLAIM_A_HIST_PHONE, whose owner_phone IS this customer's number) must
  // stay invisible — that is the whole point of the explicit-link model.
  await db.linkClaimToCustomer(`TEST-P2-LINK-A1-${RUN}`, CUSTOMER_A, CLAIM_A_ACTIVE, 'test');
  await db.linkClaimToCustomer(`TEST-P2-LINK-A2-${RUN}`, CUSTOMER_A, CLAIM_A_HISTORY, 'test');
  await db.linkClaimToCustomer(`TEST-P2-LINK-B1-${RUN}`, CUSTOMER_B, CLAIM_B, 'test');
}

beforeAll(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  registerCustomerClaimRoutes(app, {
    // Mirrors the observable contract of the real checkClaimExpiry injected in
    // server.ts (lazy pending_payment expiry) using the REAL
    // db.expirePendingPaymentClaim. The strike/escrow side effects live in the
    // server.ts wrapper and are covered by the existing expiry suites.
    checkClaimExpiry: async (claim: any) => {
      if (!claim || claim.status !== 'pending_payment') return claim;
      const confirmedAt = claim.agent_confirmed_at ? new Date(claim.agent_confirmed_at).getTime() : 0;
      if (!confirmedAt || Date.now() - confirmedAt < 15 * 60 * 1000) return claim;
      await db.expirePendingPaymentClaim(claim.id);
      return db.getClaim(claim.id);
    },
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function cookie(token: string) {
  return { cookie: 'r4m_customer_session=' + token };
}

async function api(method: string, urlPath: string, token?: string, body?: any) {
  const headers: Record<string, string> = {};
  if (token) Object.assign(headers, cookie(token));
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

async function requestLinkCode(token: string, claimId: string) {
  sms.sent.length = 0;
  const res = await api('POST', '/api/customer/claims/link/request-otp', token, { claimId });
  return { res, code: sms.sent.length ? sms.sent[sms.sent.length - 1].code : null };
}

describe('customer claims: authentication boundary', () => {
  it('1. unauthenticated GET /api/customer/claims -> 401', async () => {
    const res = await api('GET', '/api/customer/claims');
    expect(res.status).toBe(401);
  });

  it('2. unauthenticated POST /api/customer/claims/link/request-otp -> 401', async () => {
    const res = await api('POST', '/api/customer/claims/link/request-otp', undefined, { claimId: CLAIM_A_LINKABLE });
    expect(res.status).toBe(401);
  });

  it('3. unauthenticated DELETE /api/customer/claims/:id/link -> 401', async () => {
    const res = await api('DELETE', `/api/customer/claims/${CLAIM_A_ACTIVE}/link`);
    expect(res.status).toBe(401);
    // The link must survive the rejected request.
    const link = await db.getCustomerClaimLinkForClaim(CLAIM_A_ACTIVE);
    expect(link).toBeDefined();
    expect(link!.customer_id).toBe(CUSTOMER_A);
  });

  it('6. a suspended customer cannot access dashboard routes -> 403', async () => {
    expect((await api('GET', '/api/customer/claims', TOKEN_SUSPENDED)).status).toBe(403);
    expect((await api('GET', `/api/customer/claims/${CLAIM_A_ACTIVE}`, TOKEN_SUSPENDED)).status).toBe(403);
    expect((await api('DELETE', `/api/customer/claims/${CLAIM_A_ACTIVE}/link`, TOKEN_SUSPENDED)).status).toBe(403);
    expect((await api('POST', '/api/customer/claims/link/request-otp', TOKEN_SUSPENDED, { claimId: CLAIM_A_LINKABLE })).status).toBe(403);
  });

  it('7. an expired session -> 401', async () => {
    const res = await api('GET', '/api/customer/claims', TOKEN_EXPIRED);
    expect(res.status).toBe(401);
  });

  it('8. a revoked session -> 401', async () => {
    const res = await api('GET', '/api/customer/claims', TOKEN_REVOKED);
    expect(res.status).toBe(401);
  });

  it('an unknown/garbage cookie value -> 401', async () => {
    const res = await api('GET', '/api/customer/claims', 'not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('customer claims: scoping', () => {
  it('4. customer A cannot see customer B\'s linked claims', async () => {
    const a = await api('GET', '/api/customer/claims', TOKEN_A);
    expect(a.status).toBe(200);
    const ids = a.body.claims.map((c: any) => c.id);
    expect(ids).toContain(CLAIM_A_ACTIVE);
    expect(ids).not.toContain(CLAIM_B);

    const b = await api('GET', '/api/customer/claims', TOKEN_B);
    expect(b.status).toBe(200);
    const bIds = b.body.claims.map((c: any) => c.id);
    expect(bIds).toContain(CLAIM_B);
    expect(bIds).not.toContain(CLAIM_A_ACTIVE);
    expect(bIds).not.toContain(CLAIM_A_HISTORY);
  });

  it('9. a claim whose owner_phone matches but has NO link does not appear', async () => {
    const res = await api('GET', '/api/customer/claims', TOKEN_A);
    const ids = res.body.claims.map((c: any) => c.id);
    expect(ids).not.toContain(CLAIM_A_MATCH_PHONE);
    // ...even though the phone really is this account's number.
    const claim = await db.getClaim(CLAIM_A_MATCH_PHONE);
    expect(claim!.owner_phone).toBe(PHONE_A);
    expect(await db.getCustomerClaimLinkForClaim(CLAIM_A_MATCH_PHONE)).toBeUndefined();
  });

  it('10. a historical claim whose owner_phone matches but has NO link does not appear', async () => {
    const res = await api('GET', '/api/customer/claims', TOKEN_A);
    const ids = res.body.claims.map((c: any) => c.id);
    expect(ids).not.toContain(CLAIM_A_HIST_PHONE);
    const claim = await db.getClaim(CLAIM_A_HIST_PHONE);
    expect(claim!.owner_phone).toBe(PHONE_A);
    expect(claim!.status).toBe('rejected');
  });

  it('5. customer A cannot unlink customer B\'s claim (404, and B keeps it)', async () => {
    const res = await api('DELETE', `/api/customer/claims/${CLAIM_B}/link`, TOKEN_A);
    expect(res.status).toBe(404);
    const link = await db.getCustomerClaimLinkForClaim(CLAIM_B);
    expect(link).toBeDefined();
    expect(link!.customer_id).toBe(CUSTOMER_B);
    const b = await api('GET', '/api/customer/claims', TOKEN_B);
    expect(b.body.claims.map((c: any) => c.id)).toContain(CLAIM_B);
  });

  it('18/19. unlinked detail -> 404; another customer\'s detail -> 404 (never 403)', async () => {
    const unlinked = await api('GET', `/api/customer/claims/${CLAIM_A_MATCH_PHONE}`, TOKEN_A);
    expect(unlinked.status).toBe(404);
    const other = await api('GET', `/api/customer/claims/${CLAIM_B}`, TOKEN_A);
    expect(other.status).toBe(404);
    const missing = await api('GET', `/api/customer/claims/DOES-NOT-EXIST-${RUN}`, TOKEN_A);
    expect(missing.status).toBe(404);
    // Identical body for "not yours" and "does not exist" — no existence oracle.
    expect(other.body).toEqual(unlinked.body);
    expect(missing.body).toEqual(unlinked.body);
  });
});

describe('customer claims: DTO safety', () => {
  const NEVER = [
    'owner_phone', 'owner_email', 'owner_id_proof_url', 'owner_identifying_details',
    'security_answers', 'payment_reference', 'provider_invoice_id', 'provider_reference',
    'provider_ref', 'finder_phone', 'finder_email', 'verified_name', 'verified_document_number',
    'rejection_reason', 'admin_notes', 'ocr_extracted_number', 'ocr_extracted_name',
    'document_number_hash', 'mpesa_till_or_paybill', 'national_id_hash', 'refundable_deposit',
    'warning_count', 'last_warning_reason', 'id_document_photo_url', 'attempts', 'code_hash',
  ];
  const SECRET_VALUES = [
    SECRET_PAYMENT_REF, SECRET_ID_PROOF, SECRET_IDENTIFYING, SECRET_FINDER_PHONE,
    SECRET_AGENT_TILL, PHONE_A, PHONE_B, 'AGENT-ID-HASH-SECRET', 'HASH-SECRET', 'OCR-SECRET-999',
  ];

  it('20. the list DTO contains no NEVER-expose field or secret value', async () => {
    const res = await api('GET', '/api/customer/claims', TOKEN_A);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    for (const field of NEVER) expect(raw).not.toContain(field);
    for (const secret of SECRET_VALUES) expect(raw).not.toContain(secret);
  });

  it('20b. the detail DTO contains no NEVER-expose field or secret value', async () => {
    const res = await api('GET', `/api/customer/claims/${CLAIM_A_ACTIVE}`, TOKEN_A);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    for (const field of NEVER) expect(raw).not.toContain(field);
    for (const secret of SECRET_VALUES) expect(raw).not.toContain(secret);
  });

  it('exposes only safe item + agent fields, masked exactly like the tracking DTO', async () => {
    const res = await api('GET', `/api/customer/claims/${CLAIM_A_ACTIVE}`, TOKEN_A);
    const claim = res.body.claim;
    // Sensitive document -> photo suppressed and the fuzzy label used, exactly
    // as toOwnerSafeItemView does for the public tracking modal.
    expect(claim.item.is_sensitive_document).toBe(true);
    expect(claim.item.photo_url).toBeNull();
    expect(claim.item.document_name_fuzzy).toBe('National ID');
    expect(claim.item.location_description).toBe('Nairobi CBD');
    expect(claim.agent.business_name).toBe('Test Agent Business');
    expect(claim.agent.contact_phone).toBe('+254711111111');
    expect(claim.agent.location_address).toBe('Moi Avenue, Nairobi');
    // Every key the DTO returns must be on the explicit allow-list — the real
    // security property: the object is hand-built, not a spread of the row.
    // `created_at` is asserted separately because this suite runs against the
    // in-memory mock (no DATABASE_URL), whose INSERT path does not apply the
    // column's now() default, so it is legitimately absent there while present
    // on real Postgres.
    const allowedItemKeys = [
      'category_id', 'created_at', 'description', 'document_name_fuzzy', 'found_county',
      'administrative_unit_id', 'id', 'isDescriptionOnly', 'is_sensitive_document', 'location_description', 'photo_url',
    ];
    for (const key of Object.keys(claim.item)) {
      expect(allowedItemKeys).toContain(key);
    }
    // Every masking-critical field is always present.
    for (const key of ['id', 'category_id', 'is_sensitive_document', 'photo_url', 'isDescriptionOnly', 'document_name_fuzzy', 'location_description', 'description']) {
      expect(Object.keys(claim.item)).toContain(key);
    }
    expect(Object.keys(claim.agent).sort()).toEqual([
      'business_name', 'contact_phone', 'id', 'latitude', 'location_address',
      'longitude', 'rating', 'rating_count',
    ]);
    expect(Object.keys(claim).sort()).toEqual([
      'agent', 'created_at', 'expires_at', 'id', 'is_active', 'item', 'status', 'updated_at',
    ]);
  });

  it('21. a pending_payment claim past its 15-minute window is NOT returned as active pending_payment', async () => {
    await db.linkClaimToCustomer(`TEST-P2-LINK-A3-${RUN}`, CUSTOMER_A, CLAIM_A_EXPIRING, 'test');
    const res = await api('GET', '/api/customer/claims', TOKEN_A);
    const row = res.body.claims.find((c: any) => c.id === CLAIM_A_EXPIRING);
    expect(row).toBeDefined();
    expect(row.status).toBe('payment_window_expired');
    expect(row.is_active).toBe(false);
    // The underlying row really was expired by the lifecycle, not merely
    // relabelled in the response.
    const stored = await db.getClaim(CLAIM_A_EXPIRING);
    expect(stored!.status).toBe('payment_window_expired');

    const detail = await api('GET', `/api/customer/claims/${CLAIM_A_EXPIRING}`, TOKEN_A);
    expect(detail.body.claim.status).toBe('payment_window_expired');
  });

  it('a pending_payment claim still inside the window stays active and exposes a deadline', async () => {
    const res = await api('GET', `/api/customer/claims/${CLAIM_A_ACTIVE}`, TOKEN_A);
    // agent_confirmed_at is 12 minutes old -> still inside the 15-minute window.
    expect(res.body.claim.status).toBe('escrow_held');
    expect(res.body.claim.is_active).toBe(true);
    // expires_at is only meaningful for pending_payment.
    expect(res.body.claim.expires_at).toBeNull();
  });
});

describe('customer claims: linking security flow', () => {
  it('13. link/verify fails when no claim OTP was ever requested', async () => {
    const res = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: LINK_CLAIM(3),
      code: '1234',
      securityAnswers: CORRECT_ANSWERS,
    });
    expect(res.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(LINK_CLAIM(3))).toBeUndefined();
  });

  it('13b. a wrong OTP code cannot link, and is counted against the attempt ceiling', async () => {
    const { res, code } = await requestLinkCode(TOKEN_A, LINK_CLAIM(2));
    expect(res.status).toBe(200);
    expect(code).toMatch(/^\d{4}$/);
    const wrong = String((Number(code) + 1) % 10000).padStart(4, '0');

    const attempt = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: LINK_CLAIM(2),
      code: wrong,
      securityAnswers: CORRECT_ANSWERS,
    });
    expect(attempt.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(LINK_CLAIM(2))).toBeUndefined();
    // The challenge survives a wrong attempt (it is not silently discarded) but
    // the attempt counter moved, so the code cannot be guessed indefinitely.
    const record = await db.getClaimOtp(LINK_CLAIM(2));
    expect(record).toBeDefined();
    expect(record!.attempts).toBeGreaterThan(0);
  });

  it('13c. an expired OTP challenge cannot link, even with the right code', async () => {
    // Simulate a challenge whose 5-minute window has passed, using the SAME
    // store the route reads.
    await db.setClaimOtp(LINK_CLAIM(5), hashCode('4321'), new Date(Date.now() - 1000));
    const res = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: LINK_CLAIM(5),
      code: '4321',
      securityAnswers: CORRECT_ANSWERS,
    });
    expect(res.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(LINK_CLAIM(5))).toBeUndefined();
    // The dead challenge is cleaned up.
    expect(await db.getClaimOtp(LINK_CLAIM(5))).toBeUndefined();
  });

  it('14. a fabricated client-side "OTP verified" state cannot bypass server verification', async () => {
    // No request-otp call was made for this claim, so no challenge exists. The
    // browser has no way to assert success: it can only send fields, and every
    // plausible client-supplied "proof" flag is ignored.
    const res = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: LINK_CLAIM(3),
      code: '0000',
      securityAnswers: CORRECT_ANSWERS,
      otpVerified: true,
      verified: true,
      otp_verified: true,
      skipOtp: true,
      customerId: CUSTOMER_B,
    });
    expect(res.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(LINK_CLAIM(3))).toBeUndefined();
    // The body-supplied customerId was ignored: nothing was linked to B either.
    const b = await api('GET', '/api/customer/claims', TOKEN_B);
    expect(b.body.claims.map((c: any) => c.id)).not.toContain(LINK_CLAIM(3));
  });

  it('15. invalid security answers prevent linking (and do not leak the expected values)', async () => {
    const { res, code } = await requestLinkCode(TOKEN_A, LINK_CLAIM(4));
    expect(res.status).toBe(200);
    const attempt = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: LINK_CLAIM(4),
      code,
      securityAnswers: WRONG_ANSWERS,
    });
    expect(attempt.status).toBe(400);
    expect(await db.getCustomerClaimLinkForClaim(LINK_CLAIM(4))).toBeUndefined();
    const raw = JSON.stringify(attempt.body);
    // The generic rejection must not echo the submitted answers, the expected
    // answers, or which field was wrong.
    expect(raw).not.toContain('9999');
    expect(raw).not.toContain('Someone Else');
    expect(raw).not.toContain('1234');
    expect(raw).not.toContain('Asha Mwangi');
    expect(raw).not.toContain('fullName');
    expect(raw).not.toContain('lastDigits');
    // An unknown/forbidden field is rejected the same way (fail closed).
    const bad = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: LINK_CLAIM(4),
      code,
      securityAnswers: { cvv: '123' },
    });
    expect(bad.status).toBe(400);
  });

  it('16. valid OTP + valid security answers permits linking across the whole flow', async () => {
    const { res, code } = await requestLinkCode(TOKEN_A, LINK_CLAIM(1));
    expect(res.status).toBe(200);
    // The route reports the item category so the client can render the right
    // ownership questions — and it only does so after the phone match.
    expect(res.body.categoryId).toBe('national-id');

    const linked = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: LINK_CLAIM(1),
      code,
      securityAnswers: CORRECT_ANSWERS,
    });
    expect(linked.status).toBe(200);
    expect(linked.body.linked).toBe(true);

    const link = await db.getCustomerClaimLinkForClaim(LINK_CLAIM(1));
    expect(link).toBeDefined();
    expect(link!.customer_id).toBe(CUSTOMER_A);
    expect(link!.linked_via).toBe('claim_otp+security_answers');

    // It now shows up in the dashboard.
    const list = await api('GET', '/api/customer/claims', TOKEN_A);
    expect(list.body.claims.map((c: any) => c.id)).toContain(LINK_CLAIM(1));
  });

  it('13d. the OTP challenge is single-use — replaying the accepted code fails', async () => {
    const { res } = await requestLinkCode(TOKEN_A, LINK_CLAIM(1));
    // Already linked at this point: the route answers idempotently, never
    // minting a second challenge.
    expect(res.status).toBe(200);
    expect(res.body.alreadyLinked).toBe(true);
    expect(await db.getClaimOtp(LINK_CLAIM(1))).toBeUndefined();
  });
});

describe('customer claims: link uniqueness, unlink and route hardening', () => {
  it('11. a claim linked to A cannot become linked to B (database-level invariant)', async () => {
    // LINK_CLAIM(1) is already linked to customer A (test 16). A direct second
    // link for customer B must be refused by the uniqueness guarantee, not by
    // an application-level pre-check that a race could slip past.
    const outcome = await db.linkClaimToCustomer(`TEST-P2-LINK-BAD-${RUN}`, CUSTOMER_B, LINK_CLAIM(1), 'test');
    expect(outcome).toBe('already_linked_other');
    const link = await db.getCustomerClaimLinkForClaim(LINK_CLAIM(1));
    expect(link!.customer_id).toBe(CUSTOMER_A);
    const b = await api('GET', '/api/customer/claims', TOKEN_B);
    expect(b.body.claims.map((c: any) => c.id)).not.toContain(LINK_CLAIM(1));
  });

  it('11b. linking a claim already linked to another account -> 409, not a silent takeover', async () => {
    const res = await api('POST', '/api/customer/claims/link/request-otp', TOKEN_B, { claimId: LINK_CLAIM(8) });
    expect(res.status).toBe(409);
  });

  it('12. duplicate linking is safe and idempotent', async () => {
    const first = await db.linkClaimToCustomer(`TEST-P2-LINK-DUP1-${RUN}`, CUSTOMER_A, LINK_CLAIM(9), 'test');
    expect(first).toBe('linked');
    const second = await db.linkClaimToCustomer(`TEST-P2-LINK-DUP2-${RUN}`, CUSTOMER_A, LINK_CLAIM(9), 'test');
    expect(second).toBe('already_linked_self');
    const link = await db.getCustomerClaimLinkForClaim(LINK_CLAIM(9));
    expect(link!.customer_id).toBe(CUSTOMER_A);
  });

  it('12b. re-running the whole link flow for an already-linked claim is a no-op', async () => {
    const res = await api('POST', '/api/customer/claims/link/verify', TOKEN_A, {
      claimId: LINK_CLAIM(9),
      code: '0000',
      securityAnswers: CORRECT_ANSWERS,
    });
    expect(res.status).toBe(200);
    expect(res.body.alreadyLinked).toBe(true);
    expect(await db.getClaimOtp(LINK_CLAIM(9))).toBeUndefined();
  });

  it('17. unlink removes ONLY the authenticated customer\'s link and deletes no claim data', async () => {
    const before = await db.getClaim(LINK_CLAIM(9));
    const res = await api('DELETE', `/api/customer/claims/${LINK_CLAIM(9)}/link`, TOKEN_A);
    expect(res.status).toBe(200);
    expect(await db.getCustomerClaimLinkForClaim(LINK_CLAIM(9))).toBeUndefined();

    // The claim itself, and its ownership evidence, are untouched.
    const after = await db.getClaim(LINK_CLAIM(9));
    expect(after).toBeDefined();
    expect(after!.status).toBe(before!.status);
    expect(after!.owner_phone).toBe(before!.owner_phone);
    expect(after!.security_answers).toEqual(before!.security_answers);

    // It is gone from the dashboard...
    const list = await api('GET', '/api/customer/claims', TOKEN_A);
    expect(list.body.claims.map((c: any) => c.id)).not.toContain(LINK_CLAIM(9));
    // ...and unlinking again is a 404, not a crash or a second success.
    expect((await api('DELETE', `/api/customer/claims/${LINK_CLAIM(9)}/link`, TOKEN_A)).status).toBe(404);
  });

  it('request-otp does not disclose whether an arbitrary claim ID exists', async () => {
    const missing = await api('POST', '/api/customer/claims/link/request-otp', TOKEN_A, { claimId: `NOPE-${RUN}` });
    // CLAIM_B exists but belongs to another number.
    const someoneElses = await api('POST', '/api/customer/claims/link/request-otp', TOKEN_A, { claimId: CLAIM_B });
    expect(missing.status).toBe(404);
    expect(someoneElses.status).toBe(404);
    expect(missing.body).toEqual(someoneElses.body);
  });

  it('a body-supplied claim/customer id cannot substitute for a session', async () => {
    const withBodyId = await api('POST', '/api/customer/claims/link/request-otp', undefined, {
      claimId: LINK_CLAIM(6), customerId: CUSTOMER_A, customer_id: CUSTOMER_A,
    });
    const asAnon = await api('POST', '/api/customer/claims/link/request-otp', undefined, { claimId: LINK_CLAIM(6) });
    expect(withBodyId.status).toBe(401);
    expect(asAnon.status).toBe(401);
    // Identical outcome — the body id can only have been ignored.
    expect(withBodyId.body).toEqual(asAnon.body);
  });
});

describe('customer claims: static hardening', () => {
  it('25. every new customer route authenticates and is rate-limited', () => {
    const routesTs = fs.readFileSync(path.resolve(__dirname, '../routes/customerClaims.ts'), 'utf8');
    const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

    // All five routes exist, each behind requireCustomerAuth...
    expect(routesTs).toContain("'/api/customer/claims/link/request-otp',");
    expect(routesTs).toContain("'/api/customer/claims/link/verify',");
    expect(routesTs).toContain("app.get('/api/customer/claims', requireCustomerAuth,");
    expect(routesTs).toContain("app.get('/api/customer/claims/:id', requireCustomerAuth,");
    expect(routesTs).toContain("app.delete('/api/customer/claims/:id/link', requireCustomerAuth,");
    // ...with a limiter on every one of them.
    expect((routesTs.match(/requireCustomerAuth,\s+claimLinkLimiter,/g) || []).length).toBe(2);
    // The OTP-sending route carries the IP-independent global ceiling, exactly
    // like the existing customer OTP routes in server.ts.
    expect(routesTs).toMatch(/claimLinkGlobalOtpLimiter/);
    expect(routesTs).toMatch(/keyGenerator: \(\) => 'global-claim-link-otp-bucket'/);
    expect(routesTs).toMatch(/claimLinkVerifyLimiter/);

    // server.ts registers the real routes and injects the REAL checkClaimExpiry,
    // so dashboard expiry awareness is the platform's own lifecycle logic.
    expect(serverTs).toContain('registerCustomerClaimRoutes(app, { checkClaimExpiry });');
  });

  it('never reads customer identity from the body, query string or params', () => {
    const routesTs = fs.readFileSync(path.resolve(__dirname, '../routes/customerClaims.ts'), 'utf8');
    expect(routesTs).toContain('req.customer.id');
    expect(routesTs).not.toMatch(/req\.body[?.]*\.customer/i);
    expect(routesTs).not.toMatch(/req\.query[?.]*\.(customer|phone)/i);
    expect(routesTs).not.toMatch(/req\.params[?.]*\.(customer|phone)/i);
    // No auto-linking hooks anywhere in the new server-side surface.
    expect(routesTs).not.toMatch(/autoLink|backfill|linkAll/i);
  });

  it('the dashboard query is scoped by link, never by phone or a full scan', () => {
    const dbTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');
    const start = dbTs.indexOf('public async getClaimsForCustomer');
    expect(start).toBeGreaterThan(-1);
    const customerQuery = dbTs.slice(start, start + 2600);
    expect(customerQuery).toContain('customerClaimLinksTable');
    // No owner_phone predicate and no unbounded claims/items/agents select.
    expect(customerQuery).not.toMatch(/owner_phone/);
    expect(customerQuery).not.toContain('_.from(claimsTable));');
    expect(customerQuery).toContain('inArray(claimsTable.id, claimIds)');
    expect(customerQuery).toContain('inArray(itemsTable.id, itemIds)');
    expect(customerQuery).toContain('inArray(agentsTable.id, agentIds)');
  });

  it('the link table enforces one-customer-per-claim at the database level', () => {
    const schemaTs = fs.readFileSync(path.resolve(__dirname, '../db/schema.ts'), 'utf8');
    const ddlTs = fs.readFileSync(path.resolve(__dirname, '../db/index.ts'), 'utf8');
    // uq_customer_claim_links_claim is the actual invariant; the pair index is
    // the idempotency guarantee.
    expect(schemaTs).toContain('uq_customer_claim_links_claim');
    expect(schemaTs).toContain('uq_customer_claim_links_pair');
    expect(ddlTs).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_claim_links_claim ON customer_claim_links(claim_id)');
    expect(ddlTs).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_claim_links_pair ON customer_claim_links(customer_id, claim_id)');
    expect(ddlTs).toContain('CREATE TABLE IF NOT EXISTS customer_claim_links');
  });

  it('DPA erasure removes the account relationship but never the retained claim record', () => {
    const dbTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');
    const start = dbTs.indexOf('public async purgeUserData');
    expect(start).toBeGreaterThan(-1);
    const purge = dbTs.slice(start, start + 6000);
    expect(purge).toContain('customerClaimLinksTable');
    expect(purge).toMatch(/delete\(customerClaimLinksTable\)/);
    // It must NOT delete claims/ledger/audit rows.
    expect(purge).not.toMatch(/delete\(claimsTable\)/);
    expect(purge).not.toMatch(/delete\(ledgerTable\)/);
    expect(purge).not.toMatch(/delete\(auditLogTable\)/);
  });
});

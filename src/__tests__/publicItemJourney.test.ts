import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { db } from '../db/database';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';

// ---------------------------------------------------------------------------
// HTTP INTEGRATION TESTS — Phase 7B public item journey + claim-status privacy.
//
// These mount a REAL Express app around the REAL handlers in
// routes/publicItems.ts and drive them over an actual TCP socket with fetch().
// Assertions against source text cannot demonstrate that an unauthenticated
// caller is refused the assigned agent's phone number, exact address and GPS
// coordinates — only a real request can.
//
// server.ts itself is deliberately NOT imported (it calls startServer() at
// import time). routes/publicItems.ts exists precisely so these handlers can be
// mounted in isolation.
//
// The claimability rule is injected (exactly as server.ts injects it) — see
// testCanCreateClaim below, which mirrors the observable contract of the real
// canCreateClaim(): only status 'at_agent' with no unresolved dispute is
// publicly visible. The route's own privacy/authorization behaviour is what is
// under test here, and that is exercised for real.
// ---------------------------------------------------------------------------

const RUN = testRunId;
const base = Math.floor(10000000 + Math.random() * 89999999);
const phone = (offset: number) => '+2547' + String(base + offset).slice(-8);

const PHONE_OWNER = phone(0);
const PHONE_OTHER = phone(1);

const AGENT_ID = `TEST-7B-AGENT-${RUN}`;
// Values that must NEVER reach an unauthenticated caller (or a caller who does
// not prove ownership of the claim).
const SECRET_AGENT_PHONE = '+254711111111';
const SECRET_AGENT_ADDRESS = 'Moi Avenue, Nairobi CBD, Shop 14B';
const SECRET_AGENT_TILL = 'TILL-SECRET-777';
const SECRET_AGENT_DEPOSIT = 'DEPOSIT-SECRET-5000';
const SECRET_AGENT_WARNING = 'late-handover-warning-secret';
const SECRET_ID_HASH = 'AGENT-ID-HASH-SECRET';
const SECRET_FINDER_PHONE = '+254799999999';
const SECRET_FINDER_EMAIL = 'finder-secret@example.com';
const SECRET_OCR_NUMBER = 'OCR-SECRET-999';
const SECRET_OCR_NAME = 'OCR SECRET NAME';
const SECRET_DOC_HASH = 'HASH-SECRET';
const SECRET_PAYMENT_REF = `REF-SECRET-${RUN}`;
const SECRET_SECURITY_ANSWER = 'lastDigits-1234';

const PUBLIC_OPEN = `TEST-7B-ITEM-OPEN-${RUN}`;         // public, non-sensitive
const PUBLIC_SENSITIVE = `TEST-7B-ITEM-ID-${RUN}`;      // public, sensitive document
const NOT_YET_VERIFIED = `TEST-7B-ITEM-PENDING-${RUN}`; // awaiting_dropoff
const ALREADY_CLAIMED = `TEST-7B-ITEM-CLAIMED-${RUN}`;  // claimed
const WITHDRAWN = `TEST-7B-ITEM-REJECTED-${RUN}`;       // rejected
const NO_AGENT_ITEM = `TEST-7B-ITEM-NOAGENT-${RUN}`;    // at_agent, unassigned
const MISSING_ITEM = `TEST-7B-ITEM-MISSING-${RUN}`;     // never created

const CLAIM_ON_SENSITIVE = `TEST-7B-CLAIM-A-${RUN}`;
const CLAIM_ON_OPEN = `TEST-7B-CLAIM-B-${RUN}`;
const CLAIM_UNKNOWN = `TEST-7B-CLAIM-NONE-${RUN}`;

const PUBLIC_ITEM_KEYS = [
  'id', 'category_id', 'photo_url', 'is_sensitive_document', 'document_name_fuzzy',
  'location_description', 'description', 'isDescriptionOnly', 'created_at', 'status', 'agent',
];
const PUBLIC_AGENT_KEYS = ['business_name', 'rough_area'];
// The whitelist toOwnerSafeAgentView already applies on owner-facing routes.
const OWNER_SAFE_AGENT_KEYS = [
  'business_name', 'contact_phone', 'id', 'latitude', 'location_address',
  'longitude', 'rating', 'rating_count',
];
// Raw values / raw column names that must never appear in a public response.
const NEVER_PUBLIC_FIELDS = [
  SECRET_OCR_NUMBER, SECRET_OCR_NAME, SECRET_DOC_HASH, SECRET_FINDER_PHONE,
  SECRET_FINDER_EMAIL, SECRET_AGENT_TILL, SECRET_ID_HASH, SECRET_AGENT_DEPOSIT,
  SECRET_AGENT_WARNING, SECRET_PAYMENT_REF, SECRET_SECURITY_ANSWER,
  'ocr_extracted_number', 'ocr_extracted_name', 'document_number_hash',
  'finder_phone', 'finder_email', 'security_answers', 'owner_phone',
  'owner_id_proof_url', 'payment_reference', 'assigned_agent_id',
  'locked_total_fee', 'declared_value', 'rejection_reason', 'flaggedForReview',
  // PHASE 9D — the finder's explicit county is INTERNAL geographic data used
  // for matching consistency. It is deliberately NOT part of the public item
  // read model (PUBLIC_ITEM_KEYS above is the exact allow-list, so adding it
  // would fail that assertion too). Phase 9D added no coordinate, distance,
  // geocoding-provider, precision or confidence field to any public DTO.
  'found_county',
];

function itemRow(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    category_id: 'national-id',
    photo_url: 'https://photos.example/item.jpg',
    ocr_extracted_number: SECRET_OCR_NUMBER,
    ocr_extracted_name: SECRET_OCR_NAME,
    document_number_hash: SECRET_DOC_HASH,
    document_name_fuzzy: 'National ID',
    location_description: 'Nairobi CBD',
    latitude: -1.2921,
    longitude: 36.8219,
    found_county: 'Nairobi City',
    finder_phone: SECRET_FINDER_PHONE,
    finder_email: SECRET_FINDER_EMAIL,
    assigned_agent_id: AGENT_ID,
    status: 'at_agent',
    flaggedForReview: true,
    isDescriptionOnly: false,
    description: 'Black leather wallet with a broken zipper',
    is_sensitive_document: true,
    rejection_reason: null,
    locked_total_fee: '500.00',
    declared_value: '20000',
    verification_status: 'confirmed_as_reported',
    ...overrides,
  } as any;
}

function claimRow(id: string, itemId: string, ownerPhone: string, status = 'awaiting_agent_confirmation') {
  return {
    id,
    item_id: itemId,
    owner_phone: ownerPhone,
    security_answers: { lastDigits: SECRET_SECURITY_ANSWER },
    verification_tier: 2,
    // Phase 7C.5 (F9): default fixtures now sit in a PICKUP-ELIGIBLE status.
    // The old default was 'pending_verification', which the new eligibility
    // gate correctly refuses — the success-path tests below need a claim that
    // is genuinely entitled to pickup instructions. The matrix further down
    // covers every status explicitly.
    status,
    owner_id_proof_url: 'https://secret.example/id-proof.png',
    payment_reference: SECRET_PAYMENT_REF,
    owner_identifying_details: 'scar on left hand',
    owner_email: 'owner-secret@example.com',
  } as any;
}

// Phase 7C.5 — one claim per status for the eligibility matrix. Each claim gets
// its own item because `claims.item_id` is a real foreign key and
// uq_claims_one_active_per_item allows only one claim per item among the
// non-excluded statuses.
async function claimWithStatus(status: string, suffix: string) {
  const itemId = `TEST-7C5-ITEM-${suffix}-${RUN}`;
  const claimId = `TEST-7C5-CLAIM-${suffix}-${RUN}`;
  await db.createItem(itemRow(itemId));
  await db.createClaim(claimRow(claimId, itemId, PHONE_OWNER, status));
  return { itemId, claimId };
}

// Mirrors the observable contract of server.ts's canCreateClaim() (async, as
// the real one is).
async function testCanCreateClaim(item: any, disputes: any[] = []) {
  if (!item) return { allowed: false, reason: 'not_found' };
  if (item.status !== 'at_agent') return { allowed: false, reason: `item_status:${item.status}` };
  if ((disputes || []).some((d: any) => !d.resolved_at)) {
    return { allowed: false, reason: 'unresolved_dispute' };
  }
  return { allowed: true, reason: 'ok' };
}

let server: any;
let baseUrl = '';

async function api(method: string, urlPath: string, body?: any) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json, text };
}

function expectNoSecrets(text: string) {
  for (const value of NEVER_PUBLIC_FIELDS) {
    expect(text, `response leaked "${value}"`).not.toContain(value);
  }
}

beforeAll(async () => {
  await ensureTestCategory('national-id');

  await db.createAgent({
    id: AGENT_ID,
    business_name: 'Test Agent Business',
    contact_phone: SECRET_AGENT_PHONE,
    location_address: SECRET_AGENT_ADDRESS,
    latitude: -1.28,
    longitude: 36.82,
    mpesa_till_or_paybill: SECRET_AGENT_TILL,
    national_id_hash: SECRET_ID_HASH,
    refundable_deposit: SECRET_AGENT_DEPOSIT,
    warning_count: 3,
    last_warning_reason: SECRET_AGENT_WARNING,
    id_document_photo_url: 'https://secret.example/agent-id.png',
  } as any);

  await db.createItem(itemRow(PUBLIC_SENSITIVE));
  await db.createItem(itemRow(PUBLIC_OPEN, {
    is_sensitive_document: false,
    isDescriptionOnly: true,
    document_name_fuzzy: 'Phone',
  }));
  await db.createItem(itemRow(NOT_YET_VERIFIED, { status: 'awaiting_dropoff' }));
  await db.createItem(itemRow(ALREADY_CLAIMED, { status: 'claimed' }));
  await db.createItem(itemRow(WITHDRAWN, { status: 'rejected' }));
  await db.createItem(itemRow(NO_AGENT_ITEM, { assigned_agent_id: null }));

  await db.createClaim(claimRow(CLAIM_ON_SENSITIVE, PUBLIC_SENSITIVE, PHONE_OWNER));
  await db.createClaim(claimRow(CLAIM_ON_OPEN, PUBLIC_OPEN, PHONE_OWNER));

  const { registerPublicItemRoutes } = await import('../routes/publicItems');
  const app = express();
  app.use(express.json());
  registerPublicItemRoutes(app, {
    canCreateClaim: testCanCreateClaim,
    sendServerError: (res: any, error: any, context: string) => {
      console.error(`[TEST ${context}]`, error);
      res.status(500).json({ error: 'A server error occurred. Please try again later.' });
    },
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/items/:id/public — the public item read model', () => {
  it('1. a publicly visible item returns the masked public shape, not a raw row', async () => {
    const res = await api('GET', `/api/items/${PUBLIC_SENSITIVE}/public`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.item).sort()).toEqual([...PUBLIC_ITEM_KEYS].sort());
    expect(res.body.item.id).toBe(PUBLIC_SENSITIVE);
    expect(res.body.item.status).toBe('at_agent');
    // The hub is reduced to a business name + coarse area; the exact address,
    // the contact phone and the GPS coordinates are absent.
    expect(Object.keys(res.body.item.agent).sort()).toEqual([...PUBLIC_AGENT_KEYS].sort());
    expect(res.body.item.agent.business_name).toBe('Test Agent Business');
    expect(res.body.item.agent.rough_area).toBe('Moi Avenue');
    expectNoSecrets(res.text);
  });

  it('2. a sensitive document never publishes its photo or its description', async () => {
    const res = await api('GET', `/api/items/${PUBLIC_SENSITIVE}/public`);
    expect(res.body.item.is_sensitive_document).toBe(true);
    expect(res.body.item.photo_url).toBeNull();
    expect(res.body.item.description).toBeNull();
    // The masked name is still shown so a genuine owner can recognise the item.
    expect(res.body.item.document_name_fuzzy).toBe('National ID');
  });

  it('3. a non-sensitive item keeps its photo and description', async () => {
    const res = await api('GET', `/api/items/${PUBLIC_OPEN}/public`);
    expect(res.status).toBe(200);
    expect(res.body.item.is_sensitive_document).toBe(false);
    expect(res.body.item.photo_url).toBe('https://photos.example/item.jpg');
    expect(res.body.item.description).toBe('Black leather wallet with a broken zipper');
  });

  it('4. a never-created item is a 404 that reveals nothing about internal records', async () => {
    const res = await api('GET', `/api/items/${MISSING_ITEM}/public`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: expect.any(String) });
    expectNoSecrets(res.text);
    expect(res.text).not.toMatch(/stack|at Object|<html|SELECT|pg_/i);
  });

  it('5. an invalid item id is a 404, not a 500 or a database error', async () => {
    for (const bad of ['has%20space', 'a'.repeat(120), '%2Fetc%2Fpasswd']) {
      const res = await api('GET', `/api/items/${bad}/public`);
      expect(res.status, `id=${bad}`).toBe(404);
      expectNoSecrets(res.text);
    }
  });

  it('6. items that are not publicly claimable are 404 — the same set public search would never show', async () => {
    const missing = await api('GET', `/api/items/${MISSING_ITEM}/public`);
    for (const id of [NOT_YET_VERIFIED, ALREADY_CLAIMED, WITHDRAWN]) {
      const res = await api('GET', `/api/items/${id}/public`);
      expect(res.status, `item=${id}`).toBe(404);
      // The response must not distinguish "does not exist" from "not public".
      expect(res.body).toEqual(missing.body);
    }
  });

  it('7. an item with no assigned agent reports agent: null rather than inventing one', async () => {
    const res = await api('GET', `/api/items/${NO_AGENT_ITEM}/public`);
    expect(res.status).toBe(200);
    expect(res.body.item.agent).toBeNull();
  });
});

describe('POST /api/claims/:id/pickup-details — ownership-gated agent contact/location', () => {
  it('8. no phone at all -> 400, and no claim/agent data of any kind', async () => {
    const res = await api('POST', `/api/claims/${CLAIM_ON_SENSITIVE}/pickup-details`, {});
    expect(res.status).toBe(400);
    expect(res.body.agent).toBeUndefined();
    expectNoSecrets(res.text);
    // The agent's real operational details are absent.
    expect(res.text).not.toContain(SECRET_AGENT_PHONE);
    expect(res.text).not.toContain(SECRET_AGENT_ADDRESS);
    expect(res.text).not.toContain('Moi Avenue');
    expect(res.text).not.toContain('-1.28');
  });

  it('8b. the missing-phone 400 is decided BEFORE any claim lookup, for real and invented claims alike', async () => {
    // If the claim lookup ran first, this 400 could never be returned for an
    // unknown claim — the two bodies must therefore be identical.
    const existing = await api('POST', `/api/claims/${CLAIM_ON_SENSITIVE}/pickup-details`, { phone: '' });
    const invented = await api('POST', `/api/claims/${CLAIM_UNKNOWN}/pickup-details`, { phone: '' });
    expect(existing.status).toBe(400);
    expect(invented.status).toBe(400);
    expect(existing.text).toBe(invented.text);
  });

  it('9. a wrong phone -> 404 with NO private operational data (knowing the claim ID is not enough)', async () => {
    const res = await api('POST', `/api/claims/${CLAIM_ON_SENSITIVE}/pickup-details`, { phone: PHONE_OTHER });
    expect(res.status).toBe(404);
    expect(res.body.agent).toBeUndefined();
    expect(res.text).not.toContain(SECRET_AGENT_PHONE);
    expect(res.text).not.toContain(SECRET_AGENT_ADDRESS);
    expect(res.text).not.toContain('Moi Avenue');
    expect(res.text).not.toContain('-1.28');
    expect(res.text).not.toContain('36.82');
    expectNoSecrets(res.text);
  });

  it('9b. F4 — "wrong phone", "unknown claim" and "malformed phone" are externally indistinguishable', async () => {
    const wrongPhone = await api('POST', `/api/claims/${CLAIM_ON_SENSITIVE}/pickup-details`, { phone: PHONE_OTHER });
    const unknownClaim = await api('POST', `/api/claims/${CLAIM_UNKNOWN}/pickup-details`, { phone: PHONE_OWNER });
    // toE164Kenyan passes malformed input through unchanged, so a junk phone
    // still reaches (and fails) the ownership comparison.
    const malformedPhone = await api('POST', `/api/claims/${CLAIM_ON_SENSITIVE}/pickup-details`, { phone: 'not-a-phone' });

    for (const res of [wrongPhone, unknownClaim, malformedPhone]) {
      expect(res.status).toBe(404);
      expect(res.body.agent).toBeUndefined();
    }
    // Byte-for-byte identical: no existence oracle remains.
    expect(wrongPhone.text).toBe(unknownClaim.text);
    expect(wrongPhone.text).toBe(malformedPhone.text);
    expect(wrongPhone.body).toEqual(unknownClaim.body);
  });

  it('10. an unknown claim id -> 404, with no data at all', async () => {
    const res = await api('POST', `/api/claims/${CLAIM_UNKNOWN}/pickup-details`, { phone: PHONE_OWNER });
    expect(res.status).toBe(404);
    expect(res.body.agent).toBeUndefined();
    expectNoSecrets(res.text);
  });

  it('11. the owner receives item_id plus exactly the owner-safe agent whitelist', async () => {
    const res = await api('POST', `/api/claims/${CLAIM_ON_SENSITIVE}/pickup-details`, { phone: PHONE_OWNER });
    expect(res.status).toBe(200);
    // F7: the success contract is exactly { item_id, agent } — no claim status,
    // no owner phone, no payment reference, nothing else.
    expect(Object.keys(res.body).sort()).toEqual(['agent', 'item_id']);
    expect(res.body.item_id).toBe(PUBLIC_SENSITIVE);
    expect(Object.keys(res.body.agent).sort()).toEqual([...OWNER_SAFE_AGENT_KEYS].sort());
    expect(res.body.agent.contact_phone).toBe(SECRET_AGENT_PHONE);
    expect(res.body.agent.location_address).toBe(SECRET_AGENT_ADDRESS);
    // The whitelist still excludes the agent's own operational/financial data.
    expect(res.text).not.toContain(SECRET_AGENT_TILL);
    expect(res.text).not.toContain(SECRET_AGENT_DEPOSIT);
    expect(res.text).not.toContain(SECRET_AGENT_WARNING);
    expect(res.text).not.toContain(SECRET_ID_HASH);
  });

  it('12. the local Kenyan phone format is accepted for the same claim (no false denial)', async () => {
    const local = '0' + PHONE_OWNER.slice(4);
    const res = await api('POST', `/api/claims/${CLAIM_ON_OPEN}/pickup-details`, { phone: local });
    expect(res.status).toBe(200);
    expect(res.body.agent.business_name).toBe('Test Agent Business');
  });

  it('13. a claim whose item has no agent yields agent: null (a valid answer, not an error), still only for the owner', async () => {
    const claimId = `TEST-7B-CLAIM-NOAGENT-${RUN}`;
    await db.createClaim(claimRow(claimId, NO_AGENT_ITEM, PHONE_OWNER));
    const denied = await api('POST', `/api/claims/${claimId}/pickup-details`, { phone: PHONE_OTHER });
    expect(denied.status).toBe(404);
    expect(denied.body.agent).toBeUndefined();
    const allowed = await api('POST', `/api/claims/${claimId}/pickup-details`, { phone: PHONE_OWNER });
    expect(allowed.status).toBe(200);
    // agent: null here means "no hub is assigned yet" — the F8 UI renders it as
    // its own state, never as a failure and never as stale data.
    expect(allowed.body.agent).toBeNull();
    expect(allowed.body.item_id).toBe(NO_AGENT_ITEM);
  });

  it('14. F9 — every pickup-ELIGIBLE status receives the hub details', async () => {
    const eligible = [
      'awaiting_agent_confirmation',
      'pending_payment',
      'escrow_held',
      'pending_settlement',
      'releasing',
      'released',
    ];
    for (const status of eligible) {
      const { itemId, claimId } = await claimWithStatus(status, `ELIG-${status}`);
      const res = await api('POST', `/api/claims/${claimId}/pickup-details`, { phone: PHONE_OWNER });
      expect(res.status, `status=${status} must remain pickup-eligible`).toBe(200);
      expect(res.body.item_id, `status=${status}`).toBe(itemId);
      expect(res.body.agent.contact_phone, `status=${status}`).toBe(SECRET_AGENT_PHONE);
      expectNoSecrets(res.text);
    }
  });

  it('15. F9 — NO ineligible status ever receives pickup details', async () => {
    const ineligible = [
      'pending_verification',   // OTP not satisfied — ownership of the phone is unproven
      'payment_window_expired', // abandoned attempt; item is claimable again
      'disputed',               // adjudication in progress
      'rejected',               // failed verification / lost dispute
      'refunding',              // refund in flight
      'refunded',               // money returned, claim closed
    ];
    for (const status of ineligible) {
      const { claimId } = await claimWithStatus(status, `INELIG-${status}`);
      const res = await api('POST', `/api/claims/${claimId}/pickup-details`, { phone: PHONE_OWNER });
      expect(res.status, `status=${status} must be refused`).toBe(409);
      expect(res.body.agent, `status=${status}`).toBeNull();
      // Nothing about why, and nothing about the hub.
      expect(res.body.status).toBeUndefined();
      expect(res.body.item_id).toBeUndefined();
      expect(res.text).not.toContain(SECRET_AGENT_PHONE);
      expect(res.text).not.toContain(SECRET_AGENT_ADDRESS);
      expect(res.text).not.toContain('Moi Avenue');
      expect(res.text).not.toContain('-1.28');
      expect(res.text).not.toContain('36.82');
      expectNoSecrets(res.text);
      // ...and the ineligibility response never reveals more than the refusal
      // itself: an identical body for every refused status.
      expect(Object.keys(res.body).sort()).toEqual(['agent', 'error']);
    }
  });

  it('16. F9 — the status gate runs AFTER the ownership check, so it is not a state oracle', async () => {
    // An ineligible claim + wrong phone must look exactly like "no such claim".
    const { claimId } = await claimWithStatus('refunded', 'ORACLE');
    const wrongPhone = await api('POST', `/api/claims/${claimId}/pickup-details`, { phone: PHONE_OTHER });
    const unknownClaim = await api('POST', `/api/claims/${CLAIM_UNKNOWN}/pickup-details`, { phone: PHONE_OTHER });
    expect(wrongPhone.status).toBe(404);
    expect(unknownClaim.status).toBe(404);
    expect(wrongPhone.text).toBe(unknownClaim.text);
  });
});

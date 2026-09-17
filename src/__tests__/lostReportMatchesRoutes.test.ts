import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';
import { registerLostReportRoutes } from '../routes/lostReports';
import { createLostReportMatchCustomerLimiter } from '../config/lostReportLimiter';
import { generateLostReportReference } from '../services/lostReportReference';

// ---------------------------------------------------------------------------
// Phase 9B — HTTP INTEGRATION TESTS for GET /api/lost-reports/:id/matches.
//
// These mount a REAL Express app around the REAL requireCustomerAuth
// middleware, the REAL route handler and the REAL matching engine, then drive
// them over a real TCP socket. The engine's own rules are unit-tested in
// src/services/__tests__/lostReportMatching.test.ts; what is proven HERE is the
// boundary: authentication, ownership, enumeration resistance, eligibility
// gating, privacy of the payload, and — most importantly — that generating a
// candidate creates NO claim, verifies NO ownership and moves NO money.
// ---------------------------------------------------------------------------

const RUN = testRunId;
const base = Math.floor(10000000 + Math.random() * 89999999);
const phone = (offset: number) => '+2547' + String(base + offset).slice(-8);

const CUSTOMER_A = `TEST-9B-CUS-A-${RUN}`;
const CUSTOMER_B = `TEST-9B-CUS-B-${RUN}`;
const CUSTOMER_SUSPENDED = `TEST-9B-CUS-S-${RUN}`;

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_SUSPENDED = 'c'.repeat(64);
const TOKEN_EXPIRED = 'e'.repeat(64);
const TOKEN_REVOKED = 'f'.repeat(64);

const SESSION_A = `TEST-9B-SESS-A-${RUN}`;
const SESSION_B = `TEST-9B-SESS-B-${RUN}`;
const SESSION_SUSPENDED = `TEST-9B-SESS-S-${RUN}`;
const SESSION_EXPIRED = `TEST-9B-SESS-E-${RUN}`;
const SESSION_REVOKED = `TEST-9B-SESS-R-${RUN}`;

const ITEM_MATCH = `TEST-9B-ITEM-MATCH-${RUN}`;
const ITEM_OTHER_COUNTY = `TEST-9B-ITEM-COUNTY-${RUN}`;
const ITEM_AWAITING = `TEST-9B-ITEM-AWAIT-${RUN}`;
const ITEM_FLAGGED = `TEST-9B-ITEM-FLAG-${RUN}`;
const ITEM_CLAIMED = `TEST-9B-ITEM-CLAIMED-${RUN}`;
const ITEM_DISPUTED = `TEST-9B-ITEM-DISPUTED-${RUN}`;
const ITEM_WRONG_CATEGORY = `TEST-9B-ITEM-WRONG-${RUN}`;

const ITEM_SENSITIVE = `TEST-9B-ITEM-SENS-${RUN}`;
const HASH_SENSITIVE = 'c'.repeat(64);

const CLAIM_DISPUTE_1 = `TEST-9B-CLM-D1-${RUN}`;
const CLAIM_DISPUTE_2 = `TEST-9B-CLM-D2-${RUN}`;
const DISPUTE_ID = `TEST-9B-DSP-${RUN}`;

const LR_A_MATCH = generateLostReportReference();
const LR_A_NONE = generateLostReportReference();
const LR_A_FUTURE = generateLostReportReference();
const LR_A_CANCELLED = generateLostReportReference();
const LR_A_SENSITIVE = generateLostReportReference();
const LR_B = generateLostReportReference();

// Values that must NEVER appear in a customer-facing payload.
const SECRET_FINDER_PHONE = `+2547999${String(base).slice(-5)}`;
const SECRET_FINDER_EMAIL = `finder-secret-${RUN}@example.test`;
const SECRET_OCR_NUMBER = `OCRSECRET${RUN}`;
const SECRET_OCR_NAME = `Ocr Secret Name ${RUN}`;
const SECRET_DESCRIPTION = `SecretSensitiveDescription${RUN}`;
const SECRET_AGENT = `TEST-9B-AGENT-${RUN}`;

let server: any;
let limitedServer: any;
let baseUrl = '';
let limitedBaseUrl = '';

function itemRow(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    category_id: 'smartphone',
    photo_url: 'photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: 'Simu',
    location_description: 'Westlands, Nairobi',
    // PHASE 9D: the found side's county is the EXPLICIT canonical field the
    // Finder selects — not something inferred from the free-text location.
    found_county: 'Nairobi City',
    latitude: null,
    longitude: null,
    finder_phone: SECRET_FINDER_PHONE,
    assigned_agent_id: null,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: 'Black Samsung phone with a cracked screen',
    is_sensitive_document: false,
    rejection_reason: null,
    finder_email: SECRET_FINDER_EMAIL,
    ...overrides,
  } as any;
}

/** A lost report whose window brackets "just now", matching the default item. */
function lostRow(id: string, customerId: string, overrides: Record<string, any> = {}) {
  const now = Date.now();
  return {
    id,
    customer_id: customerId,
    category_id: 'smartphone',
    status: 'active',
    county: 'Nairobi City',
    location_area: 'Westlands',
    location_landmark: null,
    lost_at_from: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    lost_at_to: new Date(now - 60 * 60 * 1000).toISOString(),
    brand: 'Samsung',
    model: null,
    colour: 'Black',
    material: null,
    description: 'black samsung phone cracked screen',
    distinctive_marks: null,
    document_type: null,
    document_number_hash: null,
    ...overrides,
  } as any;
}

async function seed() {
  await db.createCustomer(CUSTOMER_A, 'Asha Mwangi', phone(0));
  await db.createCustomer(CUSTOMER_B, 'Brian Otieno', phone(1));
  await db.createCustomer(CUSTOMER_SUSPENDED, 'Suspended User', phone(2));
  await db.updateCustomerStatus(CUSTOMER_SUSPENDED, 'suspended');

  const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.createCustomerSession(SESSION_A, CUSTOMER_A, hashCode(TOKEN_A), in7Days);
  await db.createCustomerSession(SESSION_B, CUSTOMER_B, hashCode(TOKEN_B), in7Days);
  await db.createCustomerSession(SESSION_SUSPENDED, CUSTOMER_SUSPENDED, hashCode(TOKEN_SUSPENDED), in7Days);
  await db.createCustomerSession(SESSION_EXPIRED, CUSTOMER_A, hashCode(TOKEN_EXPIRED), new Date(Date.now() - 1000));
  await db.createCustomerSession(SESSION_REVOKED, CUSTOMER_A, hashCode(TOKEN_REVOKED), in7Days);
  await db.revokeCustomerSession(SESSION_REVOKED);

  await ensureTestCategory('smartphone');
  await ensureTestCategory('national-id');

  // --- items -------------------------------------------------------------
  await db.createItem(itemRow(ITEM_MATCH));
  await db.createItem(itemRow(ITEM_OTHER_COUNTY, {
    location_description: 'Mombasa, Digo Road',
    // PHASE 9D: declared explicitly. Previously the county was inferred from
    // this street text — the guessing that produced the "Mombasa Road" false
    // positive. The test's intent is unchanged; it now uses the canonical field.
    found_county: 'Mombasa',
  }));
  await db.createItem(itemRow(ITEM_WRONG_CATEGORY, { category_id: 'laptop' }));
  await db.createItem(itemRow(ITEM_AWAITING, { status: 'awaiting_dropoff' }));
  await db.createItem(itemRow(ITEM_FLAGGED, { flaggedForReview: true }));
  await db.createItem(itemRow(ITEM_CLAIMED, { status: 'claimed' }));
  await db.createItem(itemRow(ITEM_DISPUTED));

  // A sensitive-document item carrying every kind of secret, matched by an
  // exact protected identifier so it becomes a candidate whose payload can then
  // be inspected for leakage.
  await db.createItem(itemRow(ITEM_SENSITIVE, {
    category_id: 'national-id',
    is_sensitive_document: true,
    document_number_hash: HASH_SENSITIVE,
    photo_url: 'secret-national-id-photo.jpg',
    description: SECRET_DESCRIPTION,
    ocr_extracted_number: SECRET_OCR_NUMBER,
    ocr_extracted_name: SECRET_OCR_NAME,
    latitude: -1.2921,
    longitude: 36.8219,
    assigned_agent_id: SECRET_AGENT,
  }));

  // An unresolved dispute on ITEM_DISPUTED makes it ineligible for a claim, and
  // therefore ineligible as a candidate.
  await db.createClaim({
    id: CLAIM_DISPUTE_1, item_id: ITEM_DISPUTED, owner_phone: phone(3),
    security_answers: { lastDigits: '0001', fullName: 'Claimant One' },
    verification_tier: 1, status: 'disputed', owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  } as any);
  await db.createClaim({
    id: CLAIM_DISPUTE_2, item_id: ITEM_DISPUTED, owner_phone: phone(4),
    security_answers: { lastDigits: '0002', fullName: 'Claimant Two' },
    verification_tier: 1, status: 'disputed', owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  } as any);
  await db.createDispute({
    id: DISPUTE_ID, item_id: ITEM_DISPUTED,
    claimant_1_claim_id: CLAIM_DISPUTE_1, claimant_2_claim_id: CLAIM_DISPUTE_2,
    claimant_1_id_proof_url: 'proof1.jpg', claimant_2_id_proof_url: 'proof2.jpg',
    resolved_by: null, resolved_claim_id: null, resolved_at: null, admin_notes: null,
  } as any);

  // --- lost reports ------------------------------------------------------
  await db.createLostReport(lostRow(LR_A_MATCH, CUSTOMER_A));
  // Nothing on the platform is a 'bicycle', so this report has no candidates.
  await db.createLostReport(lostRow(LR_A_NONE, CUSTOMER_A, {
    category_id: 'bicycle', location_area: 'Karen',
  }));
  // A window two days in the FUTURE: every existing item predates it, so every
  // item is a temporal contradiction and nothing may be returned.
  const future = Date.now() + 2 * 24 * 60 * 60 * 1000;
  await db.createLostReport(lostRow(LR_A_FUTURE, CUSTOMER_A, {
    lost_at_from: new Date(future).toISOString(),
    lost_at_to: new Date(future + 60 * 60 * 1000).toISOString(),
  }));
  await db.createLostReport(lostRow(LR_A_CANCELLED, CUSTOMER_A, { status: 'cancelled' }));
  await db.createLostReport(lostRow(LR_A_SENSITIVE, CUSTOMER_A, {
    category_id: 'national-id',
    document_number_hash: HASH_SENSITIVE,
    brand: null, colour: null, description: null,
  }));
  await db.createLostReport(lostRow(LR_B, CUSTOMER_B));
}

/** Mirrors server.ts's central canCreateClaim rule. */
async function testCanCreateClaim(item: any, preFetchedDisputes?: any[]) {
  if (!item) return { allowed: false, reason: 'not_found' };
  if (item.status !== 'at_agent') return { allowed: false, reason: 'not_physically_verified' };
  if (item.flaggedForReview) return { allowed: false, reason: 'flagged_for_review' };
  const disputes = preFetchedDisputes ?? await db.getDisputesByItem(item.id);
  if ((disputes || []).some((d: any) => !d.resolved_at)) return { allowed: false, reason: 'unresolved_dispute' };
  return { allowed: true, reason: 'ok' };
}

beforeAll(async () => {
  await seed();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerLostReportRoutes(app, {
    canCreateClaim: testCanCreateClaim,
    sendServerError: (res: any, error: any, context: string) => {
      console.error(`[${context}]`, error);
      res.status(500).json({ error: error?.message || String(error) });
    },
  });

  const limitedApp = express();
  limitedApp.use(express.json({ limit: '1mb' }));
  registerLostReportRoutes(limitedApp, {
    canCreateClaim: testCanCreateClaim,
    sendServerError: (res: any, error: any) => res.status(500).json({ error: String(error) }),
    matchCustomerRateLimiter: createLostReportMatchCustomerLimiter({ max: 2, windowMs: 60 * 1000 }),
  });

  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise<void>((resolve) => { limitedServer = limitedApp.listen(0, '127.0.0.1', () => resolve()); });
  limitedBaseUrl = `http://127.0.0.1:${limitedServer.address().port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
});

async function getMatches(token: string | undefined, reference: string, root = '') {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = 'r4m_customer_session=' + token;
  const res = await fetch(`${root || baseUrl}/api/lost-reports/${reference}/matches`, { headers });
  const raw = await res.text();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { json = null; }
  return { status: res.status, body: json, raw };
}

// ---------------------------------------------------------------------------
// AUTHENTICATION
// ---------------------------------------------------------------------------
describe('GET /api/lost-reports/:id/matches requires an authenticated customer', () => {
  it('401 without a session cookie', async () => {
    expect((await getMatches(undefined, LR_A_MATCH)).status).toBe(401);
  });

  it('401 with a bogus session token', async () => {
    expect((await getMatches('z'.repeat(64), LR_A_MATCH)).status).toBe(401);
  });

  it('401 with an EXPIRED session', async () => {
    expect((await getMatches(TOKEN_EXPIRED, LR_A_MATCH)).status).toBe(401);
  });

  it('401 with a REVOKED session', async () => {
    expect((await getMatches(TOKEN_REVOKED, LR_A_MATCH)).status).toBe(401);
  });

  it('403 for a SUSPENDED account', async () => {
    expect((await getMatches(TOKEN_SUSPENDED, LR_A_MATCH)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// OWNERSHIP + ENUMERATION RESISTANCE
// ---------------------------------------------------------------------------
describe('a customer can only ever read matches for their OWN lost report', () => {
  it('customer B cannot read customer A\'s matches', async () => {
    const asOwner = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.matches.length).toBeGreaterThan(0);

    const asOther = await getMatches(TOKEN_B, LR_A_MATCH);
    expect(asOther.status).toBe(404);
  });

  it('and customer A cannot read customer B\'s matches either', async () => {
    expect((await getMatches(TOKEN_B, LR_B)).status).toBe(200);
    expect((await getMatches(TOKEN_A, LR_B)).status).toBe(404);
  });

  it('an unknown reference, a wrong-owner reference and a malformed reference are INDISTINGUISHABLE', async () => {
    const wrongOwner = await getMatches(TOKEN_B, LR_A_MATCH);
    const unknown = await getMatches(TOKEN_B, 'LR-ZZZZZZ');
    const malformed = await getMatches(TOKEN_B, 'not-a-reference');
    const tooShort = await getMatches(TOKEN_B, 'LR-12');

    for (const response of [wrongOwner, unknown, malformed, tooShort]) {
      expect(response.status).toBe(404);
    }
    // Byte-identical bodies: the endpoint is not a lost-report existence oracle.
    expect(wrongOwner.raw).toBe(unknown.raw);
    expect(unknown.raw).toBe(malformed.raw);
    expect(malformed.raw).toBe(tooShort.raw);
  });
});

// ---------------------------------------------------------------------------
// CANDIDATE GENERATION
// ---------------------------------------------------------------------------
const REASON_ALLOWLIST = [
  'same_category', 'matching_identifier', 'matching_document_type',
  'similar_location', 'similar_time', 'similar_brand', 'similar_model',
  'similar_colour', 'similar_material', 'similar_description',
];

describe('a possible match is produced when the evidence supports one', () => {
  it('returns the genuinely matching item, with cautious framing', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(res.status).toBe(200);

    expect(res.body.lost_report_id).toBe(LR_A_MATCH);
    expect(res.body.matches.map((m: any) => m.id)).toContain(ITEM_MATCH);

    // A candidate is never ownership.
    expect(res.body.ownership_confirmed).toBe(false);
    expect(res.body.notice).toBe('possible_matches_do_not_confirm_ownership');
    expect(res.body.disclosure.en).toContain('possible matches only');
    expect(res.body.disclosure.sw).toBeTruthy();
  });

  it('explains itself with allow-listed reasons only', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    const candidate = res.body.matches.find((m: any) => m.id === ITEM_MATCH);
    expect(Array.isArray(candidate.match_reasons)).toBe(true);
    expect(candidate.match_reasons).toContain('same_category');
    expect(candidate.match_reasons).toContain('similar_location');
    expect(candidate.match_reasons).toContain('similar_time');
    for (const reason of candidate.match_reasons) {
      expect(REASON_ALLOWLIST).toContain(reason);
    }
  });

  it('an exact protected-identifier agreement surfaces a candidate for a sensitive document', async () => {
    const res = await getMatches(TOKEN_A, LR_A_SENSITIVE);
    expect(res.status).toBe(200);
    expect(res.body.matches.map((m: any) => m.id)).toEqual([ITEM_SENSITIVE]);
    expect(res.body.matches[0].match_reasons).toContain('matching_identifier');
  });
});

describe('no candidate is produced when the evidence does not support one', () => {
  it('a category with no found items returns an empty list, not an error', async () => {
    const res = await getMatches(TOKEN_A, LR_A_NONE);
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
    expect(res.body.ownership_confirmed).toBe(false);
  });

  it('an item in a DIFFERENT county is never returned', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    const ids = res.body.matches.map((m: any) => m.id);
    expect(ids).not.toContain(ITEM_OTHER_COUNTY);
  });

  it('an item in a different CATEGORY is never returned', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(res.body.matches.map((m: any) => m.id)).not.toContain(ITEM_WRONG_CATEGORY);
  });

  it('EVERY existing item is refused when the reported loss post-dates them all', async () => {
    // The window is two days in the future, so every item was recorded before
    // the loss is claimed to have happened — a temporal contradiction.
    const res = await getMatches(TOKEN_A, LR_A_FUTURE);
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
  });
});

describe('only CURRENTLY CLAIMABLE items can ever be candidates', () => {
  it('an item still awaiting drop-off is excluded', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(res.body.matches.map((m: any) => m.id)).not.toContain(ITEM_AWAITING);
  });

  it('a flagged-for-review item is excluded', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(res.body.matches.map((m: any) => m.id)).not.toContain(ITEM_FLAGGED);
  });

  it('an already-claimed item is excluded', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(res.body.matches.map((m: any) => m.id)).not.toContain(ITEM_CLAIMED);
  });

  it('an item with an unresolved ownership dispute is excluded', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(res.body.matches.map((m: any) => m.id)).not.toContain(ITEM_DISPUTED);
  });
});

// ---------------------------------------------------------------------------
// PRIVACY
// ---------------------------------------------------------------------------
const FORBIDDEN_KEYS = [
  'finder_phone', 'finder_email', 'ocr_extracted_number', 'ocr_extracted_name',
  'document_number_hash', 'owner_phone', 'phone', 'email', 'latitude', 'longitude',
  'assigned_agent_id', 'agent', 'customer_id', 'score', 'signals', 'verified_document_number',
  // PHASE 9D — no geographic enrichment may reach this DTO. The found item's
  // explicit county, any distance, and any geocoding provider/precision/
  // confidence/provenance metadata are all internal to the server.
  'found_county', 'distance', 'distance_km', 'provider', 'precision', 'confidence',
  'provenance', 'geocoding', 'geocoded',
];

const SECRET_VALUES = [
  SECRET_FINDER_PHONE, SECRET_FINDER_EMAIL, SECRET_OCR_NUMBER, SECRET_OCR_NAME,
  SECRET_DESCRIPTION, SECRET_AGENT, HASH_SENSITIVE,
];

describe('match candidates leak nothing private', () => {
  it('never contains a finder contact, an identifier (plain or hashed), a coordinate, an agent or an internal id', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(res.status).toBe(200);
    expect(res.body.matches.length).toBeGreaterThan(0);

    for (const secret of SECRET_VALUES) {
      expect(res.raw, `payload leaked ${secret}`).not.toContain(secret);
    }
    for (const key of FORBIDDEN_KEYS) {
      expect(res.raw, `payload exposed key ${key}`).not.toContain(`"${key}"`);
    }
    for (const match of res.body.matches) {
      for (const key of FORBIDDEN_KEYS) {
        expect(match).not.toHaveProperty(key);
      }
    }
  });

  it('a sensitive-document candidate keeps its photo and description masked', async () => {
    const res = await getMatches(TOKEN_A, LR_A_SENSITIVE);
    const candidate = res.body.matches[0];
    expect(candidate.is_sensitive_document).toBe(true);
    // services/publicItemView.ts already nulls these for sensitive documents;
    // reusing that boundary means the matcher inherits the masking for free.
    expect(candidate.photo_url).toBeNull();
    expect(candidate.description).toBeNull();
    expect(res.raw).not.toContain(SECRET_DESCRIPTION);
    expect(res.raw).not.toContain('secret-national-id-photo.jpg');
  });

  it('exposes only the allow-listed candidate fields', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    for (const match of res.body.matches) {
      expect(Object.keys(match).sort()).toEqual([
        'category_id', 'description', 'document_name_fuzzy', 'found_at',
        'id', 'isDescriptionOnly', 'is_sensitive_document',
        'location_description', 'match_reasons', 'photo_url',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// CLAIM SEPARATION — a candidate is NOT a claim, an ownership check or a payment
// ---------------------------------------------------------------------------
describe('generating candidates does not touch the claim, payment or ownership systems', () => {
  it('creates NO claim anywhere, and leaves item and report state untouched', async () => {
    const claimsBefore = await db.getClaims();
    const itemBefore = await db.getItem(ITEM_MATCH);
    const reportBefore = await db.getLostReportByIdForCustomer(LR_A_MATCH, CUSTOMER_A);

    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(res.status).toBe(200);
    expect(res.body.matches.length).toBeGreaterThan(0);

    // System-wide claim count — not just this customer's — must be identical.
    const claimsAfter = await db.getClaims();
    expect(claimsAfter.length).toBe(claimsBefore.length);
    expect(claimsAfter.map((c: any) => c.id).sort()).toEqual(claimsBefore.map((c: any) => c.id).sort());

    // The found item is still exactly as claimable as it was.
    const itemAfter = await db.getItem(ITEM_MATCH);
    expect(itemAfter.status).toBe(itemBefore.status);
    expect(itemAfter.status).toBe('at_agent');

    // The lost report is still 'active' — a candidate never resolves a report.
    const reportAfter = await db.getLostReportByIdForCustomer(LR_A_MATCH, CUSTOMER_A);
    expect(reportAfter.status).toBe(reportBefore.status);
    expect(reportAfter.status).toBe('active');
  });

  it('the response asserts no ownership and carries no claim, recovery or payment field', async () => {
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(res.body.ownership_confirmed).toBe(false);
    for (const key of ['claim_id', 'claim', 'recovered', 'payment', 'payment_session', 'escrow']) {
      expect(res.body).not.toHaveProperty(key);
    }
  });

  it('the pre-existing disputed item and its claims are completely unaffected', async () => {
    await getMatches(TOKEN_A, LR_A_MATCH);
    const claim = await db.getClaim(CLAIM_DISPUTE_1);
    expect(claim.status).toBe('disputed');
    const disputes = await db.getDisputesByItem(ITEM_DISPUTED);
    expect(disputes.some((d: any) => d.id === DISPUTE_ID && !d.resolved_at)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLOSED REPORTS + RATE LIMITING
// ---------------------------------------------------------------------------
describe('a closed lost report stops producing candidates', () => {
  it('returns an empty list with an explicit notice (never a 404)', async () => {
    const res = await getMatches(TOKEN_A, LR_A_CANCELLED);
    expect(res.status).toBe(200);
    expect(res.body.lost_report_id).toBe(LR_A_CANCELLED);
    expect(res.body.matches).toEqual([]);
    expect(res.body.notice).toBe('lost_report_not_active');
    expect(res.body.ownership_confirmed).toBe(false);
  });
});

describe('match lookups are rate limited', () => {
  it('the customer-keyed limiter caps repeat lookups', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await getMatches(TOKEN_A, LR_A_MATCH, limitedBaseUrl)).status);
    }
    // max=2 in this harness: two succeed, the third is throttled.
    expect(statuses.slice(0, 2).every((s) => s === 200)).toBe(true);
    expect(statuses[2]).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// WORDING — the shipped copy must never overclaim
// ---------------------------------------------------------------------------
describe('the shipped wording is deliberately cautious', () => {
  const FORBIDDEN_CLAIMS = [
    'your item has been found', 'we found your item', 'we have found your item',
    'confirmed match', 'guaranteed', 'guaranteed recovery', 'ownership confirmed',
    'ownership is confirmed', 'your item is ready',
  ];

  it('the disclosure copy contains none of the overclaiming phrases', async () => {
    const view = await import('../services/lostReportMatchView');
    const copy = [
      view.POSSIBLE_MATCH_DISCLOSURE_EN,
      view.POSSIBLE_MATCH_DISCLOSURE_SW,
      view.POSSIBLE_MATCH_NOTICE,
      view.REPORT_NOT_ACTIVE_NOTICE,
    ].join(' ').toLowerCase();

    for (const phrase of FORBIDDEN_CLAIMS) {
      expect(copy, `copy overclaims: ${phrase}`).not.toContain(phrase);
    }
    expect(copy).toContain('possible');
    expect(copy).toContain('does not confirm ownership');
  });

  it('the endpoint serves exactly that copy (one source of truth)', async () => {
    const view = await import('../services/lostReportMatchView');
    const res = await getMatches(TOKEN_A, LR_A_MATCH);
    expect(res.body.disclosure.en).toBe(view.POSSIBLE_MATCH_DISCLOSURE_EN);
    expect(res.body.disclosure.sw).toBe(view.POSSIBLE_MATCH_DISCLOSURE_SW);
    expect(res.body.notice).toBe(view.POSSIBLE_MATCH_NOTICE);
  });
});

// ---------------------------------------------------------------------------
// WIRING
// ---------------------------------------------------------------------------
describe('the matcher is wired correctly and contains no unrelated machinery', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
  /** Only the import lines, so explanatory comments cannot create false hits. */
  const importLines = (source: string) =>
    source.split('\n').filter((line) => /^\s*import\b/.test(line)).join('\n').toLowerCase();

  it('server.ts injects the platform\'s central claimability rule', () => {
    expect(read('src/server.ts'))
      .toMatch(/registerLostReportRoutes\(app,\s*\{\s*sendServerError,\s*canCreateClaim\s*\}\)/);
  });

  it('the matches route is authenticated and rate-limited', () => {
    expect(read('src/routes/lostReports.ts'))
      .toMatch(/app\.get\('\/api\/lost-reports\/:id\/matches',\s*requireCustomerAuth,\s*lostReportMatchIpLimiter,\s*matchCustomerLimiter,/);
  });

  it('the ENGINE imports no AI provider, no embedding library and no payment/claim service', () => {
    const engineImports = importLines(read('src/services/lostReportMatching.ts'));
    for (const forbidden of [
      'genai', 'groq', 'openai', 'anthropic', 'embedding', 'tensorflow',
      'pinecone', 'supabase', 'payments', 'payments.ts', 'server.ts',
    ]) {
      expect(engineImports, `engine imports ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the ROUTE MODULE imports no payment service and touches no claim lifecycle', () => {
    const routeImports = importLines(read('src/routes/lostReports.ts'));
    for (const forbidden of ['payments', 'payments.ts', 'server.ts']) {
      expect(routeImports, `route imports ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the candidate view reuses the existing public item DTO and never spreads a raw row', () => {
    const viewTs = read('src/services/lostReportMatchView.ts');
    expect(viewTs).toContain("from './publicItemView.ts'");
    expect(viewTs).toContain('toPublicItemView');
    expect(viewTs).not.toMatch(/\.\.\.,?\s*(item|row)\b/);
  });

  it('the engine is deterministic and pure: no clock, no randomness, no I/O', () => {
    const engineTs = read('src/services/lostReportMatching.ts');
    expect(engineTs).not.toMatch(/Math\.random|Date\.now|new Date\(\)/);
    expect(engineTs).not.toMatch(/await |fetch\(|crypto\./);
  });
});








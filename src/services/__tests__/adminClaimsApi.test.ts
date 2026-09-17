import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import { db } from '../../db/database';
import { generateToken } from '../../services/auth';
import { registerAdminClaimRoutes } from '../../routes/adminClaims';
import { ensureTestCategory, testRunId } from '../../db/__tests__/ensureTestCategory';

// =============================================================================
// PHASE 6F — CLAIMS ADMIN UI API CLIENT
// =============================================================================
// The client is exercised against the REAL Phase 6E routes over real HTTP: the
// real express app, the real authenticateJWT, the real handlers. `fetch` is
// wrapped only to (a) prefix the relative path with the test server's origin —
// node's fetch requires an absolute URL — and (b) record the exact URL and
// headers so the query-parameter contract can be asserted directly.
//
// LIMITATION (documented, not hidden): this is the in-memory sandbox, so these
// tests prove the CLIENT's request construction, error classification and
// response parsing against the real handlers. They do not prove PostgreSQL
// ordering/LIMIT/OFFSET behaviour — that stays a real-Postgres requirement
// carried from Phases 6C/6D/6E.
const RUN = testRunId;
const ADMIN_USER = `test-6f-admin-${RUN}`;

let server: any;
let base = '';
let adminToken = '';
let ownerToken = '';
let counter = 0;

const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerAdminClaimRoutes(app, {
    requireCurrentAdminSession: (_req: any, _res: any, next: any) => next(),
    sendServerError: (res: any, error: any, _context: string) =>
      res.status(500).json({ error: error?.message || String(error) }),
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${server.address().port}`;

  adminToken = generateToken({ userId: 'ADM-6F', phone: '+254700000000', role: 'admin', username: ADMIN_USER } as any, '1h');
  ownerToken = generateToken({ userId: 'OWN-6F', phone: '+254700000009', role: 'owner' } as any, '1h');

  (globalThis as any).fetch = (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? `${base}${input}` : input;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', authorization: headers.Authorization ?? null });
    return realFetch(url, init);
  };
});

afterAll(async () => {
  (globalThis as any).fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  calls.length = 0;
});

// Imported AFTER the fetch wrapper is installed in beforeAll? No — the client
// calls globalThis.fetch at request time, so a static import is fine.
import {
  ADMIN_CLAIMS_PAGE_SIZE,
  ADMIN_CLAIMS_MAX_PAGE_SIZE,
  AdminClaimsApiError,
  buildClaimsListQuery,
  fetchAdminClaimDetail,
  fetchAdminClaimsList,
} from '../adminClaimsApi';

async function makeItem(suffix: string, category = 'phone') {
  const itemId = `TEST-ITEM-6F-${suffix}-${RUN}-${counter++}`;
  await ensureTestCategory(category);
  await db.createItem({
    id: itemId, category_id: category, photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: 'Fuzzy',
    location_description: 'Location', latitude: null, longitude: null,
    finder_phone: '+254700000042', assigned_agent_id: null, status: 'at_agent',
    flaggedForReview: false, isDescriptionOnly: false, description: 'desc',
    is_sensitive_document: false, rejection_reason: null, locked_total_fee: '500',
  } as any);
  return itemId;
}

async function makeClaim(itemId: string, suffix: string, status: string) {
  const claimId = `TEST-CLAIM-6F-${suffix}-${RUN}-${counter++}`;
  await db.createClaim({
    id: claimId, item_id: itemId,
    owner_phone: `+2547002${String(counter).padStart(5, '0')}`,
    security_answers: { lastDigits: '1111', color: 'red', lostDetails: 'SECRET-6F' },
    verification_tier: 2, status: status as any,
    owner_id_proof_url: 'SECRET-ID-PROOF-6F', payment_reference: null,
    owner_identifying_details: 'SECRET-IDENT-6F',
  } as any);
  return claimId;
}

// ---------------------------------------------------------------------------
// QUERY CONSTRUCTION
// ---------------------------------------------------------------------------
describe('6F buildClaimsListQuery', () => {
  it('encodes every value with URLSearchParams and omits empty ones', () => {
    const query = buildClaimsListQuery(
      { claimId: 'CLM 1&x=2', status: 'released', hasPaid: true, disputeState: 'open' },
      25,
      0,
    );
    const params = new URLSearchParams(query);
    // Values survive round-tripping intact — they cannot alter the request shape.
    expect(params.get('claimId')).toBe('CLM 1&x=2');
    expect(params.get('status')).toBe('released');
    expect(params.get('hasPaid')).toBe('true');
    expect(params.get('disputeState')).toBe('open');
    expect(params.get('limit')).toBe('25');
    expect(params.get('offset')).toBe('0');
    // No stray parameter was created by the injected '&x=2'.
    expect(params.get('x')).toBeNull();
    expect([...params.keys()]).toHaveLength(6);
  });

  it('omits unset, empty and whitespace-only filters', () => {
    const params = new URLSearchParams(buildClaimsListQuery({ claimId: '', itemId: '   ' }, 25, 0));
    expect(params.get('claimId')).toBeNull();
    expect(params.get('itemId')).toBeNull();
    expect(params.get('hasPaid')).toBeNull();
    expect([...params.keys()].sort()).toEqual(['limit', 'offset']);
  });

  it('serialises the payment filter strictly as true/false, never 1/0/yes', () => {
    expect(new URLSearchParams(buildClaimsListQuery({ hasPaid: false }, 25, 0)).get('hasPaid')).toBe('false');
    expect(new URLSearchParams(buildClaimsListQuery({ hasPaid: true }, 25, 0)).get('hasPaid')).toBe('true');
  });

  it('uses the documented page-size constants', () => {
    expect(ADMIN_CLAIMS_PAGE_SIZE).toBe(25);
    expect(ADMIN_CLAIMS_MAX_PAGE_SIZE).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// LIST — request shape + server-side filtering
// ---------------------------------------------------------------------------
describe('6F fetchAdminClaimsList', () => {
  it('GETs the 6E list endpoint with a bearer token and the expected window', async () => {
    await fetchAdminClaimsList(adminToken, { limit: 25, offset: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/admin/claims?');
    expect(calls[0].url).toContain('limit=25');
    expect(calls[0].url).toContain('offset=0');
    expect(calls[0].authorization).toBe(`Bearer ${adminToken}`);
  });

  it('applies filters SERVER-side (the returned rows honour them)', async () => {
    const itemId = await makeItem('FILTER');
    const claimId = await makeClaim(itemId, 'FILTER', 'pending_verification');

    const page = await fetchAdminClaimsList(adminToken, { filters: { itemId }, limit: 25, offset: 0 });
    expect(page.items.map((c) => c.id)).toEqual([claimId]);
    // The filter travelled on the wire, so the server did the filtering.
    expect(calls[0].url).toContain(`itemId=${itemId}`);

    const other = await fetchAdminClaimsList(adminToken, { filters: { itemId: 'NO-SUCH-ITEM-6F' } });
    expect(other.items).toEqual([]);
  });

  it('returns the server pagination envelope, including hasMore', async () => {
    const page = await fetchAdminClaimsList(adminToken, { limit: 1, offset: 0 });
    expect(page.pagination).toEqual({ limit: 1, offset: 0, hasMore: expect.any(Boolean) });
    expect(page.items.length).toBeLessThanOrEqual(1);
  });

  it('surfaces the masked claimant phone and never a raw one', async () => {
    const itemId = await makeItem('MASK');
    const claimId = await makeClaim(itemId, 'MASK', 'pending_verification');
    const rawPhone = (await db.getClaim(claimId))!.owner_phone;

    const page = await fetchAdminClaimsList(adminToken, { filters: { itemId } });
    const row = page.items.find((c) => c.id === claimId)!;
    expect(row.claimant_phone).not.toBe(rawPhone);
    expect(row.claimant_phone).toContain('***');
  });
});


// ---------------------------------------------------------------------------
// DETAIL
// ---------------------------------------------------------------------------
describe('6F fetchAdminClaimDetail', () => {
  it('requests exactly the selected claim id', async () => {
    const itemId = await makeItem('DETAIL');
    const claimId = await makeClaim(itemId, 'DETAIL', 'pending_verification');

    const claim = await fetchAdminClaimDetail(adminToken, claimId);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${base}/api/admin/claims/${claimId}`);
    expect(calls[0].method).toBe('GET');
    expect(claim.id).toBe(claimId);
    expect(claim.verification.tier).toBe(2);
    expect(claim.sibling_claims).toEqual([]);
  });

  it('percent-encodes the claim id in the path', async () => {
    await fetchAdminClaimDetail(adminToken, 'CLM/1 2').catch(() => undefined);
    expect(calls[0].url).toContain('CLM%2F1%202');
  });

  it('maps a missing claim to a typed not_found error', async () => {
    const err: any = await fetchAdminClaimDetail(adminToken, `NO-SUCH-6F-${RUN}`).catch((e) => e);
    expect(err).toBeInstanceOf(AdminClaimsApiError);
    expect(err.kind).toBe('not_found');
    expect(err.status).toBe(404);
  });

  it('maps a malformed id to a typed invalid error (400, not 404)', async () => {
    const err: any = await fetchAdminClaimDetail(adminToken, 'bad id!').catch((e) => e);
    expect(err.kind).toBe('invalid');
    expect(err.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// AUTHENTICATION / AUTHORIZATION SURFACES
// ---------------------------------------------------------------------------
describe('6F auth failure classification', () => {
  it('a missing session is classified unauthorized (401)', async () => {
    const err: any = await fetchAdminClaimsList(null).catch((e) => e);
    expect(err.kind).toBe('unauthorized');
    expect(err.status).toBe(401);
    expect(calls[0].authorization).toBeNull();
  });

  it('a non-admin session is classified forbidden (403), not not_found', async () => {
    const err: any = await fetchAdminClaimsList(ownerToken).catch((e) => e);
    expect(err.kind).toBe('forbidden');
    expect(err.status).toBe(403);
  });

  it('no error message leaks internals', async () => {
    for (const token of [null, ownerToken]) {
      const err: any = await fetchAdminClaimsList(token).catch((e) => e);
      expect(err).toBeInstanceOf(AdminClaimsApiError);
      expect(typeof err.message).toBe('string');
      expect(err.message).not.toMatch(/at \w+ \(|node_modules|SELECT | FROM |stack|password/i);
    }
  });
});


// ---------------------------------------------------------------------------
// SERVER FAILURE
// ---------------------------------------------------------------------------
describe('6F server failure', () => {
  it('classifies a 500 as a server error and never as an empty success', async () => {
    const original = db.listAdminClaims.bind(db);
    try {
      (db as any).listAdminClaims = async () => { throw new Error('simulated failure'); };
      const err: any = await fetchAdminClaimsList(adminToken).catch((e) => e);
      expect(err).toBeInstanceOf(AdminClaimsApiError);
      expect(err.kind).toBe('server');
      expect(err.status).toBe(500);
      // It threw; it did not resolve with empty items.
      expect(err.items).toBeUndefined();
    } finally {
      (db as any).listAdminClaims = original;
    }
  });

  it('classifies an unreachable service as a network error', async () => {
    const saved = (globalThis as any).fetch;
    (globalThis as any).fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    try {
      const err: any = await fetchAdminClaimsList(adminToken).catch((e) => e);
      expect(err.kind).toBe('network');
      expect(err.status).toBe(0);
    } finally {
      (globalThis as any).fetch = saved;
    }
  });

  it('a genuinely unreadable body is a server error, not empty data', async () => {
    const saved = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => new Response('not json', { status: 200 });
    try {
      const err: any = await fetchAdminClaimsList(adminToken).catch((e) => e);
      expect(err.kind).toBe('server');
    } finally {
      (globalThis as any).fetch = saved;
    }
  });

  it('an abort is classified as aborted so the UI can stay silent', async () => {
    const controller = new AbortController();
    const promise = fetchAdminClaimsList(adminToken, { signal: controller.signal }).catch((e) => e);
    controller.abort();
    const err: any = await promise;
    expect(err).toBeInstanceOf(AdminClaimsApiError);
    expect(err.isAbort).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PRIVACY BOUNDARY OF THE PARSED PAYLOAD
// ---------------------------------------------------------------------------
describe('6F privacy of the parsed payload', () => {
  it('the list and detail payloads contain no prohibited field or value', async () => {
    const itemId = await makeItem('PRIV');
    const claimId = await makeClaim(itemId, 'PRIV', 'pending_verification');
    await db.setClaimOtp(claimId, 'otp-hash-6f', new Date(Date.now() + 60000));

    const page = await fetchAdminClaimsList(adminToken, { filters: { itemId } });
    const claim = await fetchAdminClaimDetail(adminToken, claimId);
    const serialized = JSON.stringify({ page, claim });

    for (const forbidden of [
      'payment_reference', 'security_answers', 'owner_id_proof_url', 'owner_identifying_details',
      'owner_email', 'SECRET-6F', 'SECRET-ID-PROOF-6F', 'SECRET-IDENT-6F', 'otp-hash-6f',
      'code_hash', 'token_hash', 'session', 'password', 'http://', 'https://',
    ]) {
      expect(serialized, `client payload leaked: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the parsed shapes are exactly the declared DTO fields — nothing more', async () => {
    const itemId = await makeItem('TYPES');
    const claimId = await makeClaim(itemId, 'TYPES', 'pending_verification');

    const page = await fetchAdminClaimsList(adminToken, { filters: { itemId } });
    expect(Object.keys(page.items[0]).sort()).toEqual([
      'agent', 'agent_confirmed_at', 'claimant_phone', 'created_at', 'dispute',
      'financial_state', 'has_paid', 'id', 'is_active', 'item', 'paid_at',
      'payment_state', 'status', 'updated_at', 'verification_tier',
    ]);

    const detail = await fetchAdminClaimDetail(adminToken, claimId);
    expect(Object.keys(detail).sort()).toEqual([
      'agent', 'agent_confirmed_at', 'claimant_phone', 'created_at', 'dispute',
      'financial_state', 'has_paid', 'id', 'is_active', 'item', 'paid_at',
      'payment_state', 'settlement', 'sibling_claims', 'status', 'updated_at',
      'verification',
    ]);
  });
});

// EOF

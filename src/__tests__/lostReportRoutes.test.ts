import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';
import { registerLostReportRoutes } from '../routes/lostReports';
import { createLostReportCustomerLimiter } from '../config/lostReportLimiter';
import { administrativeUnitsForCounty } from '../config/kenyaAdministrativeUnits';

// ---------------------------------------------------------------------------
// Phase 9A — HTTP INTEGRATION TESTS for POST/GET /api/lost-reports.
//
// These mount a REAL Express app around the REAL requireCustomerAuth middleware
// and the REAL route handlers, then drive them over an actual TCP socket with
// fetch(). That is the smallest harness that can actually prove the boundary:
// assertions against source text alone cannot demonstrate that an unauthenticated
// request is rejected, that a customer cannot read another customer's report, or
// that the rate limiter caps a flood.
//
// server.ts itself is deliberately NOT imported — it calls startServer() at
// import time (Vite middleware, background sweeps, listeners). routes/
// lostReports.ts exists precisely so the real handlers can be mounted in
// isolation (same pattern as customerClaimRoutes.test.ts).
// ---------------------------------------------------------------------------

const RUN = testRunId;
const base = Math.floor(10000000 + Math.random() * 89999999);
const phone = (offset: number) => '+2547' + String(base + offset).slice(-8);

const PHONE_A = phone(0);
const PHONE_B = phone(1);
const PHONE_SUSPENDED = phone(2);

const CUSTOMER_A = `TEST-9A-CUS-A-${RUN}`;
const CUSTOMER_B = `TEST-9A-CUS-B-${RUN}`;
const CUSTOMER_SUSPENDED = `TEST-9A-CUS-S-${RUN}`;

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_SUSPENDED = 'c'.repeat(64);
const TOKEN_EXPIRED = 'e'.repeat(64);
const TOKEN_REVOKED = 'f'.repeat(64);

const SESSION_A = `TEST-9A-SESS-A-${RUN}`;
const SESSION_B = `TEST-9A-SESS-B-${RUN}`;
const SESSION_SUSPENDED = `TEST-9A-SESS-S-${RUN}`;
const SESSION_EXPIRED = `TEST-9A-SESS-E-${RUN}`;
const SESSION_REVOKED = `TEST-9A-SESS-R-${RUN}`;

// A dedicated account used only to prove that REJECTED payloads persist nothing.
const CUSTOMER_REJECT = `TEST-9A-CUS-R-${RUN}`;
const TOKEN_REJECT = '9'.repeat(64);
const SESSION_REJECT = `TEST-9A-SESS-R-${RUN}`;

const SECRET_DOC_NUMBER = `ID${String(Math.floor(1000000 + Math.random() * 8999999))}`;

let server: any;
let limitedServer: any;
let baseUrl = '';
let limitedBaseUrl = '';

async function seed() {
  await db.createCustomer(CUSTOMER_A, 'Asha Mwangi', PHONE_A);
  await db.createCustomer(CUSTOMER_B, 'Brian Otieno', PHONE_B);
  await db.createCustomer(CUSTOMER_SUSPENDED, 'Suspended User', PHONE_SUSPENDED);
  await db.createCustomer(CUSTOMER_REJECT, 'Reject Fixture', phone(3));
  await db.updateCustomerStatus(CUSTOMER_SUSPENDED, 'suspended');

  const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.createCustomerSession(SESSION_A, CUSTOMER_A, hashCode(TOKEN_A), in7Days);
  await db.createCustomerSession(SESSION_B, CUSTOMER_B, hashCode(TOKEN_B), in7Days);
  await db.createCustomerSession(SESSION_SUSPENDED, CUSTOMER_SUSPENDED, hashCode(TOKEN_SUSPENDED), in7Days);
  await db.createCustomerSession(SESSION_EXPIRED, CUSTOMER_A, hashCode(TOKEN_EXPIRED), new Date(Date.now() - 1000));
  await db.createCustomerSession(SESSION_REVOKED, CUSTOMER_A, hashCode(TOKEN_REVOKED), in7Days);
  await db.revokeCustomerSession(SESSION_REVOKED);
  await db.createCustomerSession(SESSION_REJECT, CUSTOMER_REJECT, hashCode(TOKEN_REJECT), in7Days);

  await ensureTestCategory('national-id');
}

beforeAll(async () => {
  await seed();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerLostReportRoutes(app, {
    // server.ts's sendServerError, non-production branch.
    sendServerError: (res: any, error: any, context: string) => {
      console.error(`[${context}]`, error);
      res.status(500).json({ error: error?.message || String(error) });
    },
    canCreateClaim: testCanCreateClaim,
  });

  // A SECOND app whose customer-keyed limiter has a small threshold, so the
  // rate-limit mechanics can be driven past their cap over real HTTP without
  // 1000 requests. Production mounts the shipped default instance.
  const limitedApp = express();
  limitedApp.use(express.json({ limit: '1mb' }));
  registerLostReportRoutes(limitedApp, {
    sendServerError: (res: any, error: any) => res.status(500).json({ error: String(error) }),
    canCreateClaim: testCanCreateClaim,
    customerRateLimiter: createLostReportCustomerLimiter({ max: 3, windowMs: 60 * 1000 }),
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

function cookie(token: string) {
  return { cookie: 'r4m_customer_session=' + token };
}

async function api(method: string, urlPath: string, token?: string, body?: any, root = '') {
  const headers: Record<string, string> = {};
  if (token) Object.assign(headers, cookie(token));
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch((root || baseUrl) + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { json = null; }
  return { status: res.status, body: json, raw };
}

/** A valid creation payload. Individual tests override one field at a time. */
function validPayload(overrides: Record<string, any> = {}) {
  const county = overrides.county || 'Nairobi City';
  return {
    categoryId: 'national-id',
    county,
    administrativeUnitId: administrativeUnitsForCounty(county)[0]?.id,
    locationArea: 'Westlands',
    locationLandmark: 'Near Sarit Centre',
    lostAtFrom: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    lostAtTo: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    colour: 'Brown',
    description: 'Brown leather wallet with a national ID inside',
    distinctiveMarks: 'Small tear on the left seam',
    documentType: 'national-id',
    ...overrides,
    };
}

function reportsFor(customerId: string) {
  return db.getLostReportsByCustomer(customerId);
}

/**
 * Mirrors server.ts's central canCreateClaim rule (status 'at_agent', not
 * flagged for review, no unresolved dispute). The 9A suite creates no items, so
 * this only has to be a faithful stand-in for the injected dependency; the
 * Phase 9B suite exercises the real eligibility behaviour.
 */
async function testCanCreateClaim(item: any, preFetchedDisputes?: any[]) {
  if (!item) return { allowed: false, reason: 'not_found' };
  if (item.status !== 'at_agent') return { allowed: false, reason: 'not_physically_verified' };
  if (item.flaggedForReview) return { allowed: false, reason: 'flagged_for_review' };
  const disputes = preFetchedDisputes ?? [];
  if (disputes.some((d: any) => !d.resolved_at)) return { allowed: false, reason: 'unresolved_dispute' };
  return { allowed: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// CREATION
// ---------------------------------------------------------------------------
describe('POST /api/lost-reports: creation', () => {
  it('creates a valid lost report and returns only the minimal acknowledgement', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload());
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.reference).toMatch(/^LR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(res.body.status).toBe('active');
    expect(typeof res.body.created_at).toBe('string');
    expect(new Date(res.body.created_at).getTime()).not.toBeNaN();
  });

  it('the created report is actually persisted and bound to the authenticated customer', async () => {
    const before = (await reportsFor(CUSTOMER_A)).length;
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ colour: 'Green' }));
    expect(res.status).toBe(201);

    const after = await reportsFor(CUSTOMER_A);
    expect(after.length).toBe(before + 1);
    const stored = after.find((r) => r.id === res.body.reference);
    expect(stored).toBeDefined();
    expect(stored!.customer_id).toBe(CUSTOMER_A);
    expect(stored!.category_id).toBe('national-id');
    expect(stored!.status).toBe('active');
    expect(stored!.colour).toBe('Green');
  });

  it('stores a time WINDOW ("between 2pm and 5pm") rather than an exact instant', async () => {
    const from = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ lostAtFrom: from, lostAtTo: to }));
    expect(res.status).toBe(201);

    const stored = (await reportsFor(CUSTOMER_A)).find((r) => r.id === res.body.reference)!;
    expect(new Date(stored.lost_at_from).toISOString()).toBe(from);
    expect(new Date(stored.lost_at_to!).toISOString()).toBe(to);
  });

  it('accepts a report with no lostAtTo (the reporter only knows roughly when)', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A,
      validPayload({ lostAtTo: undefined, county: 'Kisumu' }));
    expect(res.status).toBe(201);
    const stored = (await reportsFor(CUSTOMER_A)).find((r) => r.id === res.body.reference)!;
    expect(stored.lost_at_to == null).toBe(true);
    expect(stored.county).toBe('Kisumu');
  });

  it('canonicalizes an alias county to its official name', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ county: 'nairobi', administrativeUnitId: 'KE-47-SC-01' }));
    expect(res.status).toBe(201);
    const stored = (await reportsFor(CUSTOMER_A)).find((r) => r.id === res.body.reference)!;
    expect(stored.county).toBe('Nairobi City');
  });
});

// ---------------------------------------------------------------------------
// SERVER-SIDE VALIDATION (the frontend is never trusted)
// ---------------------------------------------------------------------------
describe('POST /api/lost-reports: validation', () => {
  it('rejects a category that does not exist', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ categoryId: 'not-a-real-category' }));
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects a missing category', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ categoryId: '' }));
    expect(res.status).toBe(400);
  });

  it('rejects a county that is not a Kenyan county', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ county: 'Atlantis' }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing location area', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ locationArea: '' }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing lostAtFrom', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ lostAtFrom: undefined }));
    expect(res.status).toBe(400);
  });

  it('rejects an unparseable lostAtFrom', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ lostAtFrom: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('rejects an inverted time window (lostAtTo before lostAtFrom)', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({
      lostAtFrom: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lostAtTo: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    }));
    expect(res.status).toBe(400);
  });

  it('rejects an implausibly long time window (over 31 days)', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({
      lostAtFrom: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString(),
      lostAtTo: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    expect(res.status).toBe(400);
  });

  it('rejects a lostAtFrom far in the future', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({
      lostAtFrom: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    expect(res.status).toBe(400);
  });

  it('rejects an oversized description', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ description: 'x'.repeat(1001) }));
    expect(res.status).toBe(400);
  });

  it('rejects an oversized distinctive-marks field', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ distinctiveMarks: 'y'.repeat(501) }));
    expect(res.status).toBe(400);
  });

  it('rejects a wrong-typed numeric field rather than coercing it', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ colour: 12345 }));
    expect(res.status).toBe(400);
  });

  it('rejects a control character smuggled into free text', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ description: 'ok\u0007bad' }));
    expect(res.status).toBe(400);
  });

  it('rejects a too-short document number instead of silently dropping it', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ documentNumber: 'AB' }));
    expect(res.status).toBe(400);
  });

  it('rejects an impossible payload (a JSON array rather than an object)', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, [1, 2, 3] as any);
    expect(res.status).toBe(400);
  });

  it('NEVER persists anything for a rejected payload', async () => {
    const before = (await reportsFor(CUSTOMER_REJECT)).length;

    const rejected = [
      validPayload({ categoryId: 'not-a-real-category' }),
      validPayload({ county: 'Atlantis' }),
      validPayload({ locationArea: '' }),
      validPayload({ lostAtFrom: 'not-a-date' }),
      validPayload({ description: 'x'.repeat(1001) }),
      validPayload({ customerId: CUSTOMER_A }),
    ];
    for (const payload of rejected) {
      const res = await api('POST', '/api/lost-reports', TOKEN_REJECT, payload);
      expect(res.status).toBe(400);
    }

    expect((await reportsFor(CUSTOMER_REJECT)).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// AUTHORIZATION
// ---------------------------------------------------------------------------
describe('POST /api/lost-reports: authentication is required', () => {
  it('rejects an unauthenticated request (no cookie) with 401', async () => {
    const res = await api('POST', '/api/lost-reports', undefined, validPayload());
    expect(res.status).toBe(401);
  });

  it('rejects a bogus session token with 401', async () => {
    const res = await api('POST', '/api/lost-reports', 'z'.repeat(64), validPayload());
    expect(res.status).toBe(401);
  });

  it('rejects an EXPIRED session with 401', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_EXPIRED, validPayload());
    expect(res.status).toBe(401);
  });

  it('rejects a REVOKED session with 401', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_REVOKED, validPayload());
    expect(res.status).toBe(401);
  });

  it('rejects a SUSPENDED account with 403 and persists nothing', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_SUSPENDED, validPayload());
    expect(res.status).toBe(403);
    expect((await reportsFor(CUSTOMER_SUSPENDED)).length).toBe(0);
  });

  it('the GET routes require authentication too', async () => {
    expect((await api('GET', '/api/lost-reports', undefined)).status).toBe(401);
    expect((await api('GET', '/api/lost-reports/LR-ABCDEF', undefined)).status).toBe(401);
  });
});

describe('POST /api/lost-reports: identity is derived server-side', () => {
  it('REJECTS a client-supplied customerId instead of honouring it', async () => {
    const beforeB = (await reportsFor(CUSTOMER_B)).length;
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ customerId: CUSTOMER_B }));
    expect(res.status).toBe(400);
    // Nothing was written for the impersonated account...
    expect((await reportsFor(CUSTOMER_B)).length).toBe(beforeB);
  });

  it('REJECTS a client-supplied customer_id (snake_case variant) too', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ customer_id: CUSTOMER_B }));
    expect(res.status).toBe(400);
  });

  it('binds the report to the SESSION owner, not to anything in the payload', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_B, validPayload({ county: 'Mombasa' }));
    expect(res.status).toBe(201);

    const stored = await db.getLostReportByIdForCustomer(res.body.reference, CUSTOMER_B);
    expect(stored).toBeDefined();
    expect(stored!.customer_id).toBe(CUSTOMER_B);
    // ...and NOT to the account the payload might have hinted at.
    expect(await db.getLostReportByIdForCustomer(res.body.reference, CUSTOMER_A)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PRIVACY BOUNDARY
// ---------------------------------------------------------------------------
describe('lost reports: the response DTO exposes nothing private', () => {
  const FORBIDDEN_KEYS = [
    'customer_id', 'document_number_hash', 'owner_phone', 'phone', 'email',
    'full_name', 'token_hash', 'code_hash',
  ];

  it('the creation response carries only success/reference/status/created_at', async () => {
    const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ documentNumber: SECRET_DOC_NUMBER }));
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['created_at', 'reference', 'status', 'success']);
    for (const key of FORBIDDEN_KEYS) expect(res.body).not.toHaveProperty(key);
    // The protected identifier must not leak in ANY form.
    expect(res.raw).not.toContain(SECRET_DOC_NUMBER);
    expect(res.raw.toLowerCase()).not.toContain('hash');
  });

  it('the owner-scoped list view exposes has_document_number, never the hash or account id', async () => {
    const res = await api('GET', '/api/lost-reports', TOKEN_A);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.lost_reports)).toBe(true);
    expect(res.body.lost_reports.length).toBeGreaterThan(0);

    for (const report of res.body.lost_reports) {
      for (const key of FORBIDDEN_KEYS) expect(report).not.toHaveProperty(key);
      expect(typeof report.has_document_number).toBe('boolean');
      expect(report).not.toHaveProperty('document_number');
    }
    expect(res.raw).not.toContain(SECRET_DOC_NUMBER);
  });

  it('the detail view exposes the owner their own private text but no protected identifier', async () => {
    const created = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({
      description: `UniquePrivateText${RUN}`,
      documentNumber: SECRET_DOC_NUMBER,
    }));
    expect(created.status).toBe(201);

    const res = await api('GET', `/api/lost-reports/${created.body.reference}`, TOKEN_A);
    expect(res.status).toBe(200);
    expect(res.body.lost_report.description).toBe(`UniquePrivateText${RUN}`);
    expect(res.body.lost_report.has_document_number).toBe(true);
    for (const key of FORBIDDEN_KEYS) expect(res.body.lost_report).not.toHaveProperty(key);
    expect(res.raw).not.toContain(SECRET_DOC_NUMBER);
  });
});

// ---------------------------------------------------------------------------
// RETRIEVAL + ENUMERATION RESISTANCE
// ---------------------------------------------------------------------------
describe('GET /api/lost-reports: owner-scoped retrieval', () => {
  it('lists ONLY the caller\'s own reports', async () => {
    const created = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ county: 'Nakuru' }));
    expect(created.status).toBe(201);

    const listA = await api('GET', '/api/lost-reports', TOKEN_A);
    const idsA = listA.body.lost_reports.map((r: any) => r.id);
    expect(idsA).toContain(created.body.reference);

    // The same reference must not appear in B's list, and B's list must
    // contain only B's own reports.
    const listB = await api('GET', '/api/lost-reports', TOKEN_B);
    const idsB = listB.body.lost_reports.map((r: any) => r.id);
    expect(idsB).not.toContain(created.body.reference);
    const bOwned = await reportsFor(CUSTOMER_B);
    for (const id of idsB) expect(bOwned.some((r) => r.id === id)).toBe(true);
    expect(idsB.length).toBe(bOwned.length);
  });

  it('a customer CANNOT read another customer\'s report by supplying its reference', async () => {
    const created = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ county: 'Uasin Gishu' }));
    expect(created.status).toBe(201);

    const asOwner = await api('GET', `/api/lost-reports/${created.body.reference}`, TOKEN_A);
    expect(asOwner.status).toBe(200);

    const asOther = await api('GET', `/api/lost-reports/${created.body.reference}`, TOKEN_B);
    expect(asOther.status).toBe(404);
  });

  it('a well-formed but unknown reference and a wrong-owner reference are INDISTINGUISHABLE', async () => {
    const created = await api('POST', '/api/lost-reports', TOKEN_A, validPayload());
    const asOther = await api('GET', `/api/lost-reports/${created.body.reference}`, TOKEN_B);
    const unknown = await api('GET', '/api/lost-reports/LR-QWERTY', TOKEN_B);
    expect(asOther.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Identical body — the endpoint is not an existence oracle.
    expect(asOther.raw).toBe(unknown.raw);
  });

  it('rejects a malformed reference shape with the same 404 (no distinct error to probe)', async () => {
    for (const bad of ['not-a-reference', 'LR-12', 'CLM-123456', 'LR-000000']) {
      const res = await api('GET', `/api/lost-reports/${bad}`, TOKEN_A);
      expect(res.status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// RATE LIMITING
// ---------------------------------------------------------------------------
describe('POST /api/lost-reports: cannot be spammed indefinitely', () => {
  it('the customer-keyed limiter caps a flood, and throttled requests persist nothing', async () => {
    const before = (await reportsFor(CUSTOMER_A)).length;

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await api('POST', '/api/lost-reports', TOKEN_A, validPayload({ colour: `Flood${i}` }), limitedBaseUrl);
      statuses.push(res.status);
    }

    // max=3 in this harness: the first three succeed, the fourth is throttled.
    expect(statuses.slice(0, 3).every((s) => s === 201)).toBe(true);
    expect(statuses[3]).toBe(429);

    // Exactly three persisted — the throttled request wrote nothing.
    expect((await reportsFor(CUSTOMER_A)).length).toBe(before + 3);
  });
});

// ---------------------------------------------------------------------------
// WIRING (the shipped instances are the ones mounted)
// ---------------------------------------------------------------------------
describe('lost-report routes are registered and rate-limited in the shipped app', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverTs = fs.readFileSync(path.resolve(repoRoot, 'src/server.ts'), 'utf8');
  const routesTs = fs.readFileSync(path.resolve(repoRoot, 'src/routes/lostReports.ts'), 'utf8');
  const limiterTs = fs.readFileSync(path.resolve(repoRoot, 'src/config/lostReportLimiter.ts'), 'utf8');

  it('server.ts registers the routes and passes its own sendServerError', () => {
    expect(serverTs).toContain("import { registerLostReportRoutes } from './routes/lostReports';");
    // Phase 9B added a second injected dependency (canCreateClaim, the central
    // claimability rule the matcher must share with the public surfaces);
    // sendServerError is still passed through from server.ts.
    expect(serverTs).toMatch(/registerLostReportRoutes\(app,\s*\{\s*sendServerError,\s*canCreateClaim\s*\}\)/);
  });

  it('the create route mounts the IP limiter, auth, then the customer limiter, in that order', () => {
    expect(routesTs).toMatch(
      /app\.post\('\/api\/lost-reports',\s*ipLimiter,\s*requireCustomerAuth,\s*customerLimiter,/,
    );
  });

  it('the route module uses the SHIPPED limiter instances by default', () => {
    expect(routesTs).toContain('deps.ipRateLimiter ?? lostReportIpLimiter');
    expect(routesTs).toContain('deps.customerRateLimiter ?? lostReportCustomerLimiter');
  });

  it('the limiter policy module defines both buckets and their default instances', () => {
    expect(limiterTs).toContain('createLostReportIpLimiter');
    expect(limiterTs).toContain('createLostReportCustomerLimiter');
    expect(limiterTs).toMatch(/export const lostReportIpLimiter = createLostReportIpLimiter\(\)/);
    expect(limiterTs).toMatch(/export const lostReportCustomerLimiter = createLostReportCustomerLimiter\(\)/);
    // Production caps must be finite and modest.
    expect(limiterTs).toMatch(/LOST_REPORT_IP_MAX = process\.env\.NODE_ENV === 'production' \? \d+ : \d+/);
    expect(limiterTs).toMatch(/LOST_REPORT_CUSTOMER_MAX = process\.env\.NODE_ENV === 'production' \? \d+ : \d+/);
  });

  it('the GET routes are registered as owner-scoped (requireCustomerAuth on both)', () => {
    expect(routesTs).toMatch(/app\.get\('\/api\/lost-reports',\s*requireCustomerAuth,/);
    expect(routesTs).toMatch(/app\.get\('\/api\/lost-reports\/:id',\s*requireCustomerAuth,/);
  });
});







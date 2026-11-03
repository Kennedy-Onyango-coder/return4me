import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { generateToken } from '../services/auth';
import { registerAdminLostReportRoutes } from '../routes/adminLostReports';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';
import { FOUND_COUNTY_MESSAGES } from '../services/foundItemCounty';

// =============================================================================
// PHASE 11A (WP-2) — ADMIN LOST-REPORT ENDPOINT
// =============================================================================
// Real Express + the REAL authenticateJWT + the REAL route handler, over a real
// TCP socket. Source-text assertions cannot demonstrate that an unauthenticated
// request is refused, that a customer is refused, or that the DTO never carries
// the protected identifier hash — this harness can.
//
// server.ts is deliberately NOT imported (it calls startServer() at import
// time). `requireCurrentAdminSession` is a pass-through stand-in, exactly as in
// adminClaimsEndpoints.test.ts and disputeWorkflow.test.ts, because it is
// defined inside server.ts; its own behaviour is covered by
// adminSessionRevocation.test.ts. The inline `role !== 'admin'` check inside the
// route remains fully in force and is exercised below.
const RUN = testRunId;
const ADMIN_USER = `test-lost-admin-${RUN}`;
const ADMIN_ID = `ADM-11A-${RUN}`;
const CUSTOMER_ID = `TEST-11A-CUS-${RUN}`;

/** Reads a repository file, for the source-level assertions in this suite. */
const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

/** Sentinel values that must NEVER appear in an admin response body. */
const S = {
  documentNumberHash: 'SECRET-DOC-HASH-11A-VALUE',
  customerId: CUSTOMER_ID,
  description: 'SECRET-DESCRIPTION-11A-VALUE',
  distinctiveMarks: 'SECRET-DISTINCTIVE-11A-VALUE',
  brand: 'SECRET-BRAND-11A-VALUE',
  colour: 'SECRET-COLOUR-11A-VALUE',
  token: 'SECRET-TOKEN-11A-VALUE',
  otp: 'SECRET-OTP-11A-VALUE',
  payment: 'SECRET-PAYMENT-11A-VALUE',
};

let server: any;
let baseUrl = '';
let adminToken = '';
let ownerToken = '';
let pending2faToken = '';

const passSession = (_req: any, _res: any, next: any) => next();

async function api(method: string, urlPath: string, token?: string, body?: any) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let body2: any = null;
  try { body2 = JSON.parse(raw); } catch { body2 = null; }
  return { status: res.status, body: body2, raw };
}

let counter = 0;

/**
 * A lost report owned by the shared test customer. IDs are prefixed TEST- and
 * suffixed with the per-run id, matching the repository's established fixture
 * convention (ensureTestCategory's own rationale) so a run against a persistent
 * local Postgres cannot collide.
 */
async function makeLostReport(suffix: string, overrides: Record<string, any> = {}) {
  const id = `TEST-LR-11A-${suffix}-${RUN}-${counter++}`;
  await db.createLostReport({
    id,
    customer_id: CUSTOMER_ID,
    category_id: 'national-id',
    status: 'active',
    county: 'Nairobi',
    location_area: 'Westlands',
    location_landmark: 'Near Sarit Centre',
    lost_at_from: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    lost_at_to: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    brand: S.brand,
    model: null,
    colour: S.colour,
    material: null,
    description: S.description,
    distinctive_marks: S.distinctiveMarks,
    document_type: 'national-id',
    document_number_hash: S.documentNumberHash,
    ...overrides,
  } as any);
  return id;
}

/** A minimal stand-in for server.ts's central claimability rule (injected there). */
async function testCanCreateClaim(item: any): Promise<{ allowed: boolean; reason: string }> {
  if (item?.status !== 'at_agent') return { allowed: false, reason: 'not_claimable' };
  return { allowed: true, reason: 'ok' };
}

beforeAll(async () => {
  await ensureTestCategory('national-id');

  const app = express();
  app.use(express.json());
  registerAdminLostReportRoutes(app, {
    requireCurrentAdminSession: passSession,
    sendServerError: (res: any, error: any, context: string) => {
      console.error(`[${context}]`, error);
      res.status(500).json({ error: error?.message || String(error) });
    },
    canCreateClaim: testCanCreateClaim as any,
  });

  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = generateToken(
    { userId: ADMIN_ID, phone: '+254700000000', role: 'admin', username: ADMIN_USER } as any,
    '1h',
  );
  ownerToken = generateToken(
    { userId: 'TEST-11A-OWNER', phone: '+254700000009', role: 'owner' } as any,
    '1h',
  );
  pending2faToken = generateToken(
    { userId: ADMIN_ID, phone: '+254700000000', role: 'admin_pending_2fa', username: ADMIN_USER } as any,
    '5m',
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// AUTHENTICATION + AUTHORIZATION
// ---------------------------------------------------------------------------
describe('11A admin lost-reports: access control', () => {
  it('no Authorization header -> 401', async () => {
    const res = await api('GET', '/api/admin/lost-reports');
    expect(res.status).toBe(401);
  });

  it('a present-but-invalid token is rejected (repository convention: 403)', async () => {
    expect((await api('GET', '/api/admin/lost-reports', `${adminToken}x`)).status).toBe(403);
    expect((await api('GET', '/api/admin/lost-reports', 'not-a-jwt')).status).toBe(403);
  });

  it('an admin_pending_2fa token is rejected', async () => {
    expect((await api('GET', '/api/admin/lost-reports', pending2faToken)).status).toBe(403);
  });

  it('an authenticated NON-admin (customer/owner) is refused with 403', async () => {
    const res = await api('GET', '/api/admin/lost-reports', ownerToken);
    expect(res.status).toBe(403);
    // No report data whatsoever reaches a rejected caller.
    expect(res.raw).not.toContain('TEST-LR-11A');
    expect(res.raw).not.toContain(S.documentNumberHash);
  });

  it('a valid admin token is allowed', async () => {
    const res = await api('GET', '/api/admin/lost-reports?limit=1', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('the COLLECTION path serves GET only — no mutation verb is routed there', async () => {
    // PHASE 16.1 (BATCH 1): the one admin lost-report write is a per-report
    // sub-resource (PATCH /api/admin/lost-reports/:id/classify), covered by its
    // own suite below. Nothing is routable against the collection itself.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await api(method, '/api/admin/lost-reports', adminToken);
      expect(res.status, `${method} must not be served`).toBeGreaterThanOrEqual(400);
    }
  });
});

// ---------------------------------------------------------------------------
// QUERY BOUNDS
// ---------------------------------------------------------------------------
describe('11A admin lost-reports: bounded retrieval', () => {
  it('accepts a bounded page and echoes its pagination', async () => {
    const res = await api('GET', '/api/admin/lost-reports?limit=5&offset=0', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(5);
    expect(res.body.pagination.offset).toBe(0);
    expect(typeof res.body.pagination.hasMore).toBe('boolean');
  });

  it('applies the documented default when no limit is supplied', async () => {
    const res = await api('GET', '/api/admin/lost-reports', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(25);
    expect(res.body.data.length).toBeLessThanOrEqual(25);
  });

  it('refuses an out-of-range or malformed limit/offset instead of coercing it', async () => {
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'limit=-5', 'limit=1e9', 'limit=5.5', 'offset=abc', 'offset=-1']) {
      const res = await api('GET', `/api/admin/lost-reports?${q}`, adminToken);
      expect(res.status, `?${q} must be refused`).toBe(400);
    }
  });

  it('refuses a repeated parameter rather than silently taking one value', async () => {
    const res = await api('GET', '/api/admin/lost-reports?limit=5&limit=9', adminToken);
    expect(res.status).toBe(400);
  });

  it('an empty (or small) dataset returns a safe empty list, never an error', async () => {
    // A very large offset is the deterministic way to observe the empty page
    // shape without depending on how many reports other suites have created.
    const res = await api('GET', '/api/admin/lost-reports?limit=10&offset=100000', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DTO SAFETY — the admin payload never carries protected data
// ---------------------------------------------------------------------------
describe('11A admin lost-reports: DTO safety', () => {
  it('never exposes document_number_hash, raw identifiers, OTP, tokens or payment data', async () => {
    const id = await makeLostReport('dto');
    const res = await api('GET', '/api/admin/lost-reports?limit=100', adminToken);

    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => r.id === id);
    expect(row, 'the fixture report must be visible to an admin').toBeDefined();

    const keys = Object.keys(row);
    // The protected identifier and the internal account identity are absent.
    expect(keys).not.toContain('document_number_hash');
    expect(keys).not.toContain('customer_id');
    // The reporter's private free text and attributes are absent too.
    for (const omitted of ['description', 'distinctive_marks', 'brand', 'model', 'colour', 'material', 'document_type']) {
      expect(keys, `${omitted} must not be an admin list field`).not.toContain(omitted);
    }
    // ...and no credential-shaped field exists either.
    for (const forbidden of ['token', 'otp', 'payment', 'secret', 'password', 'session']) {
      expect(keys, `${forbidden} must not be an admin list field`).not.toContain(forbidden);
    }

    // The sentinel VALUES must not survive anywhere in the serialised payload —
    // this also catches one reappearing nested or under an alias.
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(S.documentNumberHash);
    expect(json).not.toContain(S.description);
    expect(json).not.toContain(S.distinctiveMarks);
    expect(json).not.toContain(S.brand);
    expect(json).not.toContain(S.colour);
    expect(json).not.toContain(S.customerId);
    expect(json).not.toContain(S.token);
    expect(json).not.toContain(S.otp);
    expect(json).not.toContain(S.payment);
  });

  it('reports identifier PRESENCE without ever shipping the hash', async () => {
    const withHash = await makeLostReport('hash-yes');
    const withoutHash = await makeLostReport('hash-no', { document_number_hash: null });
    const res = await api('GET', '/api/admin/lost-reports?limit=100', adminToken);

    const a = res.body.data.find((r: any) => r.id === withHash);
    const b = res.body.data.find((r: any) => r.id === withoutHash);
    expect(a.has_document_number).toBe(true);
    expect(b.has_document_number).toBe(false);
    expect(res.raw).not.toContain(S.documentNumberHash);
  });

  it('exposes exactly the documented field set — nothing extra', async () => {
    const id = await makeLostReport('shape');
    const res = await api('GET', '/api/admin/lost-reports?limit=100', adminToken);
    const row = res.body.data.find((r: any) => r.id === id);

    expect(Object.keys(row).sort()).toEqual([
      'administrative_unit_id',
      'administrative_unit_name',
      'category_id',
      'county',
      'created_at',
      'has_document_number',
      'id',
      // PHASE 16.1 (BATCH 1) — the reported item's name and its optional photo
      // joined the admin DTO: a name is what an administrator classifies a report
      // BY, and the photo path is what they look at when the name is ambiguous.
      'item_name',
      'location_area',
      'location_landmark',
      'lost_at_from',
      'lost_at_to',
      'photo_url',
      'possible_match_count',
      'status',
      'updated_at',
    ]);
  });
});

// ---------------------------------------------------------------------------
// DATA CORRECTNESS
// ---------------------------------------------------------------------------
describe('11A admin lost-reports: data correctness', () => {
  it('returns the real reference, category, county, area and dates for a report', async () => {
    const id = await makeLostReport('correct');
    const res = await api('GET', '/api/admin/lost-reports?limit=100', adminToken);
    const row = res.body.data.find((r: any) => r.id === id);

    expect(row.id).toBe(id);
    expect(row.status).toBe('active');
    expect(row.category_id).toBe('national-id');
    expect(row.county).toBe('Nairobi');
    expect(row.location_area).toBe('Westlands');
    expect(row.location_landmark).toBe('Near Sarit Centre');
    expect(row.lost_at_from).toBeTruthy();
    expect(new Date(row.lost_at_from).getTime()).toBeLessThan(Date.now());
    expect(row.lost_at_to).toBeTruthy();
    expect(row.created_at).toBeTruthy();
  });

  it('reflects the real status rather than assuming "active"', async () => {
    const id = await makeLostReport('closed', { status: 'cancelled' });
    const res = await api('GET', '/api/admin/lost-reports?limit=100', adminToken);
    const row = res.body.data.find((r: any) => r.id === id);
    expect(row.status).toBe('cancelled');
    // A closed report is not being matched, so the count is "not applicable"
    // (null) rather than a misleading 0.
    expect(row.possible_match_count).toBe(null);
  });

  it('reports a possible-match count for an ACTIVE report, from the existing engine', async () => {
    const id = await makeLostReport('matches');
    const res = await api('GET', '/api/admin/lost-reports?limit=100', adminToken);
    const row = res.body.data.find((r: any) => r.id === id);
    // The engine ran: the value is a real integer, not null and not a placeholder.
    expect(typeof row.possible_match_count).toBe('number');
    expect(Number.isInteger(row.possible_match_count)).toBe(true);
    expect(row.possible_match_count).toBeGreaterThanOrEqual(0);
  });

  it('orders the page newest-first (asserted at the query, not via the mock)', () => {
    // WHY NOT A RUNTIME ORDER ASSERTION: the in-memory mock used when no
    // DATABASE_URL is configured strips ORDER BY from the evaluated predicate
    // (src/db/index.ts) and does not reproduce Postgres' multi-key ordering, so
    // a strict global order check here would test the TEST DOUBLE, not the
    // query. The ordering contract is therefore pinned where it lives — the
    // Drizzle query — and the operational consequence is asserted at runtime.
    const source = read('src/db/database.ts');
    const start = source.indexOf('public async listAdminLostReports');
    expect(start, 'listAdminLostReports not found').toBeGreaterThan(-1);
    // The window covers the whole method. It is generous because PHASE 16.1
    // (BATCH 1) added the documented `unclassifiedOnly` filter to the same
    // method — the ordering assertion itself is unchanged.
    const body = source.slice(start, start + 2200);
    expect(body).toContain('.orderBy(desc(lostReportsTable.created_at), desc(lostReportsTable.id))');

    const limit = read('src/db/database.ts');
    expect(limit).toContain('offset + limit + 1');
  });

  it('a brand-new report is visible on the first page (newest-first consequence)', async () => {
    const id = await makeLostReport('fresh-visible');
    const res = await api('GET', '/api/admin/lost-reports?limit=100', adminToken);
    const ids = res.body.data.map((r: any) => r.id);
    expect(ids).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// PHASE 16.1 (GEO-16-04) — THE CANONICAL COUNTY FILTER
// ---------------------------------------------------------------------------
// Real Express + the real route + the real DB layer over a real socket, so the
// status code, the canonicalisation and the FILTERED pagination are all
// exercised rather than asserted from source text.
//
// The fixtures use counties no other fixture in this repository uses
// ('West Pokot', 'Tana River') so the county constraint is isolated from every
// other suite's data, which may run concurrently.
describe('16.1 admin lost-reports: canonical county filter', () => {
  const POKOT = 'West Pokot';
  const TANA = 'Tana River';

  it('no county parameter keeps the existing unfiltered behaviour', async () => {
    const pokot = await makeLostReport('county-unfiltered-pokot', { county: POKOT });
    const tana = await makeLostReport('county-unfiltered-tana', { county: TANA });

    const res = await api('GET', '/api/admin/lost-reports?limit=100', adminToken);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r: any) => r.id);
    // Both counties appear when nothing is filtered: the parameter is optional
    // and its absence is not an empty filter.
    expect(ids).toContain(pokot);
    expect(ids).toContain(tana);
  });

  it('a valid county returns ONLY matching reports', async () => {
    const pokot = await makeLostReport('county-only-pokot', { county: POKOT });
    const tana = await makeLostReport('county-only-tana', { county: TANA });

    const res = await api('GET', `/api/admin/lost-reports?limit=100&county=${encodeURIComponent(POKOT)}`, adminToken);
    expect(res.status).toBe(200);
    const rows = res.body.data as any[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.county).toBe(POKOT);
    expect(rows.map((r) => r.id)).toContain(pokot);
    expect(rows.map((r) => r.id)).not.toContain(tana);
  });

  it('resolves canonical aliases before filtering (the DB only ever sees canonical values)', async () => {
    // 'nairobi' -> 'Nairobi City' and 'muranga' -> "Murang'a": both are accepted,
    // and the filter is applied to the CANONICAL name the column stores.
    const nairobi = await api('GET', '/api/admin/lost-reports?limit=100&county=nairobi', adminToken);
    expect(nairobi.status).toBe(200);
    for (const row of nairobi.body.data) expect(row.county).toBe('Nairobi City');

    const muranga = await api('GET', '/api/admin/lost-reports?limit=100&county=muranga', adminToken);
    expect(muranga.status).toBe(200);
    for (const row of muranga.body.data) expect(row.county).toBe("Murang'a");
  });

  it('refuses an invalid county instead of ignoring the filter', async () => {
    for (const bad of ['Atlantis', 'Westlands', 'Mombasa Road', 'Nairobi CBD', '', '12345']) {
      const res = await api('GET', `/api/admin/lost-reports?limit=10&county=${encodeURIComponent(bad)}`, adminToken);
      expect(res.status, `county=${bad}`).toBe(400);
      expect(res.body.error, `county=${bad}`).toBe(FOUND_COUNTY_MESSAGES.invalid);
    }
  });

  it('refuses a repeated county parameter as malformed', async () => {
    const res = await api('GET', '/api/admin/lost-reports?limit=10&county=Mombasa&county=Kilifi', adminToken);
    expect(res.status).toBe(400);
  });

  it('paginates WITHIN the filtered result set (disjoint pages, hasMore from the filter)', async () => {
    // West Pokot fixtures already exist from the cases above, so at least two
    // matching rows are guaranteed: `hasMore` must therefore be true for a
    // one-row page of that county, while the page still holds a single row.
    const all = await api('GET', `/api/admin/lost-reports?limit=100&county=${encodeURIComponent(POKOT)}`, adminToken);
    expect(all.status).toBe(200);
    const allIds = all.body.data.map((r: any) => r.id);
    expect(allIds.length).toBeGreaterThanOrEqual(2);
    for (const row of all.body.data) expect(row.county).toBe(POKOT);

    const page1 = await api('GET', `/api/admin/lost-reports?limit=1&offset=0&county=${encodeURIComponent(POKOT)}`, adminToken);
    expect(page1.status).toBe(200);
    expect(page1.body.pagination.limit).toBe(1);
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.data[0].county).toBe(POKOT);
    expect(page1.body.pagination.hasMore).toBe(true);

    const page2 = await api('GET', `/api/admin/lost-reports?limit=1&offset=1&county=${encodeURIComponent(POKOT)}`, adminToken);
    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.data[0].county).toBe(POKOT);
    // The two pages are DISJOINT members of the filtered set — pagination is
    // over the county-filtered rows, not over the unfiltered table.
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    expect(allIds).toContain(page1.body.data[0].id);
    expect(allIds).toContain(page2.body.data[0].id);

    // Consequence of the filter being applied to the page query itself: a
    // two-row page of the county is FILLED from matching rows (not "the two
    // newest reports overall, filtered down to whatever survives").
    const two = await api('GET', `/api/admin/lost-reports?limit=2&offset=0&county=${encodeURIComponent(POKOT)}`, adminToken);
    expect(two.status).toBe(200);
    expect(two.body.data).toHaveLength(2);
    for (const row of two.body.data) expect(row.county).toBe(POKOT);
  });

  it('leaves the existing limit/offset validation untouched', async () => {
    const badLimit = await api('GET', `/api/admin/lost-reports?limit=abc&county=${encodeURIComponent(POKOT)}`, adminToken);
    expect(badLimit.status).toBe(400);
    const badOffset = await api('GET', `/api/admin/lost-reports?limit=10&offset=-1&county=${encodeURIComponent(POKOT)}`, adminToken);
    expect(badOffset.status).toBe(400);
  });

  it('clearing the county removes the county constraint', async () => {
    const tana = await makeLostReport('county-cleared-tana', { county: TANA });
    const filtered = await api('GET', `/api/admin/lost-reports?limit=100&county=${encodeURIComponent(POKOT)}`, adminToken);
    expect(filtered.body.data.map((r: any) => r.id)).not.toContain(tana);

    const cleared = await api('GET', '/api/admin/lost-reports?limit=100', adminToken);
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.map((r: any) => r.id)).toContain(tana);
    expect(cleared.body.data.map((r: any) => r.id).length).toBeGreaterThanOrEqual(filtered.body.data.length);
  });

  it('the data layer skips the WHERE clause entirely when no county is given', async () => {
    // Behavioural, at the query the route calls: null/undefined/'' must not
    // become `county = NULL`, which would match nothing.
    const all = await db.listAdminLostReports({ limit: 5, offset: 0 });
    const nullCounty = await db.listAdminLostReports({ limit: 5, offset: 0, county: null });
    const emptyCounty = await db.listAdminLostReports({ limit: 5, offset: 0, county: '' });
    expect(nullCounty.rows.map((r) => r.id)).toEqual(all.rows.map((r) => r.id));
    expect(emptyCounty.rows.map((r) => r.id)).toEqual(all.rows.map((r) => r.id));
  });
});

// ---------------------------------------------------------------------------
// PRESERVATION — nothing else was reopened
// ---------------------------------------------------------------------------
describe('11A admin lost-reports: nothing else was reopened', () => {
  it('the admin module exposes EXACTLY ONE mutation, and it is the classification PATCH', () => {
    const source = read('src/routes/adminLostReports.ts');
    // PHASE 16.1 (BATCH 1) deliberately added ONE write to this module. This
    // asserts the precise shape rather than a blanket "no mutations": there is
    // one PATCH, no POST/PUT/DELETE at all, it targets the per-report classify
    // sub-resource, and it carries the SAME authorization chain as the read.
    const mutations = [...source.matchAll(/app\.(post|put|patch|delete)\(/g)].map((m) => m[1]);
    expect(mutations).toEqual(['patch']);
    expect(source).not.toMatch(/app\.(post|put|delete)\(/);
    expect(source).toContain(
      "app.patch('/api/admin/lost-reports/:id/classify', authenticateJWT, requireCurrentAdminSession",
    );
    // The inline role check — required because authenticateJWT does not look at
    // the role — is present on BOTH routes (the read and the write).
    expect((source.match(/if \(req\.user\?\.role !== 'admin'\)/g) || []).length).toBe(2);
  });

  it('the lost-report router still guards every route with requireCustomerAuth', () => {
    const source = read('src/routes/lostReports.ts');
    const routed = [...source.matchAll(/app\.(get|post)\('(\/api\/lost-reports[^']*)'([^)]*)/g)];
    expect(routed.length).toBeGreaterThan(0);
    for (const [, method, routePath, rest] of routed) {
      // The CREATE route mounts limiter -> requireCustomerAuth -> limiter; the
      // read routes mount requireCustomerAuth directly. Either way the guard
      // must be on the route.
      expect(rest, `${method.toUpperCase()} ${routePath} must require customer auth`).toContain(
        'requireCustomerAuth',
      );
    }
  });

  it('this change added only a read method to the data layer', () => {
    const db = read('src/db/database.ts');
    expect(db).toContain('listAdminLostReports');
    // Phase 10's deferred F-2 lives in the escrow metric area. That code is
    // untouched by this change: the escrow CAS primitives are still present and
    // unchanged, and no escrow arithmetic was edited.
    expect(db).toContain('attemptClaimEscrowHold');
    expect(db).toContain('attemptSettlementRelease');
  });
});

// =============================================================================
// PHASE 16.1 (BATCH 1) — CLASSIFICATION
// =============================================================================
// The one admin lost-report write: PATCH /api/admin/lost-reports/:id/classify.
// Everything below drives the REAL route over a real socket with the REAL
// authenticateJWT, so the authorization claims are demonstrated rather than
// described.
//
// The four behaviours this suite exists to pin:
//   1. an unclassified report can be CLASSIFIED;
//   2. a classified report can be RECLASSIFIED;
//   3. a classified report can be returned to UNCLASSIFIED (deliberately, and
//      only by an explicit `categoryId: null`);
//   4. a supplied category that is unknown or INACTIVE is refused, and a refusal
//      changes NOTHING.
describe('16.1 Batch 1: PATCH /api/admin/lost-reports/:id/classify', () => {
  const classifyPath = (id: string) => `/api/admin/lost-reports/${id}/classify`;

  /** An UNCLASSIFIED report: exactly the state Batch 1 makes representable. */
  const makeUnclassified = (suffix: string) => makeLostReport(suffix, { category_id: null });

  it('is refused without a token, and for a non-admin or 2FA-pending caller', async () => {
    const id = await makeUnclassified('authz');

    expect((await api('PATCH', classifyPath(id), undefined, { categoryId: 'national-id' })).status).toBe(401);
    expect((await api('PATCH', classifyPath(id), pending2faToken, { categoryId: 'national-id' })).status).toBe(403);
    expect((await api('PATCH', classifyPath(id), ownerToken, { categoryId: 'national-id' })).status).toBe(403);

    // Nothing was written by any refused request.
    const stored = await db.getLostReportById(id);
    expect(stored!.category_id == null).toBe(true);
  });

  it('classifies an UNCLASSIFIED report and reports the previous value', async () => {
    const id = await makeUnclassified('classify');
    const res = await api('PATCH', classifyPath(id), adminToken, { categoryId: 'national-id' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.previousCategory).toBeNull();
    expect(res.body.newCategory).toBe('national-id');

    const stored = await db.getLostReportById(id);
    expect(stored!.category_id).toBe('national-id');
  });

  /** A report that already carries a category — the reclassify/unclassify subject. */
  const makeClassified = (suffix: string) => makeLostReport(suffix);

  it('RECLASSIFIES an already-classified report', async () => {
    // A category this test creates, so the assertion does not depend on the
    // baseline taxonomy seed existing in either database.
    const otherCategory = `TEST-B1-RECLASSIFY-${RUN}`;
    await ensureTestCategory(otherCategory);

    const id = await makeClassified('reclassify');
    const res = await api('PATCH', classifyPath(id), adminToken, { categoryId: otherCategory });

    expect(res.status).toBe(200);
    expect(res.body.previousCategory).toBe('national-id');
    expect(res.body.newCategory).toBe(otherCategory);
    expect((await db.getLostReportById(id))!.category_id).toBe(otherCategory);
  });

  it('returns a classified report to UNCLASSIFIED only when `categoryId: null` is sent', async () => {
    const id = await makeClassified('unclassify');
    const res = await api('PATCH', classifyPath(id), adminToken, { categoryId: null });

    expect(res.status).toBe(200);
    expect(res.body.previousCategory).toBe('national-id');
    expect(res.body.newCategory).toBeNull();
    expect((await db.getLostReportById(id))!.category_id == null).toBe(true);
  });

  it('refuses a body with NO categoryId key instead of silently clearing the category', async () => {
    const id = await makeClassified('no-key');
    const res = await api('PATCH', classifyPath(id), adminToken, {});

    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    // An accidental blank body must never unclassify a report.
    expect((await db.getLostReportById(id))!.category_id).toBe('national-id');
  });

  it('refuses an UNKNOWN category and changes nothing', async () => {
    const id = await makeUnclassified('unknown-cat');
    const res = await api('PATCH', classifyPath(id), adminToken, { categoryId: 'not-a-real-category' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('That item category is not valid.');
    expect((await db.getLostReportById(id))!.category_id == null).toBe(true);
  });

  it('refuses a DEACTIVATED category and changes nothing', async () => {
    const inactive = `TEST-B1-INACTIVE-CLASSIFY-${RUN}`;
    await ensureTestCategory(inactive);
    await db.setCategoryActive(inactive, false);

    const id = await makeUnclassified('inactive-cat');
    const res = await api('PATCH', classifyPath(id), adminToken, { categoryId: inactive });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('That item category is not valid.');
    expect((await db.getLostReportById(id))!.category_id == null).toBe(true);
  });

  it('answers an unknown or malformed reference with the SAME 404', async () => {
    const unknown = await api('PATCH', classifyPath(`LR-${'Z'.repeat(6)}`), adminToken, { categoryId: 'national-id' });
    const malformed = await api('PATCH', classifyPath('not-a-reference'), adminToken, { categoryId: 'national-id' });

    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(unknown.body.error).toBe(malformed.body.error);
  });

  it('echoes only the classification — never any other report field', async () => {
    const id = await makeUnclassified('shape');
    const res = await api('PATCH', classifyPath(id), adminToken, { categoryId: 'national-id' });

    expect(Object.keys(res.body).sort()).toEqual(['newCategory', 'previousCategory', 'success']);
    // The protected identifier and the reporter's private text stay out.
    expect(res.raw).not.toContain(S.documentNumberHash);
    expect(res.raw).not.toContain(S.description);
    expect(res.raw).not.toContain(S.customerId);
  });

// =============================================================================
// PHASE 16.1 (BATCH 1) — THE UNCLASSIFIED-ONLY FILTER
// =============================================================================
// The console's "Unclassified only" checkbox must be a real server-side filter,
// not a client-side hide: it has to compose with the county filter in the SAME
// bounded page query, so pagination and `hasMore` describe the filtered set.
describe('16.1 Batch 1: GET /api/admin/lost-reports?unclassified=', () => {
  it('returns ONLY unclassified reports when asked, and omits classified ones', async () => {
    const unclassified = await makeLostReport('filter-unclassified', { category_id: null });
    const classified = await makeLostReport('filter-classified');

    const res = await api('GET', '/api/admin/lost-reports?limit=100&unclassified=true', adminToken);
    expect(res.status).toBe(200);

    const ids = res.body.data.map((row: any) => row.id);
    expect(ids).toContain(unclassified);
    expect(ids).not.toContain(classified);
    // Every returned row really is unclassified.
    for (const row of res.body.data) {
      expect(row.category_id, `${row.id} must be unclassified`).toBeNull();
    }
  });

  it('the unfiltered list still contains BOTH kinds', async () => {
    const unclassified = await makeLostReport('filter-both-unclassified', { category_id: null });
    const classified = await makeLostReport('filter-both-classified');

    const res = await api('GET', '/api/admin/lost-reports?limit=100', adminToken);
    const ids = res.body.data.map((row: any) => row.id);
    expect(ids).toContain(unclassified);
    expect(ids).toContain(classified);
  });

  it('COMPOSES with the county filter instead of replacing it', async () => {
    const inMombasa = await makeLostReport('filter-county-unclassified', {
      category_id: null,
      county: 'Mombasa',
    });
    const elsewhere = await makeLostReport('filter-county-other', {
      category_id: null,
      county: 'Nairobi',
    });

    const res = await api('GET', '/api/admin/lost-reports?limit=100&county=Mombasa&unclassified=true', adminToken);
    expect(res.status).toBe(200);

    const ids = res.body.data.map((row: any) => row.id);
    expect(ids).toContain(inMombasa);
    expect(ids).not.toContain(elsewhere);
    for (const row of res.body.data) {
      expect(row.category_id).toBeNull();
      expect(row.county).toBe('Mombasa');
    }
  });

  it('refuses a value that is neither `true` nor `false`', async () => {
    for (const value of ['1', 'yes', 'TRUE', '']) {
      const res = await api('GET', `/api/admin/lost-reports?unclassified=${value}`, adminToken);
      expect(res.status, `?unclassified=${value} must be refused`).toBe(400);
    }
  });

  it('reports NO possible-match count for an unclassified report — matching is deferred', async () => {
    const id = await makeLostReport('filter-count', { category_id: null });
    const res = await api('GET', '/api/admin/lost-reports?limit=100&unclassified=true', adminToken);

    const row = res.body.data.find((r: any) => r.id === id);
    expect(row).toBeDefined();
    // null ("not applicable — cannot be matched yet"), NEVER 0 ("we looked and
    // found nothing"), because the platform genuinely has not looked.
    expect(row.possible_match_count).toBeNull();
  });
});

// =============================================================================
// PHASE 16.1 (BATCH 1) — DUPLICATE-SUBMISSION SAFETY
// =============================================================================
// The classify endpoint is idempotent by construction: applying the same
// classification twice is a successful no-op, so a doubled request (a double
// click, a retried fetch) cannot corrupt a report or produce a contradictory
// response. The console additionally drops a second in-flight click per row.
describe('16.1 Batch 1: classification is idempotent under a doubled request', () => {
  it('classifying twice to the same category succeeds twice and leaves one stable state', async () => {
    const id = await makeLostReport('idempotent', { category_id: null });
    const path = `/api/admin/lost-reports/${id}/classify`;

    const first = await api('PATCH', path, adminToken, { categoryId: 'national-id' });
    const second = await api('PATCH', path, adminToken, { categoryId: 'national-id' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The second call reports the same category as both previous and current —
    // it is a no-op, not a change.
    expect(first.body.previousCategory).toBeNull();
    expect(second.body.previousCategory).toBe('national-id');
    expect(second.body.newCategory).toBe('national-id');
    expect((await db.getLostReportById(id))!.category_id).toBe('national-id');
  });

  it('unclassifying twice succeeds twice and leaves the report unclassified', async () => {
    const id = await makeLostReport('idempotent-clear');
    const path = `/api/admin/lost-reports/${id}/classify`;

    expect((await api('PATCH', path, adminToken, { categoryId: null })).status).toBe(200);
    const second = await api('PATCH', path, adminToken, { categoryId: null });
    expect(second.status).toBe(200);
    expect(second.body.newCategory).toBeNull();
    expect((await db.getLostReportById(id))!.category_id == null).toBe(true);
  });
});

});

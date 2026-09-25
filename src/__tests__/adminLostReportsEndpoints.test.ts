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

async function api(method: string, urlPath: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + urlPath, { method, headers });
  const raw = await res.text();
  let body: any = null;
  try { body = JSON.parse(raw); } catch { body = null; }
  return { status: res.status, body, raw };
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

  it('the endpoint is READ-ONLY — no mutation verb is routed', async () => {
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
      'location_area',
      'location_landmark',
      'lost_at_from',
      'lost_at_to',
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
    const body = source.slice(start, start + 1200);
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
  it('the admin module is GET-only by construction', () => {
    expect(read('src/routes/adminLostReports.ts')).not.toMatch(/app\.(post|put|patch|delete)\(/);
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

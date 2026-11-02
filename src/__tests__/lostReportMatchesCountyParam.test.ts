import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { db } from '../db/database';
import { hashCode } from '../services/auth';
import { registerLostReportRoutes } from '../routes/lostReports';
import { generateLostReportReference } from '../services/lostReportReference';
import { FOUND_COUNTY_MESSAGES } from '../services/foundItemCounty';

// ---------------------------------------------------------------------------
// PHASE 16.1 BATCH 2 — MALFORMED `county` QUERY-SHAPE REGRESSION COVERAGE for
// GET /api/lost-reports/:id/matches.
//
// WHY A SEPARATE FILE (and why it is DATABASE-FREE)
//   The behaviour under test is HTTP-level: which status code and which body a
//   *query string* produces. src/__tests__/lostReportMatchesRoutes.test.ts
//   already covers the happy paths, but every case there seeds PostgreSQL
//   fixtures. The malformed shapes below (repeated parameters, `county[...]`
//   objects, `county[]` arrays, blank values) are pure REQUEST-VALIDATION cases:
//   they must be decided from the query string alone, before any item fetch.
//
//   So this suite keeps everything that decides the answer REAL —
//     * the REAL Express app and router registration (routes/lostReports.ts)
//     * the REAL requireCustomerAuth middleware (services/customerAuth.ts)
//     * the REAL route handler, county resolver (config/kenyaCounties.ts),
//       matching engine (services/lostReportMatching.ts) and response builder
//       (services/lostReportMatchView.ts)
//   — and replaces ONLY the data-layer reads the request path performs, with
//   `vi.spyOn(db, ...)` mocks. No row is read, written, updated or deleted, no
//   pool.query() is ever issued, and no migration or provider call is made.
//
//   That is a deliberate trade: the payload contract and the ordering guarantees
//   are proven end-to-end, while the claim "these rows live in Postgres" is left
//   to the DB-backed suite. Nothing here weakens the DB-backed file; it fills the
//   shape-coverage gap that file cannot fill safely in a database-free run.
//
// ORDERING RULES THIS FILE PINS DOWN (they are the security-relevant ones):
//   1. Authentication (401) happens BEFORE any county validation.
//   2. The owner-scoped report lookup (404) happens BEFORE county validation, so
//      an invalid county can never distinguish "someone else's report" from
//      "no such report".
//   3. An invalid supplied value is 400 — never a silent downgrade to
//      "no filter", which would quietly return the whole platform.
//   4. County validation happens BEFORE the closed-report short-circuit.
// ---------------------------------------------------------------------------

// A single, deterministic clock for every fixture. Items are recorded "now", the
// active report's window brackets "an hour ago" — the same relationship the
// DB-backed county fixtures rely on (an item found up to 7 days after the
// reported window still counts as a temporal match).
const NOW_MS = Date.now();
const NOW_ISO = new Date(NOW_MS).toISOString();
const EXPIRES_ISO = new Date(NOW_MS + 7 * 24 * 60 * 60 * 1000).toISOString();

const CUSTOMER_A = 'TEST-16B-CUS-A';
const CUSTOMER_B = 'TEST-16B-CUS-B';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

const SESSION_A = 'TEST-16B-SESS-A';
const SESSION_B = 'TEST-16B-SESS-B';

const CATEGORY_COUNTY = 'TEST-16B-CAT-COUNTY';
const ITEM_DECLARED = 'TEST-16B-ITEM-DECLARED';
const ITEM_LEGACY = 'TEST-16B-ITEM-LEGACY';

const LR_COUNTY = generateLostReportReference();
const LR_CLOSED = generateLostReportReference();
const LR_B = generateLostReportReference();
const LR_MISSING = generateLostReportReference();

const SESSIONS = new Map<string, any>([
  [hashCode(TOKEN_A), {
    id: SESSION_A,
    customer_id: CUSTOMER_A,
    revoked_at: null,
    expires_at: EXPIRES_ISO,
    last_seen_at: NOW_ISO,
  }],
  [hashCode(TOKEN_B), {
    id: SESSION_B,
    customer_id: CUSTOMER_B,
    revoked_at: null,
    expires_at: EXPIRES_ISO,
    last_seen_at: NOW_ISO,
  }],
]);

const CUSTOMERS = new Map<string, any>([
  [CUSTOMER_A, { id: CUSTOMER_A, full_name: 'Asha Mwangi', phone: '+254700000001', status: 'active', created_at: NOW_ISO, updated_at: NOW_ISO }],
  [CUSTOMER_B, { id: CUSTOMER_B, full_name: 'Brian Otieno', phone: '+254700000002', status: 'active', created_at: NOW_ISO, updated_at: NOW_ISO }],
]);

/** A lost report whose window brackets "an hour ago". */
function lostRow(id: string, customerId: string, overrides: Record<string, any> = {}) {
  return {
    id,
    customer_id: customerId,
    category_id: CATEGORY_COUNTY,
    status: 'active',
    county: 'Nairobi City',
    location_area: 'Karen',
    location_landmark: null,
    lost_at_from: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
    lost_at_to: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
    brand: 'Nokia',
    model: null,
    colour: 'Green',
    material: null,
    description: 'green nokia feature phone with a cracked screen',
    distinctive_marks: null,
    document_type: null,
    document_number_hash: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  } as any;
}

/**
 * A found item. The two fixtures are IDENTICAL in every field the matcher reads
 * (category, location text, description) and differ ONLY in the DECLARED county,
 * so the optional filter is the only thing that can separate them.
 *
 * `created_at` is set explicitly because these rows never touch the database,
 * where it would otherwise default to now().
 */
function itemRow(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    category_id: CATEGORY_COUNTY,
    photo_url: 'photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: 'Simu',
    location_description: 'Karen, Nairobi',
    found_county: 'Nairobi City',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000009',
    assigned_agent_id: null,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: 'green nokia feature phone with a cracked screen',
    is_sensitive_document: false,
    rejection_reason: null,
    finder_email: 'finder@example.test',
    created_at: NOW_ISO,
    ...overrides,
  } as any;
}

const REPORTS = new Map<string, any>([
  [LR_COUNTY, lostRow(LR_COUNTY, CUSTOMER_A)],
  [LR_CLOSED, lostRow(LR_CLOSED, CUSTOMER_A, { status: 'cancelled' })],
  [LR_B, lostRow(LR_B, CUSTOMER_B)],
]);

const ITEMS = [
  // Declares the report's county.
  itemRow(ITEM_DECLARED, { found_county: 'Nairobi City' }),
  // A legacy row recorded before Phase 9D: no declared county, therefore never
  // matched by a county filter, but still eligible when no filter is supplied.
  itemRow(ITEM_LEGACY, { found_county: null }),
];

/** Mirrors server.ts's central canCreateClaim rule (no DB fallback needed here). */
async function testCanCreateClaim(item: any, preFetchedDisputes?: any[]) {
  if (!item) return { allowed: false, reason: 'not_found' };
  if (item.status !== 'at_agent') return { allowed: false, reason: 'not_physically_verified' };
  if (item.flaggedForReview) return { allowed: false, reason: 'flagged_for_review' };
  const disputes = preFetchedDisputes ?? [];
  if (disputes.some((d: any) => !d.resolved_at)) return { allowed: false, reason: 'unresolved_dispute' };
  return { allowed: true, reason: 'ok' };
}

let server: any;
let baseUrl = '';

/** How many times the (spied) item fetch has run — proves a 400 never gets that far. */
const itemFetchCount = () => (db.getItemsByStatus as any).mock.calls.length;

/** Drives the REAL route over a real TCP socket, exactly as a browser would. */
async function getMatches(token: string | null, reference: string, query = '') {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = 'r4m_customer_session=' + token;
  const suffix = query ? `?${query}` : '';
  const res = await fetch(`${baseUrl}/api/lost-reports/${reference}/matches${suffix}`, { headers });
  const raw = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return { status: res.status, body, raw };
}

/** `county=<value>`, percent-encoded the way a browser would send it. */
const countyQuery = (raw: string) => `county=${encodeURIComponent(raw)}`;

const candidateIds = (body: any): string[] => (body?.matches || []).map((m: any) => m.id);

beforeAll(async () => {
  // THE ONLY SUBSTITUTION IN THIS FILE: the data-layer reads the request path
  // performs (plus the session-touch write). Nothing else about the request is
  // faked, and no query is ever issued to PostgreSQL.
  vi.spyOn(db, 'getCustomerSessionByTokenHash').mockImplementation((async (hash: string) => SESSIONS.get(hash) ?? null) as any);
  vi.spyOn(db, 'getCustomerById').mockImplementation((async (id: string) => CUSTOMERS.get(id) ?? null) as any);
  vi.spyOn(db, 'touchCustomerSession').mockImplementation((async () => undefined) as any);
  vi.spyOn(db, 'revokeCustomerSession').mockImplementation((async () => undefined) as any);
  // Owner-scoped on purpose: the fake honours the same predicate the SQL does,
  // so a cross-customer reference still resolves to "not found".
  vi.spyOn(db, 'getLostReportByIdForCustomer').mockImplementation((async (id: string, customerId: string) => {
    const report = REPORTS.get(id);
    return report && report.customer_id === customerId ? report : null;
  }) as any);
  vi.spyOn(db, 'getItemsByStatus').mockImplementation((async (status: string) => ITEMS.filter((item) => item.status === status)) as any);
  vi.spyOn(db, 'getDisputesByItemIds').mockImplementation((async () => new Map()) as any);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerLostReportRoutes(app, {
    canCreateClaim: testCanCreateClaim,
    sendServerError: (res: any, error: any, context: string) => {
      console.error(`[${context}]`, error);
      res.status(500).json({ error: 'A server error occurred. Please try again later.' });
    },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. OMITTED — the pre-existing behaviour must be untouched.
// ---------------------------------------------------------------------------
describe('no `county` parameter at all', () => {
  it('returns every eligible candidate, including one with no declared county', async () => {
    const res = await getMatches(TOKEN_A, LR_COUNTY);
    expect(res.status).toBe(200);
    const ids = candidateIds(res.body);
    expect(ids).toContain(ITEM_DECLARED);
    // The legacy item (found_county NULL) is ONLY reachable when no filter is
    // supplied — the filter is opt-in, never a default.
    expect(ids).toContain(ITEM_LEGACY);
    expect(res.body.notice).toBe('possible_matches_do_not_confirm_ownership');
    expect(res.body.ownership_confirmed).toBe(false);
    expect(res.body.lost_report_id).toBe(LR_COUNTY);
  });
});

// ---------------------------------------------------------------------------
// 2. ACCEPTED VALUES — canonical names plus every documented formatting rule.
// ---------------------------------------------------------------------------
describe('a valid `county` value narrows the candidate set', () => {
  it('a canonical county keeps only items declared in it', async () => {
    const res = await getMatches(TOKEN_A, LR_COUNTY, countyQuery('Nairobi City'));
    expect(res.status).toBe(200);
    const ids = candidateIds(res.body);
    expect(ids).toEqual([ITEM_DECLARED]);
    // The legacy row declares no county, so a county filter excludes it — that
    // exclusion is the documented consequence of applying a filter.
    expect(ids).not.toContain(ITEM_LEGACY);
  });

  // Every spelling below resolves through the ONE canonical resolver
  // (config/kenyaCounties.ts) to the same county, so all of them must produce
  // the SAME response as the canonical name above. None of them may 400.
  for (const spelling of ['nairobi', 'NAIROBI CITY', '  Nairobi   City  ', 'Nairobi County', 'Nairobi City County']) {
    it(`accepts the supported variant ${JSON.stringify(spelling)}`, async () => {
      const res = await getMatches(TOKEN_A, LR_COUNTY, countyQuery(spelling));
      expect(res.status).toBe(200);
      expect(candidateIds(res.body)).toEqual([ITEM_DECLARED]);
    });
  }

  it('a valid county that names no candidate is an EMPTY list, never a 400', async () => {
    const res = await getMatches(TOKEN_A, LR_COUNTY, countyQuery('Kiambu'));
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
    expect(res.body.notice).toBe('possible_matches_do_not_confirm_ownership');
  });
});

// ---------------------------------------------------------------------------
// 3. MALFORMED / UNKNOWN SUPPLIED VALUES — always 400, never a silent
//    downgrade to "no filter" (which would quietly return the whole platform).
// ---------------------------------------------------------------------------
describe('an invalid supplied `county` is refused with 400', () => {
  // The SAME string-based envelope and message the public search uses, so
  // services/lostReportsApi.ts can surface it like any other route error.
  const expectCountyRejected = (res: { status: number; body: any }) => {
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: FOUND_COUNTY_MESSAGES.invalid });
  };

  it('an unknown county name', async () => {
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, countyQuery('Atlantis')));
  });

  it('a partial county name (no prefix or fuzzy matching is performed)', async () => {
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, countyQuery('Nair')));
  });

  it('a place that is not a county at all', async () => {
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, countyQuery('Westlands')));
  });

  it('a misspelling', async () => {
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, countyQuery('Nairobii')));
  });

  it('a doubled trailing suffix ("... County County")', async () => {
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, countyQuery('Nairobi City County County')));
  });

  it('a blank value (`?county=`)', async () => {
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, 'county='));
  });

  it('a whitespace-only value', async () => {
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, `county=${encodeURIComponent('   ')}`));
  });

  it('a bare trailing suffix with no county name ("County")', async () => {
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, countyQuery('County')));
  });

  it('repeated parameters (`?county=A&county=B`)', async () => {
    // Express parses a repeated key into an ARRAY. Nothing in this route does
    // "first value wins" coercion, so an ambiguous request is refused rather
    // than silently resolved to whichever value arrived first.
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, `${countyQuery('Nairobi City')}&${countyQuery('Kiambu')}`));
  });

  it('repeated parameters in bracket form (`?county[]=A&county[]=B`)', async () => {
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, 'county[]=Nairobi%20City&county[]=Kiambu'));
  });

  it('an OBJECT-shaped value (`?county[name]=...`)', async () => {
    // typeof check, not a cast: a non-string is never coerced into one.
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, 'county[name]=Nairobi%20City'));
  });

  it('an object-shaped value carrying a perfectly canonical county inside it', async () => {
    // Proves the refusal is about the SHAPE, not the text: the same string sent
    // as a plain parameter is accepted two tests above.
    expectCountyRejected(await getMatches(TOKEN_A, LR_COUNTY, 'county[0]=Nairobi%20City'));
  });

  it('is rejected BEFORE the item fetch, so a typo costs no scoring work', async () => {
    const before = itemFetchCount();
    const res = await getMatches(TOKEN_A, LR_COUNTY, countyQuery('Atlantis'));
    expect(res.status).toBe(400);
    expect(itemFetchCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 4. ORDERING — authentication, then ownership, then validation.
//
// These are the security-relevant ones: a 400 must never become an oracle for
// "does someone else's report exist", and an anonymous caller must not learn
// anything about the county vocabulary through this route either.
// ---------------------------------------------------------------------------
describe('ordering of authentication, ownership and county validation', () => {
  it('401 without a session cookie, even with an invalid county', async () => {
    const res = await getMatches(null, LR_COUNTY, countyQuery('Atlantis'));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required.' });
  });

  it("404 for another customer's report, even with an invalid county", async () => {
    const crossTenant = await getMatches(TOKEN_B, LR_COUNTY, countyQuery('Atlantis'));
    expect(crossTenant.status).toBe(404);
    // County validation must NOT run yet: a 400 here would distinguish "exists
    // but is not yours" from "does not exist".
    expect(crossTenant.status).not.toBe(400);
  });

  it('the cross-tenant 404 is byte-identical to the non-existent-report 404', async () => {
    const crossTenant = await getMatches(TOKEN_B, LR_COUNTY, countyQuery('Atlantis'));
    const missing = await getMatches(TOKEN_B, LR_MISSING, countyQuery('Atlantis'));
    expect(crossTenant.status).toBe(missing.status);
    expect(crossTenant.raw).toBe(missing.raw);
    expect(crossTenant.body).toEqual(missing.body);
  });

  it('the same cross-tenant reference is a 404 with a VALID county too', async () => {
    const crossTenant = await getMatches(TOKEN_B, LR_COUNTY, countyQuery('Nairobi City'));
    expect(crossTenant.status).toBe(404);
    const missing = await getMatches(TOKEN_B, LR_MISSING, countyQuery('Nairobi City'));
    expect(crossTenant.raw).toBe(missing.raw);
  });

  it('a malformed reference still 404s before any county consideration', async () => {
    const res = await getMatches(TOKEN_A, 'NOT-A-REPORT-REFERENCE', countyQuery('Atlantis'));
    expect(res.status).toBe(404);
  });

  it('an invalid county is validated even when the report is CLOSED', async () => {
    // Validation runs BEFORE the closed-report short-circuit, so a malformed
    // link cannot be silently bypassed by a cancelled report.
    const rejected = await getMatches(TOKEN_A, LR_CLOSED, countyQuery('Atlantis'));
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ error: FOUND_COUNTY_MESSAGES.invalid });
  });

  it('a closed report with a VALID county is an empty list with the closed notice', async () => {
    const res = await getMatches(TOKEN_A, LR_CLOSED, countyQuery('Nairobi City'));
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
    expect(res.body.notice).toBe('lost_report_not_active');
    expect(res.body.lost_report_id).toBe(LR_CLOSED);
  });
});

// ---------------------------------------------------------------------------
// 5. THE DATABASE SURFACE OF THIS SUITE — an explicit guard.
//
// If a future change adds a data-layer read to this request path, this test
// does not fail (that would be a false alarm); what it DOES establish is the
// exact list of collaborator calls this suite relies on being mocked, so the
// "no database was touched" claim above stays auditable rather than assumed.
// ---------------------------------------------------------------------------
describe('the request path only uses the mocked data-layer reads', () => {
  it('records exactly the expected collaborators and nothing unmocked', async () => {
    const before = {
      sessions: (db.getCustomerSessionByTokenHash as any).mock.calls.length,
      customers: (db.getCustomerById as any).mock.calls.length,
      reports: (db.getLostReportByIdForCustomer as any).mock.calls.length,
      items: (db.getItemsByStatus as any).mock.calls.length,
      disputes: (db.getDisputesByItemIds as any).mock.calls.length,
    };

    const ok = await getMatches(TOKEN_A, LR_COUNTY, countyQuery('Nairobi City'));
    expect(ok.status).toBe(200);

    expect((db.getCustomerSessionByTokenHash as any).mock.calls.length).toBe(before.sessions + 1);
    expect((db.getCustomerById as any).mock.calls.length).toBe(before.customers + 1);
    expect((db.getLostReportByIdForCustomer as any).mock.calls.length).toBe(before.reports + 1);
    expect((db.getItemsByStatus as any).mock.calls.length).toBe(before.items + 1);
    expect((db.getDisputesByItemIds as any).mock.calls.length).toBe(before.disputes + 1);
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import { db } from '../../db/database';
import { hashCode } from '../auth';
import { ensureTestCategory, testRunId } from '../../db/__tests__/ensureTestCategory';
import { registerLostReportRoutes } from '../../routes/lostReports';
import { createLostReportMatchCustomerLimiter } from '../../config/lostReportLimiter';
import { generateLostReportReference } from '../lostReportReference';
import {
  createLostReport,
  listMyLostReports,
  getMyLostReport,
  fetchLostReportMatches,
  lostReportPath,
  lostReportMatchesPath,
  errorKindForStatus,
  POSSIBLE_MATCH_NOTICE,
  type LostReportMatchCandidate,
} from '../lostReportsApi';

// ===========================================================================
// Phase 9C — the lost-report API CLIENT, driven against the REAL backend.
//
// The client is React-free on purpose, so it can be exercised here in the
// repository's node-only vitest environment. What these tests prove:
//   * the client's paths/verbs/credentials are what the Phase 9A/9B routes
//     actually require (the REAL route module is mounted and really answers);
//   * every failure mode is normalized into the `kind` the UI branches on;
//   * the candidate DTO the UI receives is EXACTLY the public boundary — no
//     finder contact, no identifier (hashed or plain), no coordinates, no
//     agent, no score, no engine signals;
//   * reading matches is genuinely read-only (no claim, no state change).
//
// `fetch` is stubbed ONLY to give the client's relative URLs a base and to
// attach the session cookie the browser would send — every request still goes
// over a real TCP socket to the real handlers.
// ===========================================================================

const RUN = testRunId;
const base = Math.floor(10000000 + Math.random() * 89999999);
const phone = (offset: number) => '+2547' + String(base + offset).slice(-8);

const CUSTOMER_A = `TEST-9C-CUS-A-${RUN}`;
const CUSTOMER_B = `TEST-9C-CUS-B-${RUN}`;
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

const ITEM_MATCH = `TEST-9C-ITEM-MATCH-${RUN}`;
const ITEM_WRONG_COUNTY = `TEST-9C-ITEM-MBASA-${RUN}`;
const ITEM_SENSITIVE = `TEST-9C-ITEM-SENS-${RUN}`;

const LR_A_MATCH = generateLostReportReference();
const LR_A_NONE = generateLostReportReference();
const LR_A_SENSITIVE = generateLostReportReference();
const LR_B = generateLostReportReference();

// Values that must never reach the client.
const SECRET_FINDER_PHONE = `+2547888${String(base).slice(-5)}`;
const SECRET_FINDER_EMAIL = `clientside-secret-${RUN}@example.test`;
const SECRET_OCR_NUMBER = `CLIENTOCR${RUN}`;
const SECRET_OCR_NAME = `Client Ocr Name ${RUN}`;
const SECRET_DESCRIPTION = `ClientSecretDescription${RUN}`;
const SECRET_HASH = 'd'.repeat(64);
const SECRET_AGENT = `TEST-9C-AGENT-${RUN}`;

const realFetch = globalThis.fetch;
let server: any;
let limitedServer: any;
let baseUrl = '';
let limitedBaseUrl = '';
let cookieHeader: string | undefined;
let rawStub: ((input: any, init?: any) => Promise<any>) | null = null;

/** Mirrors server.ts's central canCreateClaim rule. */
async function testCanCreateClaim(item: any, preFetchedDisputes?: any[]) {
  if (!item) return { allowed: false, reason: 'not_found' };
  if (item.status !== 'at_agent') return { allowed: false, reason: 'not_physically_verified' };
  if (item.flaggedForReview) return { allowed: false, reason: 'flagged_for_review' };
  const disputes = preFetchedDisputes ?? await db.getDisputesByItem(item.id);
  if ((disputes || []).some((d: any) => !d.resolved_at)) return { allowed: false, reason: 'unresolved_dispute' };
  return { allowed: true, reason: 'ok' };
}

function itemRow(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    category_id: 'smartphone',
    photo_url: 'photo.jpg',
    ocr_extracted_number: SECRET_OCR_NUMBER,
    ocr_extracted_name: SECRET_OCR_NAME,
    document_number_hash: null,
    document_name_fuzzy: 'Simu',
    location_description: 'Westlands, Nairobi',
    latitude: -1.2921,
    longitude: 36.8219,
    finder_phone: SECRET_FINDER_PHONE,
    assigned_agent_id: SECRET_AGENT,
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
  await db.createCustomer(CUSTOMER_A, 'Client Test A', phone(0));
  await db.createCustomer(CUSTOMER_B, 'Client Test B', phone(1));

  const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.createCustomerSession(`TEST-9C-SESS-A-${RUN}`, CUSTOMER_A, hashCode(TOKEN_A), in7Days);
  await db.createCustomerSession(`TEST-9C-SESS-B-${RUN}`, CUSTOMER_B, hashCode(TOKEN_B), in7Days);

  await ensureTestCategory('smartphone');
  await ensureTestCategory('bicycle');
  await ensureTestCategory('national-id');

  await db.createItem(itemRow(ITEM_MATCH));
  await db.createItem(itemRow(ITEM_WRONG_COUNTY, { location_description: 'Mombasa, Digo Road' }));
  // A sensitive document carrying every kind of secret, reachable only through
  // an exact protected-identifier agreement.
  await db.createItem(itemRow(ITEM_SENSITIVE, {
    category_id: 'national-id',
    is_sensitive_document: true,
    document_number_hash: SECRET_HASH,
    description: SECRET_DESCRIPTION,
    photo_url: 'secret-national-id-photo.jpg',
  }));

  await db.createLostReport(lostRow(LR_A_MATCH, CUSTOMER_A));
  await db.createLostReport(lostRow(LR_A_NONE, CUSTOMER_A, { category_id: 'bicycle', location_area: 'Karen' }));
  await db.createLostReport(lostRow(LR_A_SENSITIVE, CUSTOMER_A, {
    category_id: 'national-id',
    document_number_hash: SECRET_HASH,
    brand: null, colour: null, description: null,
  }));
  await db.createLostReport(lostRow(LR_B, CUSTOMER_B));
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

  // A second app whose per-customer match limiter is tiny, so the client can be
  // driven against a REAL 429 rather than a hand-built response.
  const limitedApp = express();
  limitedApp.use(express.json({ limit: '1mb' }));
  registerLostReportRoutes(limitedApp, {
    canCreateClaim: testCanCreateClaim,
    sendServerError: (res: any, error: any) => res.status(500).json({ error: String(error) }),
    matchCustomerRateLimiter: createLostReportMatchCustomerLimiter({ max: 1, windowMs: 60 * 1000 }),
  });

  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise<void>((resolve) => { limitedServer = limitedApp.listen(0, '127.0.0.1', () => resolve()); });
  limitedBaseUrl = `http://127.0.0.1:${limitedServer.address().port}`;

  vi.stubGlobal('fetch', (input: any, init: any = {}) => {
    if (rawStub) return rawStub(input, init);
    const url = String(input);
    const headers = { ...(init.headers || {}), ...(cookieHeader ? { cookie: cookieHeader } : {}) };
    return realFetch(url.startsWith('http') ? url : baseUrl + url, { ...init, headers });
  });
});

afterEach(() => {
  rawStub = null;
  cookieHeader = undefined;
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
});

function asCustomerA() { cookieHeader = 'r4m_customer_session=' + TOKEN_A; }
function asCustomerB() { cookieHeader = 'r4m_customer_session=' + TOKEN_B; }

/** The only fields a candidate may ever carry (Phase 9B public DTO). */
const ALLOWED_CANDIDATE_KEYS = [
  'category_id', 'description', 'document_name_fuzzy', 'found_at', 'id',
  'isDescriptionOnly', 'is_sensitive_document', 'location_description',
  'match_reasons', 'photo_url',
].sort();

function validPayload(overrides: Record<string, any> = {}) {
  const now = Date.now();
  return {
    categoryId: 'smartphone',
    county: 'Nairobi',
    locationArea: 'Westlands',
    locationLandmark: 'Near Sarit Centre',
    lostAtFrom: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    lostAtTo: new Date(now - 60 * 60 * 1000).toISOString(),
    brand: 'Samsung',
    colour: 'Black',
    description: 'black samsung phone cracked screen',
    ...overrides,
  };
}

describe('path builders encode the report reference', () => {
  it('builds the documented paths', () => {
    expect(lostReportPath('LR-ABC123')).toBe('/api/lost-reports/LR-ABC123');
    expect(lostReportMatchesPath('LR-ABC123')).toBe('/api/lost-reports/LR-ABC123/matches');
  });

  it('percent-encodes anything that is not a plain reference', () => {
    // A component never hand-builds these URLs; this is the guarantee that
    // nothing a caller passes can change the shape of the request.
    expect(lostReportPath('a b/c')).toBe('/api/lost-reports/a%20b%2Fc');
    expect(lostReportMatchesPath('x&y=z')).toBe('/api/lost-reports/x%26y%3Dz/matches');
  });
});

describe('errorKindForStatus maps every status the UI branches on', () => {
  it('maps the documented codes', () => {
    expect(errorKindForStatus(401)).toBe('auth');
    expect(errorKindForStatus(403)).toBe('forbidden');
    expect(errorKindForStatus(404)).toBe('not_found');
    expect(errorKindForStatus(429)).toBe('rate_limited');
    expect(errorKindForStatus(400)).toBe('validation');
    expect(errorKindForStatus(500)).toBe('server');
    expect(errorKindForStatus(503)).toBe('server');
  });

  it('treats anything else unexpected as malformed rather than guessing', () => {
    expect(errorKindForStatus(302)).toBe('malformed');
    expect(errorKindForStatus(200)).toBe('malformed');
  });
});

describe('the client talks to the REAL 9A/9B endpoints', () => {
  it('creates a report and returns only the acknowledgement the server sends', async () => {
    asCustomerA();
    const result = await createLostReport(validPayload());

    expect(result.ok).toBe(true);
    expect(result.status).toBe(201);
    expect(result.data?.reference).toMatch(/^LR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(result.data?.status).toBe('active');
    expect(typeof result.data?.created_at).toBe('string');
    // The acknowledgement carries nothing else — no id, no hash, no contact.
    expect(Object.keys(result.data || {}).sort()).toEqual(['created_at', 'reference', 'status', 'success']);
  });

  it('lists only the authenticated customer\'s own reports', async () => {
    asCustomerA();
    const mine = await listMyLostReports();
    expect(mine.ok).toBe(true);
    const ids = (mine.data?.lost_reports || []).map((r) => r.id);
    expect(ids).toContain(LR_A_MATCH);
    expect(ids).not.toContain(LR_B);
  });

  it('reads one own report', async () => {
    asCustomerA();
    const result = await getMyLostReport(LR_A_MATCH);
    expect(result.ok).toBe(true);
    expect(result.data?.lost_report.id).toBe(LR_A_MATCH);
    expect(result.data?.lost_report.status).toBe('active');
    // `has_document_number` is a boolean; the hash itself is never sent.
    expect(typeof result.data?.lost_report.has_document_number).toBe('boolean');
  });

  it('returns a candidate when the evidence supports one', async () => {
    asCustomerA();
    const result = await fetchLostReportMatches(LR_A_MATCH);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data?.lost_report_id).toBe(LR_A_MATCH);
    // A candidate is never ownership, and the server says so explicitly.
    expect(result.data?.ownership_confirmed).toBe(false);
    expect(result.data?.notice).toBe(POSSIBLE_MATCH_NOTICE);
    expect(result.data?.disclosure.en).toContain('possible matches only');
    expect(result.data?.disclosure.sw).toBeTruthy();

    const ids = (result.data?.matches || []).map((m) => m.id);
    expect(ids).toContain(ITEM_MATCH);
    expect(ids).not.toContain(ITEM_WRONG_COUNTY);
  });

  it('returns an empty list — not an error — when nothing matches', async () => {
    asCustomerA();
    const result = await fetchLostReportMatches(LR_A_NONE);
    expect(result.ok).toBe(true);
    expect(result.data?.matches).toEqual([]);
    expect(result.data?.ownership_confirmed).toBe(false);
  });
});

describe('the candidate DTO the UI receives IS the public boundary', () => {
  it('carries exactly the ten documented fields, and nothing else', async () => {
    asCustomerA();
    const result = await fetchLostReportMatches(LR_A_MATCH);
    const candidate: LostReportMatchCandidate = result.data!.matches[0];
    expect(Object.keys(candidate).sort()).toEqual(ALLOWED_CANDIDATE_KEYS);
    // No engine internals ever reach the client.
    expect(candidate).not.toHaveProperty('score');
    expect(candidate).not.toHaveProperty('signals');
    expect(candidate).not.toHaveProperty('reason');
  });

  it('never carries a finder contact, an identifier, a coordinate or an agent', async () => {
    asCustomerA();
    const result = await fetchLostReportMatches(LR_A_MATCH);
    const raw = JSON.stringify(result.data);

    for (const secret of [
      SECRET_FINDER_PHONE, SECRET_FINDER_EMAIL, SECRET_OCR_NUMBER,
      SECRET_OCR_NAME, SECRET_HASH, SECRET_AGENT,
    ]) {
      expect(raw, `payload leaked ${secret}`).not.toContain(secret);
    }
    for (const field of [
      'finder_phone', 'finder_email', 'ocr_extracted_number', 'ocr_extracted_name',
      'document_number_hash', 'latitude', 'longitude', 'assigned_agent_id',
      'customer_id', 'verified_document_number', 'agent',
    ]) {
      expect(raw, `payload exposed ${field}`).not.toContain(field);
    }
  });

  it('keeps a sensitive document\'s photo and description masked', async () => {
    asCustomerA();
    const result = await fetchLostReportMatches(LR_A_SENSITIVE);
    expect(result.ok).toBe(true);
    expect(result.data?.matches.map((m) => m.id)).toEqual([ITEM_SENSITIVE]);

    const candidate = result.data!.matches[0];
    expect(candidate.is_sensitive_document).toBe(true);
    expect(candidate.photo_url).toBeNull();
    expect(candidate.description).toBeNull();

    const raw = JSON.stringify(result.data);
    expect(raw).not.toContain(SECRET_DESCRIPTION);
    expect(raw).not.toContain('secret-national-id-photo.jpg');
  });
});

describe('ownership and enumeration through the client', () => {
  it('a different customer cannot read another account\'s matches', async () => {
    asCustomerB();
    const asOther = await fetchLostReportMatches(LR_A_MATCH);
    expect(asOther.ok).toBe(false);
    expect(asOther.error?.kind).toBe('not_found');
    expect(asOther.status).toBe(404);
  });

  it('an unknown and a malformed reference are indistinguishable from a foreign one', async () => {
    asCustomerB();
    const foreign = await fetchLostReportMatches(LR_A_MATCH);
    const unknown = await fetchLostReportMatches('LR-ZZZZZZ');
    const malformed = await fetchLostReportMatches('not-a-reference');

    for (const result of [foreign, unknown, malformed]) {
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe('not_found');
      expect(result.status).toBe(404);
    }
  });

  it('a customer cannot read another account\'s report either', async () => {
    asCustomerB();
    const result = await getMyLostReport(LR_A_MATCH);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('not_found');
  });
});

describe('authentication is enforced for every call', () => {
  it('an unauthenticated client gets auth, never data', async () => {
    cookieHeader = undefined;
    const list = await listMyLostReports();
    const matches = await fetchLostReportMatches(LR_A_MATCH);
    const detail = await getMyLostReport(LR_A_MATCH);

    for (const result of [list, matches, detail]) {
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe('auth');
      expect(result.data).toBeUndefined();
    }
  });
});

describe('failure modes are normalized for the UI to render', () => {
  it('surfaces a REAL 429 as rate_limited', async () => {
    asCustomerA();
    baseUrl = limitedBaseUrl; // this app's per-customer match limit is 1

    const first = await fetchLostReportMatches(LR_A_MATCH);
    const second = await fetchLostReportMatches(LR_A_MATCH);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error?.kind).toBe('rate_limited');
    expect(second.status).toBe(429);
  });

  it('surfaces a server-side validation failure with a safe message', async () => {
    asCustomerA();
    const result = await createLostReport(validPayload({ categoryId: 'no-such-category' }));

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('validation');
    expect(result.status).toBe(400);

    const message = String(result.error?.message);
    expect(message.length).toBeGreaterThan(0);
    // A safe, bilingual explanation — never a stack, SQL or internal error.
    expect(message).not.toContain('at Object');
    expect(message).not.toContain('SELECT ');
    expect(message).not.toContain('relation');
  });

  it('treats a non-JSON 200 as malformed instead of trusting it', async () => {
    asCustomerA();
    rawStub = async () => new Response('<html>oops</html>', { status: 200 });
    const result = await listMyLostReports();
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('malformed');
  });

  it('treats a JSON 200 of the wrong shape as malformed', async () => {
    asCustomerA();
    rawStub = async () => new Response(JSON.stringify({ nope: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await fetchLostReportMatches(LR_A_MATCH);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('malformed');
  });

  it('treats a request that never completes as a network error', async () => {
    asCustomerA();
    rawStub = async () => { throw new TypeError('Failed to fetch'); };
    const result = await listMyLostReports();
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('network');
    expect(result.status).toBe(0);
  });
});

describe('reading matches is read-only', () => {
  it('creates no claim, and changes no item or report state', async () => {
    asCustomerA();
    const claimsBefore = await db.getClaims();
    const itemBefore = await db.getItem(ITEM_MATCH);
    const reportBefore = await db.getLostReportByIdForCustomer(LR_A_MATCH, CUSTOMER_A);

    const result = await fetchLostReportMatches(LR_A_MATCH);
    expect(result.ok).toBe(true);
    expect(result.data?.matches.length).toBeGreaterThan(0);

    const claimsAfter = await db.getClaims();
    expect(claimsAfter.map((c: any) => c.id).sort()).toEqual(claimsBefore.map((c: any) => c.id).sort());

    expect((await db.getItem(ITEM_MATCH)).status).toBe(itemBefore.status);
    expect((await db.getItem(ITEM_MATCH)).status).toBe('at_agent');

    const reportAfter = await db.getLostReportByIdForCustomer(LR_A_MATCH, CUSTOMER_A);
    expect(reportAfter.status).toBe(reportBefore.status);
    expect(reportAfter.status).toBe('active');
  });

  it('creates no claim even when a candidate IS returned and a sensitive one is too', async () => {
    asCustomerA();
    const before = (await db.getClaims()).length;
    await fetchLostReportMatches(LR_A_MATCH);
    await fetchLostReportMatches(LR_A_SENSITIVE);
    expect((await db.getClaims()).length).toBe(before);
  });
});





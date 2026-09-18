import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';

// ===========================================================================
// P14A (P14-08) — GET /api/regions / db.getDistinctRegions(): CURRENT CONTRACT
//
// The P14 forensic audit found ZERO coverage of this endpoint. This suite pins
// what it does TODAY, before any later location phase replaces it. It is
// deliberately NOT a redesign: nothing here asserts that the current list is
// the right model — only that the shipped behaviour, the public (unauthenticated)
// access policy, and the "no markup, no SQL interpolation" properties hold.
//
// WHY NO HTTP CALL: this route is registered inline inside src/server.ts, which
// has no exports and performs large top-level side-effecting setup, so it cannot
// be mounted by a test (the same constraint documented for the other inline
// routes). The handler is therefore covered by source assertions plus real tests
// of the DB function it delegates to.
// ===========================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// NOTE: anchors are located in the RAW source and comments are stripped only
// from the SLICE. Why: server.ts contains bare `/*`-looking tokens (a stray
// block-comment opener) that make a naive whole-file comment stripper swallow
// everything up to the next `*/` — including the /api/regions registration,
// which would then look "missing" to the test rather than to the reader.
const SERVER_RAW = read('src/server.ts');
const DATABASE_RAW = read('src/db/database.ts');

/** The live route registration + its handler body (comments removed). */
function regionsRouteBody(): string {
  const start = SERVER_RAW.indexOf("app.get('/api/regions'");
  expect(start, 'GET /api/regions not found in server.ts').toBeGreaterThan(-1);
  const rest = SERVER_RAW.slice(start);
  const next = rest.search(/\n {2}app\.[a-z]+\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next + 1));
}

/** The getDistinctRegions() implementation body (comments removed). */
function getDistinctRegionsBody(): string {
  const start = DATABASE_RAW.indexOf('public async getDistinctRegions(');
  expect(start, 'db.getDistinctRegions not found in database.ts').toBeGreaterThan(-1);
  const rest = DATABASE_RAW.slice(start);
  const next = rest.search(/\n {2}public async /);
  return stripComments(next === -1 ? rest : rest.slice(0, next + 1));
}

const FALLBACK_REGIONS = [
  'Kilimani', 'Westlands', 'Nairobi CBD', 'Kileleshwa', 'Karen',
  'Ngong Road', 'Mombasa', 'Kisumu', 'Nakuru', 'Eldoret',
  'Kisii', 'Thika', 'Machakos', 'Nyeri', 'Kakamega',
  'Lavington', 'Hurlingham', 'South C', 'South B', 'Langata',
  'Runda', 'Muthaiga', 'Gigiri', 'Parklands', 'Madaraka',
  'Donholm', 'Buruburu', 'Eastleigh', 'Embakasi', 'Ruiru',
];

async function makeItem(id: string, locationDescription: string) {
  await ensureTestCategory('phone');
  await db.createItem({
    id,
    category_id: 'phone',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: locationDescription,
    latitude: null,
    longitude: null,
    finder_phone: '+254700000031',
    assigned_agent_id: null,
    status: 'awaiting_dropoff',
    flaggedForReview: false,
    isDescriptionOnly: true,
    description: 'P14A regions fixture',
    is_sensitive_document: false,
    rejection_reason: null,
  } as any);
}

describe('GET /api/regions — response shape and access policy (source contract)', () => {
  it('is registered as a plain, unauthenticated GET that delegates to the DB layer', () => {
    const body = regionsRouteBody();
    expect(body).toContain("app.get('/api/regions'");
    expect(body).toContain('db.getDistinctRegions()');
    // Current intended policy: this is a PUBLIC endpoint — no auth middleware.
    expect(body).not.toContain('authenticateJWT');
    expect(body).not.toContain('requireCurrentAdminSession');
  });

  it('responds with JSON (never HTML), so nothing here can render markup', () => {
    const body = regionsRouteBody();
    expect(body).toMatch(/res\.json\(regions\)/);
    expect(body).not.toMatch(/res\.(send|sendFile|render)\(/);
  });

  it('remains inside the global /api rate limiter', () => {
    expect(SERVER_RAW).toContain("app.use('/api', generalLimiter)");
  });

  it('builds its query with drizzle (no interpolation of user input into SQL)', () => {
    const body = getDistinctRegionsBody();
    expect(body).toContain('drizzleDb.select(');
    expect(body).toContain('itemsTable');
    // No hand-built SQL, and no template-literal interpolation at all.
    expect(body).not.toMatch(/`[^`]*\$\{/);
  });
});

describe('GET /api/regions — current data behaviour', () => {
  // ORDER MATTERS: this first case requires an items table with no location rows.
  it('returns the static fallback list when no stored locations exist', async () => {
    const regions = await db.getDistinctRegions();
    expect(Array.isArray(regions)).toBe(true);
    expect(regions).toEqual(FALLBACK_REGIONS);
    for (const value of regions) expect(typeof value).toBe('string');
  });

  it('surfaces stored locations, de-duplicated, with the fallbacks unioned in', async () => {
    const stored = `Zp14aRegion${testRunId}`;
    await makeItem(`TEST-REGION-A-${testRunId}`, stored);
    await makeItem(`TEST-REGION-B-${testRunId}`, stored); // same value twice
    await makeItem(`TEST-REGION-C-${testRunId}`, `Yp14aRegion${testRunId}`);

    const regions = await db.getDistinctRegions();

    // Distinct: two items shared one location, so it appears once.
    expect(regions.filter((r) => r === stored)).toHaveLength(1);
    expect(regions).toContain(`Yp14aRegion${testRunId}`);
    // The fallback entries are still present (they are unioned, not replaced).
    for (const fallback of FALLBACK_REGIONS) {
      expect(regions, `fallback ${fallback} must still be offered`).toContain(fallback);
    }
    // Most frequent first: the shared value outranks the single-use one.
    expect(regions.indexOf(stored)).toBeLessThan(regions.indexOf(`Yp14aRegion${testRunId}`));
  });

  it('returns the stored value verbatim (the endpoint adds no markup)', async () => {
    const raw = `Xp14aRaw${testRunId}`;
    await makeItem(`TEST-REGION-D-${testRunId}`, raw);
    const regions = await db.getDistinctRegions();
    expect(regions).toContain(raw);
    for (const value of regions) {
      expect(typeof value).toBe('string');
      expect(value).not.toMatch(/<\/script>/i);
    }
  });
});

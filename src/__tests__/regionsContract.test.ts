import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolveCountyName, countiesByUxGroup } from '../config/kenyaCounties';

// ===========================================================================
// PHASE 16.1 (GEO-16-07) — THE LEGACY /api/regions CONTRACT IS RETIRED
//
// The P14A suite this file replaces pinned the SHIPPED behaviour of
// GET /api/regions and db.getDistinctRegions(): a flat list built from
// items.location_description, unioned with a hard-coded 30-entry fallback of
// Nairobi estates, towns and roads. That vocabulary mixed counties with areas
// and was derived from every item whatever its status.
//
// The Phase 16.1 geography audit flagged it under GEO-16-07 for exactly those
// reasons, and GEO-16-01 additionally found it was the source of the Owner
// search's misleading "Regions" selector. Both the endpoint and its DB method
// were therefore removed together, and the public replacement is the canonical,
// structured county filter on GET /api/items/search?county=. That replacement's
// behaviour is covered by a REAL test of the matching predicate in
// src/__tests__/countyAwareSearchAndSurfacing.test.ts, and the 47-county
// dataset itself is covered by src/__tests__/countySelectorExactPlace.test.ts.
//
// THIS FILE THEREFORE VERIFIES THE RETIREMENT, and it is not a deletion of the
// old coverage: the old suite's two substantive guarantees survive as
// equivalent assertions — (a) the public search surface stays inside the global
// /api rate limiter, and (b) the location vocabulary offered to the public is
// canonical, not an uncontrolled dump of reporter-entered text.
//
// WHY NO HTTP CALL: /api/regions was registered inline inside src/server.ts,
// which has no exports and performs large top-level side-effecting setup, so it
// was never mountable by a test (the constraint the P14A file documented). The
// retirement is provable from the source: a registered route cannot exist
// without its registration text, and a consumer cannot call what it does not
// name.
// ===========================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Anchors and absence checks use the RAW source, deliberately: this file asserts
// that a specific registration/documentation token is gone, so it must not
// depend on a comment stripper that server.ts's stray block-comment opener can
// throw off (the hazard documented by the P14A version of this suite).
const SERVER_RAW = read('src/server.ts');
const DATABASE_RAW = read('src/db/database.ts');

/** Every application source file (tests excluded — they may quote history). */
function appSourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  return walk(path.resolve(repoRoot, 'src'));
}

/**
 * The retired fallback vocabulary, verbatim, so the historical reasoning below
 * is checkable rather than asserted from memory. This lives in a TEST file: the
 * repository-wide anti-duplication guard in countySelectorExactPlace.test.ts
 * skips __tests__, and nothing in application source may contain it again.
 */
const RETIRED_FALLBACK_AREAS = [
  'Kilimani', 'Westlands', 'Nairobi CBD', 'Kileleshwa', 'Karen',
  'Ngong Road', 'Mombasa', 'Kisumu', 'Nakuru', 'Eldoret',
  'Kisii', 'Thika', 'Machakos', 'Nyeri', 'Kakamega',
  'Lavington', 'Hurlingham', 'South C', 'South B', 'Langata',
  'Runda', 'Muthaiga', 'Gigiri', 'Parklands', 'Madaraka',
  'Donholm', 'Buruburu', 'Eastleigh', 'Embakasi', 'Ruiru',
];

// ---------------------------------------------------------------------------
// 1. THE OBSOLETE CONTRACT IS GONE
// ---------------------------------------------------------------------------
describe('GEO-16-07 — GET /api/regions is retired (route, method and consumers)', () => {
  it('no longer registers the route', () => {
    expect(SERVER_RAW).not.toContain("app.get('/api/regions'");
    expect(SERVER_RAW).not.toContain('db.getDistinctRegions');
  });

  it('no longer implements getDistinctRegions in the data layer', () => {
    expect(DATABASE_RAW).not.toContain('public async getDistinctRegions');
    expect(stripComments(DATABASE_RAW)).not.toContain('fallbackRegions');
  });

  it('has no remaining consumer anywhere in application source', () => {
    const offenders = appSourceFiles()
      .filter((file) => {
        const rel = path.relative(repoRoot, file).split(path.sep).join('/');
        const body = stripComments(fs.readFileSync(file, 'utf8'));
        return body.includes("'/api/regions'") || body.includes('"/api/regions"') || body.includes('getDistinctRegions');
      })
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'));
    expect(offenders, `still referencing the retired endpoint: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no longer presents an "All Regions" list to the public', () => {
    expect(SERVER_RAW).not.toContain('-- All Regions --');
    for (const file of appSourceFiles()) {
      const body = stripComments(fs.readFileSync(file, 'utf8'));
      expect(body, path.basename(file)).not.toContain('-- All Regions --');
    }
  });

  it('the retired fallback vocabulary is verifiably NOT a county list', () => {
    // Why retirement was the right fix rather than a filter: 23 of the 30
    // entries were never counties at all, so no amount of canonicalisation could
    // have made this list a legitimate county selector.
    const notCounties = RETIRED_FALLBACK_AREAS.filter((area) => resolveCountyName(area) === null);
    const coincidentalCounties = RETIRED_FALLBACK_AREAS.filter((area) => resolveCountyName(area) !== null);
    expect(notCounties.length).toBe(23);
    expect(coincidentalCounties.sort()).toEqual(
      ['Kakamega', 'Kisii', 'Kisumu', 'Machakos', 'Mombasa', 'Nakuru', 'Nyeri'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. THE REPLACEMENT IS WIRED (canonical county search)
// ---------------------------------------------------------------------------
describe('GEO-16-07 — the canonical county search is the replacement', () => {
  it('the public search accepts a validated canonical county parameter', () => {
    expect(SERVER_RAW).toContain('resolveCountyName(county)');
    expect(SERVER_RAW).toContain('FOUND_COUNTY_MESSAGES.invalid');
    expect(SERVER_RAW).toContain('itemMatchesCanonicalCounty(item, countyFilter');
  });

  it('the county options come from the ONE canonical dataset, not from item rows', () => {
    const flattened = countiesByUxGroup().flatMap((group) => group.counties);
    expect(flattened.length).toBe(47);
    expect(flattened.every((c) => resolveCountyName(c.name) === c.name)).toBe(true);
    // None of the retired area strings can be selected as a county.
    for (const area of RETIRED_FALLBACK_AREAS) {
      const canonical = resolveCountyName(area);
      if (canonical) expect(flattened.map((c) => c.name)).toContain(canonical);
    }
  });

  it('no data-layer query derives a public location vocabulary from item rows', () => {
    const database = stripComments(DATABASE_RAW);
    expect(database).not.toContain('getDistinctRegions');
    expect(database).not.toContain('fallbackRegions');
    // The county filter is an equality on the canonical column.
    expect(database).toContain('eq(lostReportsTable.county, county)');
  });
});

// ---------------------------------------------------------------------------
// 3. THE SAFETY PROPERTIES THE RETIRED SUITE GUARANTEED (still hold)
// ---------------------------------------------------------------------------
describe('GEO-16-07 — the properties the old suite protected are preserved', () => {
  it('the public search surface stays inside the global /api rate limiter', () => {
    expect(SERVER_RAW).toContain("app.use('/api', generalLimiter)");
  });

  it('the public county filter stays unauthenticated, like the search it belongs to', () => {
    // Scoped to the search route itself so the check cannot be satisfied by an
    // unrelated authenticated route.
    const routeStart = SERVER_RAW.indexOf("app.get('/api/items/search'");
    expect(routeStart).toBeGreaterThan(-1);
    const rest = SERVER_RAW.slice(routeStart);
    const next = rest.search(/\n {2}app\.[a-z]+\(/);
    const route = stripComments(next === -1 ? rest : rest.slice(0, next + 1));
    expect(route).not.toContain('authenticateJWT');
    expect(route).not.toContain('requireCurrentAdminSession');
    // JSON only — nothing here can render markup.
    expect(route).toMatch(/res\.json\(/);
    expect(route).not.toMatch(/res\.(send|sendFile|render)\(/);
  });
});

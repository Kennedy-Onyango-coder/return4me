import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolveCountyName, countiesByUxGroup, KENYA_COUNTY_NAMES } from '../config/kenyaCounties';
import { itemMatchesCanonicalCounty, resolveFoundCountyInput } from '../services/foundItemCounty';
import { toPublicItemView } from '../services/publicItemView';
import { toLostReportMatchCandidateView } from '../services/lostReportMatchView';
import { db } from '../db/database';
import { ensureTestCategory, testRunId } from '../db/__tests__/ensureTestCategory';

// ===========================================================================
// PHASE 16.1 — COUNTY-AWARE PUBLIC SEARCH AND COUNTY SURFACING
// (GEO-16-01, GEO-16-03)
//
// WHAT IS PROVEN HERE
//   1. The county filter's matching rule: canonical equality on the item's
//      DECLARED county (`items.found_county`), never on free text, coordinates
//      or an agent address — plus the deliberate legacy-NULL policy.
//   2. The canonicalisation the filter depends on (aliases included).
//   3. The three wirings that cannot be exercised at runtime in this repository:
//      the inline GET /api/items/search handler (server.ts has no exports and
//      boots at import time — the constraint already documented in
//      regionsContract.test.ts and foundItemCounty.test.ts), the Owner search
//      component and the public item page (no jsdom / RTL exists here).
//
// BEHAVIOURAL FIRST: everything that CAN be exercised at runtime (the matching
// predicate, the resolver, the public DTO, the candidate view, the persisted
// row round trip) is asserted by CALLING it. Source assertions are used only
// where the runtime harness genuinely does not exist, which is the established
// convention of this repository.
// ===========================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Anchors are located in the RAW source and comments stripped from the SLICE. */
const SERVER_RAW = read('src/server.ts');

function searchRouteBody(): string {
  const start = SERVER_RAW.indexOf("app.get('/api/items/search'");
  expect(start, 'GET /api/items/search not found in server.ts').toBeGreaterThan(-1);
  const rest = SERVER_RAW.slice(start);
  const next = rest.search(/\n {2}app\.[a-z]+\(/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  return stripComments(body);
}

const OWNER = stripComments(read('src/components/OwnerView.tsx'));
const PUBLIC_ITEM = stripComments(read('src/components/PublicItemView.tsx'));
const POSSIBLE_MATCHES = stripComments(read('src/components/customer/PossibleMatches.tsx'));

// ---------------------------------------------------------------------------
// 1. THE MATCHING RULE (behavioural — this is the function the route calls)
// ---------------------------------------------------------------------------
describe('GEO-16-01 — a county search matches the DECLARED county, never the free text', () => {
  it('matches when the declared county agrees, even though the words share nothing', () => {
    // The whole point of the structured filter: the Finder declared Mombasa and
    // wrote "Nyali" as the exact place. "Nyali" contains no county name at all.
    const item = { found_county: 'Mombasa', location_description: 'Nyali' };
    expect(resolveCountyName('Nyali')).toBeNull();
    expect(itemMatchesCanonicalCounty(item, 'Mombasa')).toBe(true);
  });

  it('does not match a different declared county', () => {
    const item = { found_county: 'Kilifi', location_description: 'Nyali' };
    expect(itemMatchesCanonicalCounty(item, 'Mombasa')).toBe(false);
  });

  it('does NOT match a legacy row whose free text happens to say "Mombasa Road"', () => {
    // The exact false positive Phase 9D removed: "Mombasa Road" is a Nairobi
    // street (and the A109). A NULL county must never be read as Mombasa.
    const legacy = { found_county: null, location_description: 'Mombasa Road' };
    expect(resolveCountyName('Mombasa Road')).toBeNull();
    expect(itemMatchesCanonicalCounty(legacy, 'Mombasa')).toBe(false);
  });

  it('does not match a row where the field is absent entirely (pre-Phase-9D shape)', () => {
    const prePhase9d: any = { location_description: 'Mombasa Road, Nairobi' };
    expect(itemMatchesCanonicalCounty(prePhase9d, 'Mombasa')).toBe(false);
  });

  it('is safe on a missing item', () => {
    expect(itemMatchesCanonicalCounty(null, 'Mombasa')).toBe(false);
    expect(itemMatchesCanonicalCounty(undefined, 'Mombasa')).toBe(false);
  });

  it('compares CANONICAL values on both sides (the alias must be resolved first)', () => {
    const nairobiRow = { found_county: 'Nairobi City', location_description: 'Westlands' };
    // Resolved input matches the stored canonical value...
    expect(itemMatchesCanonicalCounty(nairobiRow, resolveCountyName('nairobi') as string)).toBe(true);
    // ...whereas the raw user string would not: the filter never does fuzzy or
    // case-insensitive matching, because nothing else in the platform writes a
    // non-canonical value into the column.
    expect(itemMatchesCanonicalCounty(nairobiRow, 'nairobi')).toBe(false);
    expect(itemMatchesCanonicalCounty({ found_county: 'mombasa' }, 'Mombasa')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. THE RESOLVER THE FILTER DELEGATES TO (behavioural)
// ---------------------------------------------------------------------------
describe('GEO-16-01 — the county parameter canonicalises exactly like every other county input', () => {
  it('resolves canonical names and the documented aliases to the same county', () => {
    expect(resolveCountyName('Mombasa')).toBe('Mombasa');
    expect(resolveCountyName('Nairobi City')).toBe('Nairobi City');
    expect(resolveCountyName('nairobi')).toBe('Nairobi City');
    expect(resolveCountyName('Homa Bay')).toBe('Homa Bay');
    expect(resolveCountyName('homa bay')).toBe('Homa Bay');
    expect(resolveCountyName("Murang'a")).toBe("Murang'a");
    expect(resolveCountyName('muranga')).toBe("Murang'a");
    expect(resolveCountyName('  MOMBASA ')).toBe('Mombasa');
  });

  it('resolves nothing for an area, a town, a street or junk — so none can become a county match', () => {
    for (const notACounty of ['Kilimani', 'Westlands', 'Nairobi CBD', 'Nyali', 'Mombasa Road', 'Thika', 'Atlantis', '', '12345']) {
      expect(resolveCountyName(notACounty), notACounty).toBeNull();
    }
  });

  it('accepts every one of the 47 canonical names (the selector can never offer a rejected value)', () => {
    for (const name of KENYA_COUNTY_NAMES) {
      expect(resolveCountyName(name), name).toBe(name);
    }
    const all = countiesByUxGroup().flatMap((g) => g.counties);
    expect(all.length).toBe(47);
    expect(all.every((c) => resolveCountyName(c.name) === c.name)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. THE SEARCH ROUTE WIRING (source — the handler is inline in server.ts)
// ---------------------------------------------------------------------------
describe('GEO-16-01 — GET /api/items/search is wired to the structured county filter', () => {
  it('accepts an optional `county` parameter alongside the existing q/categoryId/area', () => {
    const body = searchRouteBody();
    expect(body).toContain('const { q, categoryId, area, county } = req.query;');
  });

  it('refuses a county that is not canonical instead of falling back to an area search', () => {
    const body = searchRouteBody();
    expect(body).toContain('resolveCountyName(county)');
    expect(body).toContain('FOUND_COUNTY_MESSAGES.invalid');
    // The refusal is the SAME bilingual 400 the found-item report route uses.
    expect(body).toMatch(/status\(400\)\.json\(\{ error: FOUND_COUNTY_MESSAGES\.invalid \}\)/);
  });

  it('filters on the item\'s declared county through the one shared predicate', () => {
    const body = searchRouteBody();
    expect(body).toMatch(/items = items\.filter\(item => itemMatchesCanonicalCounty\(item, countyFilter/);
    // The structured filter is NOT a text search: scoped to the county filter
    // block itself, no free-text field is consulted. (The legacy `area` filter
    // still searches location_description — that behaviour is preserved and is
    // asserted separately below.)
    const start = body.indexOf('if (countyFilter)');
    const end = body.indexOf('if (q) {');
    expect(start, 'county filter block not found').toBeGreaterThan(-1);
    expect(end, 'free-text query block not found').toBeGreaterThan(start);
    const countyBlock = body.slice(start, end);
    expect(countyBlock).toContain('itemMatchesCanonicalCounty');
    expect(countyBlock).not.toContain('location_description');
    expect(countyBlock).not.toContain('lowerCase');
  });

  it('applies the county filter AFTER the public-visibility/claimability filter', () => {
    const body = searchRouteBody();
    const visibilityAt = body.indexOf('claimabilityChecks.filter');
    const countyAt = body.indexOf('itemMatchesCanonicalCounty(item, countyFilter');
    expect(visibilityAt).toBeGreaterThan(-1);
    expect(countyAt).toBeGreaterThan(visibilityAt);
  });

  it('keeps q, categoryId and area working exactly as before (no silent reinterpretation)', () => {
    const body = searchRouteBody();
    expect(body).toContain("item.category_id === categoryId");
    expect(body).toContain('item.location_description.toLowerCase().includes(areaLower)');
    expect(body).toMatch(/if \(q\) \{/);
    expect(body).toContain('toPublicItemView(item, rawAgent)');
  });
});

// ---------------------------------------------------------------------------
// 4. THE OWNER COUNTY SELECTOR (source — no jsdom / RTL in this repository)
// ---------------------------------------------------------------------------
describe('GEO-16-01 — the Owner search offers the canonical counties, not an area list', () => {
  it('builds its county options from the ONE canonical dataset', () => {
    expect(OWNER).toContain("import { countiesByUxGroup } from '../config/kenyaCounties'");
    expect(OWNER).toContain('const COUNTY_GROUPS = countiesByUxGroup()');
    expect(OWNER).toMatch(/COUNTY_GROUPS\.map\(group => \(/);
    expect(OWNER).toMatch(/<optgroup key=\{group\.group\} label=\{group\.group\}>/);
    expect(OWNER).toMatch(/value=\{county\.name\}/);
  });

  it('sends the selected county as a STRUCTURED county parameter', () => {
    expect(OWNER).toMatch(/if \(selectedCounty\) params\.append\('county', selectedCounty\)/);
    // Exactly one county selector, and the exact-place search box is untouched.
    expect(OWNER.match(/value=\{selectedCounty\}/g)?.length).toBe(1);
    expect(OWNER).toMatch(/if \(searchQuery\) params\.append\('q', searchQuery\)/);
  });

  it('no longer consumes the retired /api/regions area vocabulary', () => {
    expect(OWNER).not.toContain("fetch('/api/regions')");
    expect(OWNER).not.toContain('selectedArea');
    expect(OWNER).not.toContain('All Regions');
    expect(OWNER).not.toContain('regionsLoading');
  });

  it('does not post the legacy `area` parameter as though it were a county', () => {
    expect(OWNER).not.toMatch(/params\.append\('area'/);
  });
});

// ---------------------------------------------------------------------------
// 5. SURFACING THE COUNTY THROUGH THE PUBLIC READ MODEL (behavioural)
// ---------------------------------------------------------------------------
describe('GEO-16-03 — the canonical county is published through the ONE public projection', () => {
  const baseRow = {
    id: 'R4M-GEO16',
    category_id: 'phone',
    photo_url: 'https://cdn.example/p.jpg',
    document_name_fuzzy: 'Samsung',
    location_description: 'Nyali',
    description: 'black handset',
    isDescriptionOnly: false,
    is_sensitive_document: false,
    created_at: '2026-03-10T11:00:00.000Z',
    status: 'at_agent',
  };

  it('publishes found_county verbatim', () => {
    const view = toPublicItemView({ ...baseRow, found_county: 'Mombasa' }, null);
    expect(view.found_county).toBe('Mombasa');
    // The county comes from the county column, NOT from the location text.
    expect(view.location_description).toBe('Nyali');
  });

  it('publishes null — never a guess — when the item has no declared county', () => {
    expect(toPublicItemView({ ...baseRow, found_county: null }, null).found_county).toBeNull();
    expect(toPublicItemView({ ...baseRow }, null).found_county).toBeNull();
  });

  it('carries the county into a possible-match candidate, copied from the same read model', () => {
    const candidate = toLostReportMatchCandidateView(
      { ...baseRow, found_county: 'Kilifi' },
      { signals: { category_match: 'match' } },
    );
    expect(candidate.found_county).toBe('Kilifi');
    expect(candidate.location_description).toBe('Nyali');
    // The candidate still carries no private location fact.
    expect(candidate).not.toHaveProperty('latitude');
    expect(candidate).not.toHaveProperty('longitude');
  });

  it('adds no finer geography than the county to the public item page or a candidate', () => {
    const view = toPublicItemView({ ...baseRow, found_county: 'Mombasa' }, null);
    for (const finer of ['sub_county', 'subcounty', 'city', 'town', 'ward', 'village', 'latitude', 'longitude']) {
      expect(view, `public DTO must not publish ${finer}`).not.toHaveProperty(finer);
    }
  });

  it('every consumer renders the DTO field rather than re-deriving a county', () => {
    // Search results, the public item page and the possible-match card.
    expect(OWNER).toContain('item.found_county');
    expect(PUBLIC_ITEM).toContain('item.found_county');
    expect(POSSIBLE_MATCHES).toContain('candidate.found_county');
    for (const [label, src] of [['OwnerView', OWNER], ['PublicItemView', PUBLIC_ITEM], ['PossibleMatches', POSSIBLE_MATCHES]] as const) {
      // No county is extracted, split or pattern-matched out of free text.
      expect(src, label).not.toMatch(/found_county\s*(\.split|\.match|\.replace|\.toLowerCase)/);
      expect(src, label).not.toContain('KENYA_COUNTY_NAMES');
      expect(src, label).not.toContain('/api/regions');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. THE POLICY AGAINST A REAL PERSISTED ROW (behavioural, real DB / mock DB)
// ---------------------------------------------------------------------------
let counter = 0;

async function makeItem(id: string, overrides: Record<string, any> = {}): Promise<void> {
  await ensureTestCategory('phone');
  await db.createItem({
    id,
    category_id: 'phone',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Somewhere',
    latitude: null,
    longitude: null,
    found_county: null,
    finder_phone: `+2541${testRunId}${Math.floor(counter++ % 10)}`,
    assigned_agent_id: null,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: true,
    description: 'GEO-16 fixture',
    is_sensitive_document: false,
    rejection_reason: null,
    ...overrides,
  } as any);
}

describe('GEO-16-01 — the declared county survives storage and drives the filter (real round trip)', () => {
  it('a canonical county with an unrelated exact place stores the COUNTY and matches it', async () => {
    const id = `TEST-GEO16-A-${testRunId}`;
    await makeItem(id, { found_county: 'Mombasa', location_description: 'Nyali' });

    const row = await db.getItem(id);
    expect(row?.found_county).toBe('Mombasa');
    expect(row?.location_description).toBe('Nyali');
    expect(resolveCountyName(row!.location_description)).toBeNull();
    expect(itemMatchesCanonicalCounty(row, 'Mombasa')).toBe(true);
    expect(itemMatchesCanonicalCounty(row, 'Kilifi')).toBe(false);
  });

  it('a row stored without a county stays NULL and matches NO county, even with "Mombasa Road" text', async () => {
    const id = `TEST-GEO16-B-${testRunId}`;
    await makeItem(id, { location_description: 'Mombasa Road' });

    const row = await db.getItem(id);
    expect(row?.found_county ?? null).toBeNull();
    // The row is NOT hidden or rewritten — the county filter simply cannot
    // claim it, which is exactly the legacy policy.
    expect(row?.location_description).toBe('Mombasa Road');
    expect(itemMatchesCanonicalCounty(row, 'Mombasa')).toBe(false);
    expect(itemMatchesCanonicalCounty(row, 'Nairobi City')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. THE FOUND-ITEM REPORT ROUTE (behavioural rule + source pin)
// ---------------------------------------------------------------------------
describe('GEO-16-01 — POST /api/items/report never infers a county from free text', () => {
  it('REFUSES a missing or invalid canonical county rather than guessing one', () => {
    for (const missing of [undefined, null, '', '   ']) {
      expect(resolveFoundCountyInput(missing).ok, JSON.stringify(missing)).toBe(false);
    }
    // The exact false-positive case: "Mombasa Road" is a street, not a county,
    // so it is refused and can never be stored as Mombasa County.
    const street = resolveFoundCountyInput('Mombasa Road');
    expect(street.ok).toBe(false);
    expect(street.county).toBeUndefined();
  });

  it('accepts a canonical county no matter what the exact-place text says', () => {
    expect(resolveFoundCountyInput('Mombasa')).toEqual({ ok: true, county: 'Mombasa' });
    expect(resolveFoundCountyInput('nairobi').county).toBe('Nairobi City');
    // ...and the exact place it is combined with is not a county at all.
    expect(resolveCountyName('Nyali')).toBeNull();
  });

  it('the route refuses before it can write, and stores the CANONICAL value (source pin)', () => {
    // /api/items/report is declared inside startServer() in server.ts, which
    // boots Vite middleware and background sweeps at import time, so the handler
    // cannot be mounted by a test. This is the same constraint — and the same
    // convention — documented at the top of
    // services/__tests__/foundItemCounty.test.ts, whose own route-wiring
    // assertions this extends rather than repeats.
    const routeStart = SERVER_RAW.indexOf("app.post('/api/items/report'");
    const routeEnd = SERVER_RAW.indexOf("app.get('/api/items/search'");
    expect(routeStart, 'POST /api/items/report not found').toBeGreaterThan(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const route = stripComments(SERVER_RAW.slice(routeStart, routeEnd));

    expect(route).toContain('resolveFoundCountyInput(foundCounty)');
    expect(route).toMatch(/if \(!foundCountyResolution\.ok\)[\s\S]{0,200}status\(400\)/);
    expect(route).toContain('found_county: canonicalFoundCounty');
    expect(route).toContain('location_description: locationDescription,');
    // The county column is never populated from the free-text location.
    expect(route).not.toMatch(/found_county:\s*[^,\n]*locationDescription/);
  });
});

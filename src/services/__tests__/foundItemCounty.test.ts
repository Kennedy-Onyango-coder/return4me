import { describe, it, expect } from 'vitest';
import { resolveFoundCountyInput, FOUND_COUNTY_MESSAGES } from '../foundItemCounty';

// ---------------------------------------------------------------------------
// PHASE 9D — the found-item county, VALIDATION layer.
//
// `resolveFoundCountyInput` is the exact function the report route calls, so
// this is real coverage of the shipping rule rather than a copy of it.
//
// (The route itself cannot be mounted in a unit test: POST /api/items/report is
// declared inside startServer() in server.ts, which boots Vite middleware and
// background sweeps at import time. The existing suites for that endpoint
// assert on its source for the same reason, and this phase follows that
// convention.)
// ---------------------------------------------------------------------------

describe('found-item county VALIDATION (the rule the report route applies)', () => {
  it('REQUIRES a county when it is missing or blank', () => {
    for (const missing of [undefined, null, '', '   ']) {
      const result = resolveFoundCountyInput(missing);
      expect(result.ok, JSON.stringify(missing)).toBe(false);
      expect(result.error).toBe(FOUND_COUNTY_MESSAGES.required);
      expect(result.county).toBeUndefined();
    }
  });

  it('REJECTS a non-string value', () => {
    for (const bad of [42, {}, [], true]) {
      const result = resolveFoundCountyInput(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      expect(result.error).toBe(FOUND_COUNTY_MESSAGES.invalid);
    }
  });

  it('REJECTS anything that is not a Kenyan county, without guessing', () => {
    for (const notACounty of ['Atlantis', 'Kampala', 'Westlands', 'Kitengela', 'Mombasa Road', '12345']) {
      const result = resolveFoundCountyInput(notACounty);
      expect(result.ok, notACounty).toBe(false);
      expect(result.error).toBe(FOUND_COUNTY_MESSAGES.invalid);
    }
  });

  it('NORMALIZES a canonical name to itself', () => {
    expect(resolveFoundCountyInput('Nairobi City')).toEqual({ ok: true, county: 'Nairobi City' });
    expect(resolveFoundCountyInput('Mombasa')).toEqual({ ok: true, county: 'Mombasa' });
  });

  it('NORMALIZES case, surrounding whitespace and known aliases', () => {
    // Uses the SAME `resolveCountyName` the lost-report route uses, so the two
    // sides of the platform can never canonicalize differently.
    expect(resolveFoundCountyInput('  nairobi ').county).toBe('Nairobi City');
    expect(resolveFoundCountyInput('MOMBASA').county).toBe('Mombasa');
    expect(resolveFoundCountyInput('muranga').county).toBe("Murang'a");
    expect(resolveFoundCountyInput('taita taveta').county).toBe('Taita-Taveta');
    expect(resolveFoundCountyInput('elgeyo marakwet').county).toBe('Elgeyo-Marakwet');
    expect(resolveFoundCountyInput('homa bay').county).toBe('Homa Bay');
  });

  it('accepts every one of the canonical 47 counties', async () => {
    const { KENYA_COUNTIES } = await import('../../config/kenyaCounties');
    expect(KENYA_COUNTIES).toHaveLength(47);
    for (const county of KENYA_COUNTIES) {
      const result = resolveFoundCountyInput(county.name);
      expect(result.ok, county.name).toBe(true);
      expect(result.county).toBe(county.name);
    }
  });

  it('never invents a county from a ROAD name (the Mombasa Road case)', () => {
    // "Mombasa Road" is a Nairobi street. It must never resolve to Mombasa
    // County — it is not a county at all, so it is rejected outright.
    expect(resolveFoundCountyInput('Mombasa Road').ok).toBe(false);
    expect(resolveFoundCountyInput('Kiambu Road').ok).toBe(false);
    expect(resolveFoundCountyInput('Nairobi-Mombasa Road').ok).toBe(false);
    // ...and the explicit county itself still works fine.
    expect(resolveFoundCountyInput('Kiambu').county).toBe('Kiambu');
  });
});

// ---------------------------------------------------------------------------
// STORAGE + MATCHING CONSUMPTION
//
// This is the part of the chain that IS reachable from a unit test: the real
// db layer and the real matcher.
// ---------------------------------------------------------------------------
import { selectLostReportCandidates, evaluateLostReportAgainstItem } from '../lostReportMatching';
import { db } from '../../db/database';
import { ensureTestCategory, testRunId } from '../../db/__tests__/ensureTestCategory';
import fs from 'fs';
import path from 'path';

async function makeItem(id: string, overrides: Record<string, any> = {}) {
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
    finder_phone: `+254${testRunId}9`,
    assigned_agent_id: null,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: true,
    description: 'A test item',
    is_sensitive_document: false,
    rejection_reason: null,
    ...overrides,
  } as any);
}

function lostReport(overrides: Record<string, any> = {}) {
  return {
    id: 'LR-9D-1',
    category_id: 'phone',
    status: 'active',
    county: 'Nairobi City',
    location_area: 'Zzzzz',
    location_landmark: null,
    lost_at_from: '2026-03-10T11:00:00.000Z',
    lost_at_to: '2026-03-10T14:00:00.000Z',
    document_number_hash: null,
    description: null,
    distinctive_marks: null,
    ...overrides,
  } as any;
}

describe('found_county is stored canonically and survives a round trip', () => {
  it('persists the canonical county and reads it back unchanged', async () => {
    const id = `TEST-9D-COUNTY-${testRunId}-A`;
    await makeItem(id, { found_county: 'Nairobi City' });

    const item = await db.getItem(id);
    expect(item?.found_county).toBe('Nairobi City');
    // The finder's own location wording is untouched by the county field.
    expect(item?.location_description).toBe('Somewhere');
  });

  it('leaves found_county NULL when it was not supplied (legacy-compatible)', async () => {
    const id = `TEST-9D-COUNTY-${testRunId}-B`;
    await makeItem(id, { found_county: null });

    const item = await db.getItem(id);
    expect(item?.found_county ?? null).toBeNull();
  });

  it('a pre-Phase-9D row (field absent entirely) still loads, with county UNKNOWN', async () => {
    const id = `TEST-9D-COUNTY-${testRunId}-C`;
    await ensureTestCategory('phone');
    await db.createItem({
      id,
      category_id: 'phone',
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'Legacy place',
      latitude: null,
      longitude: null,
      finder_phone: `+254${testRunId}8`,
      assigned_agent_id: null,
      status: 'at_agent',
      flaggedForReview: false,
      isDescriptionOnly: true,
      description: 'Legacy row',
      is_sensitive_document: false,
      rejection_reason: null,
      // deliberately NO found_county — exactly what a migrated legacy row has
    } as any);

    const item = await db.getItem(id);
    expect(item).toBeTruthy();
    expect(item?.found_county ?? null).toBeNull();
  });
});

describe('the matcher consumes the STORED canonical county', () => {
  it('a matching stored county plus a shared landmark becomes a candidate', async () => {
    const id = `TEST-9D-MATCH-${testRunId}-CORROB`;
    // The description carries the brand so there is a SECOND distinguishing
    // signal: county agreement and the shared landmark both feed the same
    // location signal, so on their own they are still just one signal — and the
    // existing policy requires two.
    await makeItem(id, {
      found_county: 'Nairobi City',
      location_description: 'Near Sarit Centre',
      description: 'Samsung handset',
      document_name_fuzzy: 'Samsung',
    });
    const item = await db.getItem(id);

    const lost = lostReport({ location_area: 'Westlands', location_landmark: 'Sarit Centre', brand: 'Samsung' });
    const candidates = selectLostReportCandidates(lost, [item!]);

    expect(candidates.map((c) => c.item.id)).toEqual([id]);
    expect(candidates[0].evaluation.signals.location_match).toBe('match');
    expect(candidates[0].evaluation.signals.brand_match).toBe('match');
    expect(candidates[0].evaluation.reason).toBe('corroborated_details');
  });

  it('a DIFFERENT stored county is eliminated', async () => {
    const id = `TEST-9D-MATCH-${testRunId}-DIFF`;
    await makeItem(id, { found_county: 'Mombasa', location_description: 'Zzzzz' });
    const item = await db.getItem(id);

    const evaluation = evaluateLostReportAgainstItem(lostReport(), item);
    expect(evaluation.signals.location_match).toBe('mismatch');
    expect(evaluation.reason).toBe('location_county_mismatch');
    expect(evaluation.candidate).toBe(false);
  });

  it('a matching stored county ALONE is still not enough to create a candidate', async () => {
    const id = `TEST-9D-MATCH-${testRunId}-SAMEONLY`;
    await makeItem(id, { found_county: 'Nairobi City', location_description: 'Qqqqq' });
    const item = await db.getItem(id);

    const evaluation = evaluateLostReportAgainstItem(lostReport(), item);
    expect(evaluation.signals.location_match).toBe('match');
    expect(evaluation.candidate).toBe(false);
    expect(evaluation.reason).toBe('insufficient_evidence');
  });

  it('a LEGACY item (NULL county) is still matchable and never eliminated on county', async () => {
    const id = `TEST-9D-MATCH-${testRunId}-LEGACY`;
    await makeItem(id, {
      found_county: null,
      location_description: 'Near Sarit Centre',
      description: 'Samsung handset',
      document_name_fuzzy: 'Samsung',
    });
    const item = await db.getItem(id);

    const lost = lostReport({ location_area: 'Westlands', location_landmark: 'Sarit Centre', brand: 'Samsung' });
    const candidates = selectLostReportCandidates(lost, [item!]);
    // Matchable on its real evidence (shared landmark + brand), with the absent
    // county contributing nothing in either direction.
    expect(candidates.map((c) => c.item.id)).toEqual([id]);
    expect(candidates[0].evaluation.signals.location_match).toBe('match');
  });
});

// ---------------------------------------------------------------------------
// ROUTE WIRING (source assertion — see the note at the top of this file)
// ---------------------------------------------------------------------------
describe('the found-item report route is wired to the canonical county rule', () => {
  const serverSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server.ts'), 'utf8');

  it('validates the county through the shared rule and returns 400 when it fails', () => {
    expect(serverSource).toContain('resolveFoundCountyInput(foundCounty)');
    expect(serverSource).toMatch(/if \(!foundCountyResolution\.ok\)[\s\S]{0,200}status\(400\)/);
  });

  it('stores the CANONICAL county on the item', () => {
    expect(serverSource).toContain('found_county: canonicalFoundCounty');
  });

  it('reads the county from the request body and keeps the free-text field separate', () => {
    expect(serverSource).toContain('foundCounty,');
    expect(serverSource).toContain('location_description: locationDescription,');
  });

  it('validates the county BEFORE the paid image/analysis path and before agent matching', () => {
    // Scoped to the report route itself, so an earlier `isValidImageSignature`
    // call in another route cannot make this pass or fail by accident.
    const routeStart = serverSource.indexOf("app.post('/api/items/report'");
    const routeEnd = serverSource.indexOf("app.get('/api/items/search'");
    expect(routeStart).toBeGreaterThan(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const route = serverSource.slice(routeStart, routeEnd);

    const countyAt = route.indexOf('resolveFoundCountyInput(foundCounty)');
    const imageAt = route.indexOf('isValidImageSignature(photoBase64)');
    const matchAt = route.indexOf('AgentMatchingService.assignNearestAgent');

    expect(countyAt).toBeGreaterThan(0);
    expect(imageAt).toBeGreaterThan(0);
    expect(matchAt).toBeGreaterThan(0);
    // Required-field and county checks come first, so an invalid county can
    // never trigger the billed OCR path or an outbound geocoding request.
    expect(countyAt).toBeLessThan(imageAt);
    expect(countyAt).toBeLessThan(matchAt);
  });
});


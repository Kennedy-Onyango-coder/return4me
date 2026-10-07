import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { toPublicItemView } from '../services/publicItemView';
import { toOwnerSafeAgentView } from '../services/ownerSafeViews';
import {
  LOCATION_SOURCES,
  ADVISORY_LOCATION_SOURCES,
  isLocationSource,
  isAdvisoryLocationSource,
} from '../services/locationProvenance';

// =============================================================================
// GEO-C — the location FOUNDATION across the app: the GPS/manual conflict
// surface (K), the honest UX copy (§12), the privacy/DTO boundary (N) and the
// "no arbitrary nearest-agent behaviour" guarantee (O), plus the provenance
// vocabulary (§7). The GPS contract itself is covered by
// services/__tests__/browserLocation.test.ts.
//
// This repository has no jsdom/React harness, so the component contract is
// asserted against the shipped source with the same comment stripper the other
// UX suites use. No snapshots and no line-number assertions.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const FINDER = stripComments(read('src/components/FinderView.tsx'));
const AGENT_VIEW = stripComments(read('src/components/AgentView.tsx'));
const BROWSER_LOCATION = stripComments(read('src/services/browserLocation.ts'));
const PUBLIC_ITEM_VIEW = read('src/services/publicItemView.ts');
const PUBLIC_ITEM_VIEW_CODE = stripComments(PUBLIC_ITEM_VIEW);

describe('GEO-C (K) a GPS suggestion never silently replaces an explicit selection', () => {
  it('surfaces the conflict in the finder, with an explicit replace warning', () => {
    expect(FINDER).toContain('hasGeographyConflict(foundCounty, detectedLocation.county)');
    expect(FINDER).toContain('Using this location will replace your selection.');
  });

  it('surfaces the conflict in agent signup, with an explicit replace warning', () => {
    expect(AGENT_VIEW).toContain('hasGeographyConflict(agentCounty, agentDetectedLocation.county)');
    expect(AGENT_VIEW).toContain('Using this location will replace your selection.');
  });

  it('does not apply the detected geography from the detection callback itself', () => {
    // Detection captures coordinates only. It must NOT write the county/unit.
    expect(FINDER).not.toContain('setFoundCounty(result.location.county)');
    expect(FINDER).not.toContain('setFoundAdministrativeUnit(result.location.subCountyId');
    expect(AGENT_VIEW).not.toContain('setAgentCounty(result.location.county)');
    expect(AGENT_VIEW).not.toContain('setAgentAdministrativeUnitId(result.location.subCountyId');
  });
});

describe('GEO-C (§12) honest location UX/copy', () => {
  it('never claims verification or exactness the system cannot support', () => {
    for (const banned of ['GPS verified', 'exact location', 'precisely located', 'GPS-confirmed']) {
      expect(FINDER, `finder says "${banned}"`).not.toContain(banned);
      expect(AGENT_VIEW, `agent view says "${banned}"`).not.toContain(banned);
    }
  });

  it('never leaks implementation vocabulary to customers', () => {
    for (const technical of ['reverse geocoder', 'point-in-polygon', 'spatial resolver', 'provenance']) {
      expect(FINDER, `finder leaks "${technical}"`).not.toContain(technical);
      expect(AGENT_VIEW, `agent view leaks "${technical}"`).not.toContain(technical);
    }
  });

  it('labels a coarse or unknown reading as an approximate suggestion', () => {
    expect(FINDER).toContain('Location accuracy is low');
    expect(FINDER).toContain('approximate suggestion');
    expect(AGENT_VIEW).toContain('Location accuracy is low');
    expect(AGENT_VIEW).toContain('approximate suggestion');
  });
});

describe('GEO-C (N) public DTOs never carry raw coordinates', () => {
  it('the public found-item view strips latitude/longitude and finder contact', () => {
    const view = toPublicItemView({
      id: 'item-1',
      category_id: 'phone',
      is_sensitive_document: false,
      photo_url: 'https://example/x.jpg',
      found_county: 'Nairobi City',
      administrative_unit_id: 'KE-47-SC-01',
      location_description: 'Near Sarit Centre',
      latitude: -1.2921,
      longitude: 36.8219,
      finder_phone: '0712345678',
      finder_email: 'finder@example.com',
    });
    expect(view).not.toHaveProperty('latitude');
    expect(view).not.toHaveProperty('longitude');
    expect(view).not.toHaveProperty('finder_phone');
    expect(view).not.toHaveProperty('finder_email');
    // The county-level fact IS published; the coarse geography is the finest we send.
    expect(view.found_county).toBe('Nairobi City');
  });

  it('the public item view source names no coordinate field', () => {
    // Checked against the CODE (comments stripped): the header comment names the
    // very fields it deliberately omits, so a raw-text grep would be a false hit.
    expect(PUBLIC_ITEM_VIEW_CODE).not.toMatch(/\blatitude\b/i);
    expect(PUBLIC_ITEM_VIEW_CODE).not.toMatch(/\blongitude\b/i);
  });

  it('documents the ONE intentional coordinate exposure (ownership-gated pickup details)', () => {
    // toOwnerSafeAgentView intentionally keeps agent coordinates for a legitimate
    // handover; it is NOT the public surface. This locks that decision in place
    // so a future public DTO cannot quietly inherit it.
    const agent = toOwnerSafeAgentView({
      id: 'agent-1',
      business_name: 'Hub',
      contact_phone: '0700000000',
      location_address: 'Moi Avenue, Nairobi',
      latitude: -1.28,
      longitude: 36.82,
    });
    expect(agent).toHaveProperty('latitude', -1.28);
    expect(agent).toHaveProperty('longitude', 36.82);
  });
});

describe('GEO-C (O) no arbitrary nearest-agent behaviour is introduced', () => {
  it('the location helper does not reach into matching or ranking', () => {
    expect(BROWSER_LOCATION).not.toMatch(/AgentMatchingService/);
    expect(BROWSER_LOCATION).not.toMatch(/\bnearest\b/i);
    expect(BROWSER_LOCATION).not.toMatch(/distanceKm|haversine/i);
  });
});

describe('GEO-C (§7) location provenance vocabulary — foundation only', () => {
  it('names the five sources exactly', () => {
    expect([...LOCATION_SOURCES]).toEqual([
      'browser_gps',
      'reverse_geocoder',
      'user_selected',
      'admin_corrected',
      'forward_geocoder',
    ]);
  });

  it('separates advisory sources from human decisions', () => {
    expect([...ADVISORY_LOCATION_SOURCES]).toEqual(['browser_gps', 'reverse_geocoder', 'forward_geocoder']);
    expect(isAdvisoryLocationSource('browser_gps')).toBe(true);
    expect(isAdvisoryLocationSource('reverse_geocoder')).toBe(true);
    expect(isAdvisoryLocationSource('user_selected')).toBe(false);
    expect(isAdvisoryLocationSource('admin_corrected')).toBe(false);
  });

  it('guards against an untrusted provenance value', () => {
    expect(isLocationSource('user_selected')).toBe(true);
    expect(isLocationSource('nonsense')).toBe(false);
    expect(isLocationSource(42)).toBe(false);
    expect(isLocationSource(null)).toBe(false);
  });

  it('does not persist or backfill anything (no migration in GEO-C)', () => {
    const source = read('src/services/locationProvenance.ts');
    // The foundation must not reach into the database layer at all...
    expect(source).not.toMatch(/from '.*db\//);
    expect(source).not.toMatch(/\bINSERT\b|\bUPDATE\b/);
    // ...but it DOES document the field a later migration would need, so the
    // deferred work is named rather than improvised.
    expect(source).toContain('location_source');
  });
});


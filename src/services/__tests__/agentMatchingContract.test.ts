import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  AgentMatchingService,
  calculateHaversineDistance,
  scopeCandidateAgents,
  preferSubCountyAgents,
  selectNearestAgent,
  buildAssignmentEvidence,
  type AgentAssignmentDeps,
} from '../agent';
import type { Agent } from '../../db/database';
import {
  deriveAssignmentConfidence,
  exceedsAssignmentRadius,
  isAgentAssignmentConfidence,
  AGENT_ASSIGNMENT_CONFIDENCES,
  MAX_AGENT_ASSIGNMENT_RADIUS_KM,
} from '../../config/geoMatching';

// =============================================================================
// GEO-E1 — NEAREST-AGENT MATCHING CONTRACT.
//
// WHY THIS SUITE EXISTS
//   The prerequisite audit found that the matcher had no way to state HOW
//   strong its routing evidence was, could not be tested without a database or
//   the external geocoder, and could not make a declared-county/coordinate
//   disagreement observable. GEO-E1 extracts a PURE, dependency-injected
//   decision core and adds a `confidence` tier + internal `evidence` record.
//
// HOW IT IS TESTED
//   Every test drives the REAL `assignNearestAgent` but with INJECTED
//   collaborators, so there is no database, no network, no global `fetch` and
//   no environment coupling. That independence is itself the GEO-E1 guarantee.
//
// WHAT IT MUST NEVER DO (pinned here)
//   Never pick an arbitrary Agent; never widen the declared county; never let a
//   coordinate override the declared county; never use reverse geocoding as
//   evidence; never claim a boundary was verified. A Haversine distance is how
//   far two coordinate pairs are apart — nothing more.
// =============================================================================

const NAIROBI = { lat: -1.2921, lon: 36.8219 };

function agent(partial: Partial<Agent> & { id: string }): Agent {
  return {
    business_name: `Hub ${partial.id}`,
    contact_phone: '+254700000000',
    location_address: 'Test address',
    latitude: null,
    longitude: null,
    county: null,
    administrative_unit_id: null,
    status: 'active',
    ...partial,
  } as unknown as Agent;
}

function deps(
  agents: Agent[],
  geocode?: (q: string) => Promise<{ latitude: number | null; longitude: number | null }>,
): AgentAssignmentDeps {
  return {
    getAgents: async () => agents,
    forwardGeocode: geocode ?? (async () => ({ latitude: null, longitude: null })),
  };
}

const NAIROBI_CITY = 'Nairobi City';

describe('GEO-E1 — existing matching semantics are preserved', () => {
  it('1. same county + valid GPS → nearest eligible Agent', async () => {
    const near = agent({ id: 'A', county: NAIROBI_CITY, latitude: -1.2922, longitude: 36.822 }); // ~30 m
    const far = agent({ id: 'B', county: NAIROBI_CITY, latitude: -1.35, longitude: 36.9 });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([far, near]),
    );
    expect(result.agent?.id).toBe('A');
    expect(result.method).toBe('gps_haversine');
    expect(result.needsManualAgentReassignment).toBe(false);
  });

  it('2. same county + same sub-county preference preserved (preference beats raw distance)', async () => {
    // B is geographically nearer, but only A is in the declared sub-county.
    const a = agent({ id: 'A', county: NAIROBI_CITY, administrative_unit_id: 'Westlands', latitude: -1.40, longitude: 36.90 });
    const b = agent({ id: 'B', county: NAIROBI_CITY, administrative_unit_id: 'Kasarani', latitude: -1.2922, longitude: 36.822 });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, 'Westlands', deps([a, b]),
    );
    expect(result.agent?.id).toBe('A');
    expect(result.method).toBe('gps_haversine');
  });

  it('3. equal distances → deterministic ascending-id tie-break', async () => {
    const b = agent({ id: 'B', county: NAIROBI_CITY, latitude: -1.3, longitude: 36.83 });
    const a = agent({ id: 'A', county: NAIROBI_CITY, latitude: -1.3, longitude: 36.83 });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([b, a]),
    );
    expect(result.agent?.id).toBe('A');
  });

  it('4. no active agents → manual', async () => {
    const suspended = agent({ id: 'A', status: 'suspended', county: NAIROBI_CITY, latitude: -1.2922, longitude: 36.822 });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', null, null, deps([suspended]),
    );
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    expect(result.needsManualAgentReassignment).toBe(true);
  });

  it('5. no same-county agents → manual (and never an out-of-county pick)', async () => {
    const outside = agent({ id: 'A', county: 'Mombasa', latitude: NAIROBI.lat, longitude: NAIROBI.lon });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([outside]),
    );
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
  });

  it('6. active agents but none with usable coordinates (geocoder also fails) → manual', async () => {
    const noCoords = agent({ id: 'A', county: NAIROBI_CITY, latitude: null, longitude: null });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, 'Nairobi CBD', NAIROBI_CITY, null, deps([noCoords]),
    );
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
  });

  it('7. GPS unavailable + successful forward geocode → geocoded match', async () => {
    const hub = agent({ id: 'A', county: NAIROBI_CITY, latitude: -1.29, longitude: 36.82 });
    const geocode = async () => ({ latitude: NAIROBI.lat, longitude: NAIROBI.lon });
    const result = await AgentMatchingService.assignNearestAgent(
      null, null, 'Nairobi CBD', NAIROBI_CITY, null, deps([hub], geocode),
    );
    expect(result.agent?.id).toBe('A');
    expect(result.method).toBe('geocoded_text');
  });

  it('8. GPS unavailable + geocoder failure → manual', async () => {
    const hub = agent({ id: 'A', county: NAIROBI_CITY, latitude: -1.29, longitude: 36.82 });
    const geocode = async () => ({ latitude: null, longitude: null });
    const result = await AgentMatchingService.assignNearestAgent(
      null, null, 'Nairobi CBD', NAIROBI_CITY, null, deps([hub], geocode),
    );
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
  });

  it('9. malformed coordinate pair → safe fallback (treated as "no coordinates")', async () => {
    const hub = agent({ id: 'A', county: NAIROBI_CITY, latitude: -1.29, longitude: 36.82 });
    const result = await AgentMatchingService.assignNearestAgent(
      Number.NaN, NAIROBI.lon, '', NAIROBI_CITY, null, deps([hub]),
    );
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
    // A single valid HALF is never a location.
    const half = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, null, '', NAIROBI_CITY, null, deps([hub]),
    );
    expect(half.agent).toBeNull();
  });

  it('10. invalid agent coordinate → excluded from distance comparison', async () => {
    const bad = agent({ id: 'A', county: NAIROBI_CITY, latitude: 5000, longitude: 36.82 });
    const good = agent({ id: 'B', county: NAIROBI_CITY, latitude: -1.35, longitude: 36.9 });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([bad, good]),
    );
    expect(result.agent?.id).toBe('B');

    // Only an invalid candidate → manual, never a guessed distance.
    const onlyBad = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([bad]),
    );
    expect(onlyBad.agent).toBeNull();
    expect(onlyBad.method).toBe('manual_required');
  });
});

describe('GEO-E1 — new evidence contract', () => {
  it('11-13. a GPS match reports gps_haversine, a real distanceKm and HIGH confidence', async () => {
    const hub = agent({ id: 'A', county: NAIROBI_CITY, latitude: -1.2922, longitude: 36.822 });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([hub]),
    );
    const expected = calculateHaversineDistance(NAIROBI.lat, NAIROBI.lon, -1.2922, 36.822);
    expect(result.method).toBe('gps_haversine');
    expect(result.distanceKm).not.toBeNull();
    expect(result.distanceKm).toBeCloseTo(expected, 1);
    expect(result.confidence).toBe('high');
    expect(result.needsManualAgentReassignment).toBe(false);
  });

  it('14-15. a geocoded match reports geocoded_text and MEDIUM confidence', async () => {
    const hub = agent({ id: 'A', county: NAIROBI_CITY, latitude: -1.29, longitude: 36.82 });
    const geocode = async () => ({ latitude: NAIROBI.lat, longitude: NAIROBI.lon });
    const result = await AgentMatchingService.assignNearestAgent(
      null, null, 'Nairobi CBD', NAIROBI_CITY, null, deps([hub], geocode),
    );
    expect(result.method).toBe('geocoded_text');
    expect(result.confidence).toBe('medium');
    expect(result.distanceKm).not.toBeNull();
  });

  it('16-18. a manual match reports manual confidence, a NULL distance and NO arbitrary Agent', async () => {
    const hub = agent({ id: 'A', county: 'Mombasa', latitude: NAIROBI.lat, longitude: NAIROBI.lon });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([hub]),
    );
    expect(result.method).toBe('manual_required');
    expect(result.confidence).toBe('manual');
    expect(result.distanceKm).toBeNull();
    expect(result.agent).toBeNull();
    expect(result.needsManualAgentReassignment).toBe(true);
  });
});

describe('GEO-E1 — safety guarantees', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const agentSource = fs.readFileSync(path.resolve(repoRoot, 'src', 'services', 'agent.ts'), 'utf8');

  it('19. the declared county remains the candidate filter', async () => {
    const inCounty = agent({ id: 'A', county: NAIROBI_CITY, latitude: -1.35, longitude: 36.9 });
    const otherCounty = agent({ id: 'B', county: 'Mombasa', latitude: -1.2922, longitude: 36.822 });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([inCounty, otherCounty]),
    );
    // B is nearer, but it is out of the declared county → never selected.
    expect(result.agent?.id).toBe('A');
  });

  it('20. a coordinate does NOT silently override the declared county', async () => {
    // The only Agent sits EXACTLY on the origin coordinate but in another county.
    const otherCounty = agent({ id: 'A', county: 'Mombasa', latitude: NAIROBI.lat, longitude: NAIROBI.lon });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([otherCounty]),
    );
    expect(result.agent).toBeNull();
    expect(result.method).toBe('manual_required');
  });

  it('21. the reverse geocoder cannot become matching evidence', () => {
    // The boundary exposes both forward and reverse; the matcher must reach only
    // the FORWARD path, and must make no network call of its own.
    expect(agentSource).toContain("from './geocoding/index.ts'");
    expect(agentSource).not.toContain('geocodeReverse');
    expect(agentSource).not.toMatch(/\bfetch\(/);
    expect(agentSource).not.toMatch(/https?:\/\//i);
  });

  it('22. the item coordinate stays a reporter/device routing position (no new coordinate meaning)', async () => {
    const hub = agent({ id: 'A', county: NAIROBI_CITY, latitude: -1.2922, longitude: 36.822 });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([hub]),
    );
    // The result contract adds NO coordinate field of its own.
    expect(Object.keys(result).sort()).toEqual(
      ['agent', 'confidence', 'distanceKm', 'evidence', 'method', 'needsManualAgentReassignment'],
    );
    expect(result.evidence.coordinate_present).toBe(true);
    expect(result.evidence.boundary_verified).toBe(false);
    // The source never relabels the routing coordinate as a found location.
    expect(agentSource).not.toMatch(/found[_ ]?lat|found[_ ]?lon|item[_ ]?lat|item[_ ]?lon/i);
  });

  it('23. an Agent coordinate_source never alters the meaning of the distance', async () => {
    const same = { county: NAIROBI_CITY, latitude: -1.3, longitude: 36.83 };
    const r1 = await AgentMatchingService.assignNearestAgent(NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null,
      deps([agent({ id: 'A', coordinate_source: 'browser_gps', ...same }), agent({ id: 'B', coordinate_source: 'admin_corrected', ...same })]));
    const r2 = await AgentMatchingService.assignNearestAgent(NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null,
      deps([agent({ id: 'A', coordinate_source: 'admin_corrected', ...same }), agent({ id: 'B', coordinate_source: 'browser_gps', ...same })]));
    // Swapping the two coordinate sources changes nothing: same pick, same distance.
    expect(r1.agent?.id).toBe('A');
    expect(r2.agent?.id).toBe('A');
    expect(r1.distanceKm).toBe(r2.distanceKm);
  });

  it('24. an admin-corrected Agent coordinate remains eligible for matching', async () => {
    const hub = agent({ id: 'A', county: NAIROBI_CITY, latitude: -1.2922, longitude: 36.822, coordinate_source: 'admin_corrected' });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([hub]),
    );
    expect(result.agent?.id).toBe('A');
    expect(result.method).toBe('gps_haversine');
    expect(result.confidence).toBe('high');
  });

  it('E2. no maximum radius is active — a same-county Agent is still selected however far away', async () => {
    // GEO-E1 deliberately does NOT invent a cutoff; this documents the unresolved
    // GEO-E2 decision by proving the current behaviour is unchanged.
    const distant = agent({ id: 'A', county: NAIROBI_CITY, latitude: -4.0, longitude: 39.0 });
    const result = await AgentMatchingService.assignNearestAgent(
      NAIROBI.lat, NAIROBI.lon, '', NAIROBI_CITY, null, deps([distant]),
    );
    expect(result.agent?.id).toBe('A');
    expect(result.distanceKm as number).toBeGreaterThan(100);
    expect(exceedsAssignmentRadius(result.distanceKm as number)).toBe(false);
    expect(MAX_AGENT_ASSIGNMENT_RADIUS_KM).toBeNull();
  });
});

describe('GEO-E1 — assignment-confidence vocabulary & derivation', () => {
  it('names exactly high/medium/manual and guards untrusted values', () => {
    expect([...AGENT_ASSIGNMENT_CONFIDENCES]).toEqual(['high', 'medium', 'manual']);
    expect(isAgentAssignmentConfidence('high')).toBe(true);
    expect(isAgentAssignmentConfidence('medium')).toBe(true);
    expect(isAgentAssignmentConfidence('manual')).toBe(true);
    expect(isAgentAssignmentConfidence('certain')).toBe(false);
    expect(isAgentAssignmentConfidence(null)).toBe(false);
    expect(isAgentAssignmentConfidence(1)).toBe(false);
  });

  it('derives a tier from the persisted method, and null for anything unrecognised', () => {
    expect(deriveAssignmentConfidence('gps_haversine')).toBe('high');
    expect(deriveAssignmentConfidence('geocoded_text')).toBe('medium');
    expect(deriveAssignmentConfidence('manual_required')).toBe('manual');
    expect(deriveAssignmentConfidence('manual_override')).toBe('manual');
    // Legacy/unrecognised values are UNKNOWN — never guessed into a tier.
    expect(deriveAssignmentConfidence('gps')).toBeNull();
    expect(deriveAssignmentConfidence(undefined)).toBeNull();
    expect(deriveAssignmentConfidence('nonsense')).toBeNull();
  });
});

describe('GEO-E1 — the pure decision core is independently testable', () => {
  it('scopeCandidateAgents keeps only active agents and narrows to the declared county', () => {
    const inCounty = agent({ id: 'A', county: NAIROBI_CITY });
    const otherCounty = agent({ id: 'B', county: 'Mombasa' });
    const suspended = agent({ id: 'C', status: 'suspended', county: NAIROBI_CITY });

    const scope = scopeCandidateAgents([inCounty, otherCounty, suspended], NAIROBI_CITY);
    expect(scope.activeAgents.map(a => a.id)).toEqual(['A', 'B']);
    expect(scope.scopedAgents.map(a => a.id)).toEqual(['A']);
    expect(scope.scopedToCounty).toBe(true);

    const open = scopeCandidateAgents([inCounty, otherCounty], null);
    expect(open.scopedAgents.map(a => a.id)).toEqual(['A', 'B']);
    expect(open.scopedToCounty).toBe(false);
  });

  it('preferSubCountyAgents prefers the declared unit but never drops scope when it is absent', () => {
    const west = agent({ id: 'A', administrative_unit_id: 'Westlands' });
    const kasa = agent({ id: 'B', administrative_unit_id: 'Kasarani' });
    expect(preferSubCountyAgents([west, kasa], 'Westlands').map(a => a.id)).toEqual(['A']);
    expect(preferSubCountyAgents([west, kasa], 'Embakasi').map(a => a.id)).toEqual(['A', 'B']);
    expect(preferSubCountyAgents([west, kasa], null).map(a => a.id)).toEqual(['A', 'B']);
  });

  it('selectNearestAgent skips unusable coordinates and tie-breaks by ascending id', () => {
    const bad = agent({ id: 'A', latitude: 999, longitude: 999 });
    const c = agent({ id: 'C', latitude: -1.3, longitude: 36.83 });
    const b = agent({ id: 'B', latitude: -1.3, longitude: 36.83 });
    const pick = selectNearestAgent(NAIROBI.lat, NAIROBI.lon, [bad, c, b]);
    expect(pick?.agent.id).toBe('B');
    expect(pick?.distanceKm).toBeCloseTo(calculateHaversineDistance(NAIROBI.lat, NAIROBI.lon, -1.3, 36.83), 6);
    expect(selectNearestAgent(NAIROBI.lat, NAIROBI.lon, [bad])).toBeNull();
    expect(selectNearestAgent(NAIROBI.lat, NAIROBI.lon, [])).toBeNull();
  });

  it('buildAssignmentEvidence records the inputs and never claims a boundary', () => {
    expect(buildAssignmentEvidence(NAIROBI_CITY, NAIROBI.lat, NAIROBI.lon)).toEqual({
      declared_geography_present: true,
      coordinate_present: true,
      boundary_verified: false,
    });
    expect(buildAssignmentEvidence(null, null, null)).toEqual({
      declared_geography_present: false,
      coordinate_present: false,
      boundary_verified: false,
    });
  });
});

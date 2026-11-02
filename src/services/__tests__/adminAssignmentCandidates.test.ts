import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  DISTANCE_UNAVAILABLE_LABEL,
  buildAssignmentCandidates,
  candidateDistanceKm,
  compareAssignmentCandidates,
  describeAssignmentCandidate,
  describeAssignmentRelation,
  excludedAssignmentCandidates,
  findAssignmentCandidate,
  formatCandidateDistance,
  selectableAssignmentCandidates,
} from '../adminAssignmentCandidates';
import { canonicalCounty } from '../agentGeography';
import { administrativeUnitNameForCounty, administrativeUnitsForCounty } from '../../config/kenyaAdministrativeUnits';
import { calculateHaversineDistance } from '../geoDistance';

// =============================================================================
// STAGE 3B-6D — THE ADMIN CONSOLE'S CANDIDATE LIST.
//
// The item-review panel used to build its "Assigned Agent Hub" dropdown from
// `dashboardData.agents.filter(status === 'active')` and to show a name and a
// street address. That single filter was wrong in two directions at once:
//   * `status === 'active'` is the business-approval axis, NOT the eligibility
//     rule (isAgentActionable() also requires a verified email and excludes
//     suspended/pending hubs), so an ineligible hub could be offered;
//   * nothing told the operator how the hub relates to the ITEM (same county?
//     same sub-county? another county?) or how far away it actually is.
// A wrong hub was one mis-click away, and the console looked equally confident
// whether the hub was next door or in the next county.
//
// These tests cover the pure projection that replaced it. They are deliberately
// about HONESTY, not about assignment:
//   * eligibility is COPIED from the server's verdict, never re-derived (a hub
//     can be `status: 'active'` and still not be selectable);
//   * a distance is a real Haversine distance between two valid coordinate
//     pairs or it is the words "Distance not available" — never 0 km, never a
//     centroid, never an estimate;
//   * mixed administrative levels are never treated as equivalent;
//   * ordering is total and deterministic, and no hub is dropped for being far
//     away (no maximum radius is invented here: MAX_AGENT_ASSIGNMENT_RADIUS_KM
//     remains disabled).
// =============================================================================

// Real county/sub-county identifiers from the shipped configuration: a test
// that used invented ids would prove nothing about the console, because the
// resolver would treat every value as unrecognised (i.e. "county_unknown").
const NAIROBI = canonicalCounty('Nairobi') as string;
const MOMBASA = canonicalCounty('Mombasa') as string;
const NAIROBI_UNITS = administrativeUnitsForCounty(NAIROBI);
const NAIROBI_UNIT_A = NAIROBI_UNITS[0]?.id as string;
const NAIROBI_UNIT_B = NAIROBI_UNITS[1]?.id as string;
const NAIROBI_UNIT_A_NAME = administrativeUnitNameForCounty(NAIROBI, NAIROBI_UNIT_A);
const MOMBASA_UNIT = administrativeUnitsForCounty(MOMBASA)[0]?.id as string;

// A report position in central Nairobi, plus hubs on the same parallel so the
// expected distances are checkable by hand: 0.1° of longitude at latitude
// 1.29°S is ~11.1 km, 0.02° is ~2.2 km.
const NAIROBI_CENTRE = { latitude: -1.2921, longitude: 36.8219 };

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hub-a',
    business_name: 'Hub A',
    location_address: 'Kimathi Street',
    status: 'active',
    county: NAIROBI,
    administrative_unit_id: NAIROBI_UNIT_A,
    latitude: NAIROBI_CENTRE.latitude,
    longitude: NAIROBI_CENTRE.longitude,
    actionable: true,
    ...overrides,
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    found_county: NAIROBI,
    administrative_unit_id: NAIROBI_UNIT_A,
    ...NAIROBI_CENTRE,
    ...overrides,
  };
}

describe('the shipped geography fixtures this suite relies on', () => {
  it('resolves real counties and two distinct Nairobi sub-counties', () => {
    expect(NAIROBI).toBeTruthy();
    expect(MOMBASA).toBeTruthy();
    expect(NAIROBI_UNITS.length).toBeGreaterThan(1);
    expect(NAIROBI_UNIT_A).not.toBe(NAIROBI_UNIT_B);
    expect(NAIROBI_UNIT_A_NAME).toBeTruthy();
    expect(MOMBASA_UNIT).toBeTruthy();
  });
});


describe('describeAssignmentRelation — the county/sub-county relationship', () => {
  it('recognises the same sub-county, ignoring case and surrounding space', () => {
    expect(describeAssignmentRelation({
      itemCounty: NAIROBI,
      itemAdministrativeUnitId: NAIROBI_UNIT_A,
      agentCounty: '  nairobi  ',
      agentAdministrativeUnitId: ` ${NAIROBI_UNIT_A.toLowerCase()} `,
    })).toBe('same_county_same_unit');
  });

  it('distinguishes a different sub-county in the same county', () => {
    expect(describeAssignmentRelation({
      itemCounty: NAIROBI,
      itemAdministrativeUnitId: NAIROBI_UNIT_A,
      agentCounty: NAIROBI,
      agentAdministrativeUnitId: NAIROBI_UNIT_B,
    })).toBe('same_county_different_unit');
  });

  it('never presents a missing sub-county as a match (mixed levels are not equivalent)', () => {
    // The item's sub-county must not be compared against a hub that records
    // none: "no sub-county recorded" is not evidence of the same sub-county.
    expect(describeAssignmentRelation({
      itemCounty: NAIROBI,
      itemAdministrativeUnitId: NAIROBI_UNIT_A,
      agentCounty: NAIROBI,
      agentAdministrativeUnitId: null,
    })).toBe('same_county_unit_unknown');
    expect(describeAssignmentRelation({
      itemCounty: NAIROBI,
      itemAdministrativeUnitId: '',
      agentCounty: NAIROBI,
      agentAdministrativeUnitId: NAIROBI_UNIT_A,
    })).toBe('same_county_unit_unknown');
    expect(describeAssignmentRelation({
      itemCounty: NAIROBI,
      itemAdministrativeUnitId: '   ',
      agentCounty: NAIROBI,
      agentAdministrativeUnitId: NAIROBI_UNIT_A,
    })).toBe('same_county_unit_unknown');
  });

  it('reports a real county disagreement as different_county', () => {
    expect(describeAssignmentRelation({
      itemCounty: NAIROBI,
      itemAdministrativeUnitId: NAIROBI_UNIT_A,
      agentCounty: MOMBASA,
      agentAdministrativeUnitId: MOMBASA_UNIT,
    })).toBe('different_county');
  });

  it('reports an unknown county as unknown instead of inventing a mismatch', () => {
    // A disagreement that cannot be shown to exist must not be asserted: the
    // console's warning (and the server's 409) both key off a KNOWN difference.
    expect(describeAssignmentRelation({
      itemCounty: null,
      itemAdministrativeUnitId: null,
      agentCounty: MOMBASA,
      agentAdministrativeUnitId: MOMBASA_UNIT,
    })).toBe('county_unknown');
    expect(describeAssignmentRelation({
      itemCounty: NAIROBI,
      itemAdministrativeUnitId: NAIROBI_UNIT_A,
      agentCounty: '',
      agentAdministrativeUnitId: NAIROBI_UNIT_A,
    })).toBe('county_unknown');
    expect(describeAssignmentRelation({})).toBe('county_unknown');
    expect(describeAssignmentRelation(null as any)).toBe('county_unknown');
  });

  it('treats an unrecognised county as DIFFERENT, not as a match', () => {
    // The shared resolver (compareCounties) keeps a misspelling as its own key
    // rather than collapsing it onto a real county. The conservative reading is
    // the intended one: an unrecognised value warns and asks for confirmation
    // instead of being silently treated as the same place.
    expect(describeAssignmentRelation({
      itemCounty: NAIROBI,
      itemAdministrativeUnitId: NAIROBI_UNIT_A,
      agentCounty: 'Atlantis',
      agentAdministrativeUnitId: NAIROBI_UNIT_A,
    })).toBe('different_county');
  });
});

describe('candidateDistanceKm — a distance only when one honestly exists', () => {
  it('returns the same Haversine distance the matcher computes', () => {
    const hub = agent({ longitude: NAIROBI_CENTRE.longitude + 0.1 });
    expect(candidateDistanceKm(NAIROBI_CENTRE, hub)).toBe(
      calculateHaversineDistance(
        NAIROBI_CENTRE.latitude,
        NAIROBI_CENTRE.longitude,
        hub.latitude,
        hub.longitude,
      ),
    );
  });

  it('produces the expected magnitude for a known offset (~11 km for 0.1 degrees)', () => {
    const distance = candidateDistanceKm(NAIROBI_CENTRE, agent({ longitude: NAIROBI_CENTRE.longitude + 0.1 }));
    expect(distance).toBeGreaterThan(11);
    expect(distance).toBeLessThan(11.25);
  });

  it('keeps a genuine zero a zero (two valid but identical positions)', () => {
    expect(candidateDistanceKm(NAIROBI_CENTRE, agent())).toBe(0);
    expect(formatCandidateDistance(0)).toBe('0.0 km');
  });

  it('returns null rather than a substitute when either side has no usable pair', () => {
    const hub = agent({ longitude: NAIROBI_CENTRE.longitude + 0.1 });
    // No item position at all.
    expect(candidateDistanceKm({ ...item(), latitude: null, longitude: null }, hub)).toBeNull();
    expect(candidateDistanceKm(null, hub)).toBeNull();
    expect(candidateDistanceKm(undefined, hub)).toBeNull();
    // Half a coordinate is not a location.
    expect(candidateDistanceKm({ ...item(), longitude: undefined }, hub)).toBeNull();
    // Stored text is not a number, and numeric strings are not accepted here.
    expect(candidateDistanceKm({ ...item(), latitude: '-1.2921' as any }, hub)).toBeNull();
    expect(candidateDistanceKm({ ...item(), latitude: 'junk' as any }, hub)).toBeNull();
    // Out of range / non-finite values are unusable, never "corrected".
    expect(candidateDistanceKm({ ...item(), latitude: 999 }, hub)).toBeNull();
    expect(candidateDistanceKm({ ...item(), latitude: Number.NaN }, hub)).toBeNull();
    // The hub side is validated just as strictly.
    expect(candidateDistanceKm(NAIROBI_CENTRE, agent({ latitude: null }))).toBeNull();
    expect(candidateDistanceKm(NAIROBI_CENTRE, agent({ longitude: undefined }))).toBeNull();
    expect(candidateDistanceKm(NAIROBI_CENTRE, agent({ latitude: 190 }))).toBeNull();
    expect(candidateDistanceKm(NAIROBI_CENTRE, null as any)).toBeNull();
  });

  it('accepts a legitimate coordinate of exactly zero', () => {
    expect(candidateDistanceKm(
      { latitude: 0, longitude: 0 },
      agent({ latitude: 0, longitude: 0.1 }),
    )).toBeGreaterThan(11);
  });
});

describe('formatCandidateDistance — the not-available wording is explicit', () => {
  it('formats a real distance to one decimal place', () => {
    expect(formatCandidateDistance(3.44)).toBe('3.4 km');
    expect(formatCandidateDistance(0.06)).toBe('0.1 km');
    expect(formatCandidateDistance(126)).toBe('126.0 km');
  });

  it('never renders a missing distance as a number', () => {
    expect(formatCandidateDistance(null)).toBe(DISTANCE_UNAVAILABLE_LABEL);
    expect(formatCandidateDistance(undefined as any)).toBe(DISTANCE_UNAVAILABLE_LABEL);
    expect(formatCandidateDistance(Number.NaN)).toBe(DISTANCE_UNAVAILABLE_LABEL);
    expect(formatCandidateDistance(Number.POSITIVE_INFINITY)).toBe(DISTANCE_UNAVAILABLE_LABEL);
    expect(DISTANCE_UNAVAILABLE_LABEL).toBe('Distance not available');
  });
});


describe('buildAssignmentCandidates — the hub, described honestly', () => {
  it('copies the hub details the console renders', () => {
    const [candidate] = buildAssignmentCandidates({ item: item(), agents: [agent()] });
    expect(candidate.id).toBe('hub-a');
    expect(candidate.businessName).toBe('Hub A');
    expect(candidate.locationAddress).toBe('Kimathi Street');
    expect(candidate.status).toBe('active');
    expect(candidate.county).toBe(NAIROBI);
    expect(candidate.administrativeUnitId).toBe(NAIROBI_UNIT_A);
    expect(candidate.administrativeUnitName).toBe(NAIROBI_UNIT_A_NAME);
    expect(candidate.geographyLabel).toBe(`${NAIROBI} — ${NAIROBI_UNIT_A_NAME}`);
    expect(candidate.relation).toBe('same_county_same_unit');
    expect(candidate.relationShortLabel).toBe('same sub-county');
    expect(candidate.distanceKm).toBe(0);
    expect(candidate.distanceLabel).toBe('0.0 km');
  });

  it('falls back to the id for a blank business name and keeps a missing address null', () => {
    const [candidate] = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ business_name: '   ', location_address: null })],
    });
    expect(candidate.businessName).toBe('hub-a');
    expect(candidate.locationAddress).toBeNull();
  });

  it('takes eligibility from the server verdict ONLY — status is not the rule', () => {
    // The dropdown this replaced filtered on `status === 'active'`. A hub can
    // hold that status and still be unable to receive work (unverified email,
    // suspended), so `status` must never make a hub selectable on its own.
    const [activeButIneligible] = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ status: 'active', actionable: false })],
    });
    expect(activeButIneligible.status).toBe('active');
    expect(activeButIneligible.actionable).toBe(false);
    expect(activeButIneligible.selectable).toBe(false);

    const [unverified] = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ status: 'active', actionable: null })],
    });
    expect(unverified.actionable).toBeNull();
    expect(unverified.selectable).toBe(false);

    // 'not stated' is neither true nor false, and is never guessed into a yes.
    const [missing] = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ actionable: undefined })],
    });
    expect(missing.actionable).toBeNull();
    expect(missing.selectable).toBe(false);

    // A truthy non-boolean is not a verdict either.
    const [stringy] = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ actionable: 'true' })],
    });
    expect(stringy.actionable).toBeNull();
    expect(stringy.selectable).toBe(false);

    const [eligible] = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ status: 'suspended', actionable: true })],
    });
    expect(eligible.selectable).toBe(true);
  });

  it('survives a dashboard that has not loaded, and skips unusable entries', () => {
    expect(buildAssignmentCandidates({})).toEqual([]);
    expect(buildAssignmentCandidates({ item: null, agents: null })).toEqual([]);
    expect(buildAssignmentCandidates({ item: item(), agents: undefined })).toEqual([]);
    expect(buildAssignmentCandidates({
      item: item(),
      agents: [null, undefined, 'hub', 42, { id: 7 }, { id: '' }, { business_name: 'no id' }],
    })).toEqual([]);
  });

  it('reports an unrecorded county as unknown instead of borrowing one', () => {
    const [blank] = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ county: '   ', administrative_unit_id: null })],
    });
    expect(blank.county).toBeNull();
    expect(blank.geographyLabel).toBeNull();
    expect(blank.relation).toBe('county_unknown');
    expect(blank.relationLabel).toMatch(/County cannot be compared/);
  });

  it('names the cross-county override in words, without refusing it', () => {
    const [otherCounty] = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ county: MOMBASA, administrative_unit_id: MOMBASA_UNIT, latitude: -4.0435, longitude: 39.6682 })],
    });
    expect(otherCounty.relation).toBe('different_county');
    expect(otherCounty.relationShortLabel).toBe('different county');
    expect(otherCounty.relationLabel).toContain('cross-county override');
    // It is described, not hidden: the console offers it and warns.
    expect(otherCounty.selectable).toBe(true);
    expect(otherCounty.distanceKm).toBeGreaterThan(400);
  });
});


describe('ordering — proximity first, then a deterministic tie-break', () => {
  // One of each relation, in a deliberately shuffled input order.
  const mixed = () => [
    agent({ id: 'h5', business_name: 'Other county', county: MOMBASA, administrative_unit_id: MOMBASA_UNIT, latitude: -4.0435, longitude: 39.6682 }),
    agent({ id: 'h3', business_name: 'Different sub-county', administrative_unit_id: NAIROBI_UNIT_B, longitude: NAIROBI_CENTRE.longitude + 0.1 }),
    agent({ id: 'h0', business_name: 'Ineligible neighbour', actionable: false }),
    agent({ id: 'h1', business_name: 'Same sub-county' }),
    agent({ id: 'h4', business_name: 'No county', county: '', administrative_unit_id: null, latitude: null, longitude: null }),
    agent({ id: 'h2', business_name: 'No sub-county', administrative_unit_id: null, longitude: NAIROBI_CENTRE.longitude + 0.02 }),
  ];

  it('orders same sub-county, then comparable-unknown, then different sub-county, then unknown and other counties', () => {
    const ids = buildAssignmentCandidates({ item: item(), agents: mixed() }).map(candidate => candidate.id);
    expect(ids).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h0']);
  });

  it('would have offered the ineligible hub under the old status filter — now it sorts last', () => {
    const candidates = buildAssignmentCandidates({ item: item(), agents: mixed() });
    const ineligible = candidates[candidates.length - 1];
    expect(ineligible.id).toBe('h0');
    expect(ineligible.status).toBe('active');
    expect(ineligible.selectable).toBe(false);
    // It is still LISTED so the console can explain why it cannot be chosen.
    expect(excludedAssignmentCandidates(candidates).map(candidate => candidate.id)).toEqual(['h0']);
  });

  it('orders by distance inside one relation, and puts an unknown distance last', () => {
    const candidates = buildAssignmentCandidates({
      item: item(),
      agents: [
        // Ids deliberately oppose the distance order, so only distance can
        // produce this sequence.
        agent({ id: 'z_near', longitude: NAIROBI_CENTRE.longitude + 0.02 }),
        agent({ id: 'm_unknown', latitude: null, longitude: null }),
        agent({ id: 'a_far', longitude: NAIROBI_CENTRE.longitude + 0.1 }),
      ],
    });
    expect(candidates.map(candidate => candidate.id)).toEqual(['z_near', 'a_far', 'm_unknown']);
    // "We do not know" is not "zero kilometres away".
    expect(candidates[2].distanceKm).toBeNull();
    expect(candidates[2].distanceLabel).toBe(DISTANCE_UNAVAILABLE_LABEL);
  });

  it('breaks an exact tie on ascending id, like selectNearestAgent() does', () => {
    const candidates = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ id: 'hub-b' }), agent({ id: 'hub-a' }), agent({ id: 'hub-c' })],
    });
    expect(candidates.map(candidate => candidate.id)).toEqual(['hub-a', 'hub-b', 'hub-c']);
  });

  it('produces the same order whatever order the payload arrives in', () => {
    const forward = buildAssignmentCandidates({ item: item(), agents: mixed() }).map(candidate => candidate.id);
    const reversed = buildAssignmentCandidates({ item: item(), agents: mixed().reverse() }).map(candidate => candidate.id);
    expect(reversed).toEqual(forward);
    // And the comparator itself is consistent in both directions.
    const [first, second] = buildAssignmentCandidates({ item: item(), agents: mixed() });
    expect(compareAssignmentCandidates(first, second)).toBeLessThan(0);
    expect(compareAssignmentCandidates(second, first)).toBeGreaterThan(0);
    expect(compareAssignmentCandidates(first, first)).toBe(0);
  });

  it('drops nothing for being far away — no maximum radius is invented here', () => {
    // MAX_AGENT_ASSIGNMENT_RADIUS_KM is disabled (config/geoMatching.ts) and
    // this projection must not quietly reintroduce it: a distant hub in the
    // item's own county stays listed and stays selectable, because there are
    // real cases (no hub nearby, the finder chose the wrong sub-county) where
    // it is the right choice.
    const candidates = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ id: 'far', longitude: NAIROBI_CENTRE.longitude + 4 })],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].distanceKm).toBeGreaterThan(400);
    expect(candidates[0].selectable).toBe(true);
    expect(candidates[0].relation).toBe('same_county_same_unit');
  });
});


describe('the helpers the panel calls', () => {
  const candidates = () => buildAssignmentCandidates({
    item: item(),
    agents: [
      agent({ id: 'hub-a', business_name: 'Hub A' }),
      agent({ id: 'hub-b', business_name: 'Hub B', actionable: false }),
    ],
  });

  it('selects only the hubs the server cleared', () => {
    expect(selectableAssignmentCandidates(candidates()).map(candidate => candidate.id)).toEqual(['hub-a']);
    expect(selectableAssignmentCandidates(null)).toEqual([]);
  });

  it('lists the hubs that cannot be chosen, so they never vanish silently', () => {
    expect(excludedAssignmentCandidates(candidates()).map(candidate => candidate.id)).toEqual(['hub-b']);
    expect(excludedAssignmentCandidates(undefined)).toEqual([]);
  });

  it('finds the current selection and tolerates a missing one', () => {
    expect(findAssignmentCandidate(candidates(), 'hub-b')?.businessName).toBe('Hub B');
    expect(findAssignmentCandidate(candidates(), 'hub-zzz')).toBeNull();
    expect(findAssignmentCandidate(candidates(), '')).toBeNull();
    expect(findAssignmentCandidate(candidates(), null)).toBeNull();
    expect(findAssignmentCandidate(null, 'hub-a')).toBeNull();
  });

  it('describes the option so the geography is visible before choosing', () => {
    const [sameUnit] = buildAssignmentCandidates({ item: item(), agents: [agent()] });
    const label = describeAssignmentCandidate(sameUnit);
    expect(label).toContain('Hub A (Kimathi Street)');
    expect(label).toContain(NAIROBI_UNIT_A_NAME);
    expect(label).toContain('same sub-county');
    expect(label).toContain('0.0 km');

    // No county recorded: the label says so instead of showing a blank.
    const [noCounty] = buildAssignmentCandidates({
      item: item(),
      agents: [agent({ county: null, administrative_unit_id: null, latitude: null, longitude: null })],
    });
    const noCountyLabel = describeAssignmentCandidate(noCounty);
    expect(noCountyLabel).toContain('service county not recorded');
    expect(noCountyLabel).toContain('county not comparable');
    expect(noCountyLabel).toContain(DISTANCE_UNAVAILABLE_LABEL);
  });
});

describe('this module stays a projection', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'adminAssignmentCandidates.ts'),
    'utf8',
  );

  it('imports no database, no auth and no server module', () => {
    // If this module could reach the database or the auth service it could
    // start deciding eligibility or assignment on its own — the exact second
    // opinion the whole stage exists to remove.
    expect(source).not.toMatch(/from\s+'\.\.\/db\//);
    expect(source).not.toMatch(/from\s+'\.\/auth'/);
    expect(source).not.toMatch(/from\s+'\.\.\/server'/);
    expect(source).not.toMatch(/from\s+'express'/);
  });

  it('derives nothing from randomness or the clock', () => {
    // The console list must be a pure function of the payload: a random or
    // time-dependent order would make the same data render differently.
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/new Date\(/);
  });

  it('reads the eligibility verdict instead of recomputing one', () => {
    // The one place a verdict enters this module is the copy below: `status`,
    // verification timestamps and suspension fields are never consulted.
    expect(source).toMatch(/agent\.actionable === true \? true/);
    expect(source).toMatch(/selectable: actionable === true/);
    expect(source).not.toMatch(/await /);
    expect(source).not.toMatch(/fetch\(/);
  });
});

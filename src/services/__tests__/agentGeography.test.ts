import { describe, expect, it } from 'vitest';
import { KENYA_COUNTIES } from '../../config/kenyaCounties';
import { administrativeUnitsForCounty } from '../../config/kenyaAdministrativeUnits';
import {
  AGENT_GEOGRAPHY_COUNTY_REQUIRED_MESSAGE,
  AGENT_GEOGRAPHY_UNIT_MISMATCH_MESSAGE,
  AGENT_GEOGRAPHY_UNIT_REQUIRED_MESSAGE,
  assessAssignmentGeography,
  canonicalCounty,
  compareCounties,
  countyComparisonKey,
  describeGeographyLabel,
  isSameAdministrativeUnit,
  isSameCounty,
  validateAgentGeographyCorrection,
} from '../agentGeography';

// =============================================================================
// STAGE 3B-6 — GEOGRAPHY COMPARISON AND CORRECTION VALIDATION (PURE).
//
// These tests run without a database, a geocoder or a network: the module is the
// decision core only. What they pin:
//
//   * a county comparison tolerates case, padding, whitespace runs and the
//     documented spelling aliases, and NEVER guesses (a misspelling is a
//     difference, an absent county is `unknown`);
//   * all 47 canonical counties compare equal to themselves and to their own
//     upper-cased form — the regression this stage exists to prevent;
//   * an administrator's correction is accepted only as a canonical county plus
//     a sub-county that actually belongs to that county, and every refusal
//     carries an operator-safe message and a field name;
//   * the assignment assessment asks for an acknowledgement ONLY for a known
//     county disagreement, and never claims a boundary was verified.
// =============================================================================

const nairobiUnits = administrativeUnitsForCounty('Nairobi City');
const mombasaUnits = administrativeUnitsForCounty('Mombasa');
const NAIROBI_UNIT = nairobiUnits[0].id;
const MOMBASA_UNIT = mombasaUnits[0].id;

describe('B6-C — county comparison tolerates spelling, padding and case', () => {
  it('canonicalises the documented aliases and rejects non-counties', () => {
    expect(canonicalCounty('nairobi')).toBe('Nairobi City');
    expect(canonicalCounty('  NAIROBI CITY  ')).toBe('Nairobi City');
    expect(canonicalCounty('muranga')).toBe("Murang'a");
    expect(canonicalCounty('Atlantis')).toBeNull();
    expect(canonicalCounty('')).toBeNull();
    expect(canonicalCounty(null)).toBeNull();
    expect(canonicalCounty(undefined)).toBeNull();
    expect(canonicalCounty(47)).toBeNull();
  });

  it('treats an alias, a differently-cased value and padded text as the same county', () => {
    expect(compareCounties('Nairobi City', 'nairobi')).toBe('same');
    expect(compareCounties('nairobi city', 'Nairobi City')).toBe('same');
    expect(compareCounties('  Nairobi   City ', 'Nairobi City')).toBe('same');
    expect(compareCounties('Muranga', "Murang'a")).toBe('same');
    expect(isSameCounty('Elgeyo Marakwet', 'Elgeyo-Marakwet')).toBe(true);
  });

  it('reports a genuine difference as `different`, never as `same`', () => {
    expect(compareCounties('Nairobi City', 'Mombasa')).toBe('different');
    expect(isSameCounty('Nairobi City', 'Mombasa')).toBe(false);
    // No fuzzy matching: one character apart is a DIFFERENT value.
    expect(compareCounties('Nairobii', 'Nairobi City')).toBe('different');
  });

  it('identical non-canonical values still compare equal to each other', () => {
    // Two rows that both hold the same un-canonical text are not a mismatch; the
    // fallback key exists for exactly this case and cannot create a false match
    // against a real county (asserted above).
    expect(compareCounties('Nairobii', '  nairobii ')).toBe('same');
  });

  it('answers `unknown` — not `different` — when either side has no county', () => {
    expect(compareCounties('Nairobi City', null)).toBe('unknown');
    expect(compareCounties(undefined, 'Nairobi City')).toBe('unknown');
    expect(compareCounties('', '   ')).toBe('unknown');
    expect(compareCounties(null, null)).toBe('unknown');
  });

  it('gives every one of the 47 canonical counties a stable key that matches itself', () => {
    for (const county of KENYA_COUNTIES) {
      expect(countyComparisonKey(county.name), county.name).toBe(county.name.toLowerCase());
      expect(compareCounties(county.name, county.name.toUpperCase()), county.name).toBe('same');
    }
  });

  it('compares sub-county ids exactly, ignoring only case and padding', () => {
    expect(isSameAdministrativeUnit(NAIROBI_UNIT, ` ${NAIROBI_UNIT.toLowerCase()} `)).toBe(true);
    expect(isSameAdministrativeUnit(NAIROBI_UNIT, MOMBASA_UNIT)).toBe(false);
    expect(isSameAdministrativeUnit(NAIROBI_UNIT, null)).toBe(false);
    expect(isSameAdministrativeUnit('', '')).toBe(false);
  });
});

describe('B6-A — an administrator geography correction is validated, not trusted', () => {
  it('accepts a canonical county with a sub-county that belongs to it', () => {
    const verdict = validateAgentGeographyCorrection({
      county: 'Nairobi City',
      administrativeUnitId: NAIROBI_UNIT,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.error).toBe('');
    expect(verdict.field).toBeNull();
    expect(verdict.correction).toEqual({
      county: 'Nairobi City',
      administrativeUnitId: NAIROBI_UNIT,
    });
  });

  it('canonicalises an alias instead of storing the operator’s spelling', () => {
    const verdict = validateAgentGeographyCorrection({
      county: 'nairobi',
      administrativeUnitId: NAIROBI_UNIT,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.correction.county).toBe('Nairobi City');
  });

  it('refuses a value that is not a Kenyan county and writes nothing', () => {
    const verdict = validateAgentGeographyCorrection({
      county: 'Nairobi District',
      administrativeUnitId: NAIROBI_UNIT,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.correction).toBeNull();
    expect(verdict.field).toBe('county');
    expect(verdict.error).toBe(AGENT_GEOGRAPHY_COUNTY_REQUIRED_MESSAGE);
  });

  it('refuses a missing county', () => {
    const verdict = validateAgentGeographyCorrection({ administrativeUnitId: NAIROBI_UNIT });
    expect(verdict.ok).toBe(false);
    expect(verdict.field).toBe('county');
  });

  it('refuses a missing or blank sub-county — a hub is never made LESS matchable', () => {
    for (const administrativeUnitId of [undefined, null, '', '   ']) {
      const verdict = validateAgentGeographyCorrection({
        county: 'Nairobi City',
        administrativeUnitId,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.field).toBe('administrativeUnitId');
      expect(verdict.error).toBe(AGENT_GEOGRAPHY_UNIT_REQUIRED_MESSAGE);
    }
  });

  it('refuses a sub-county that belongs to a different county', () => {
    const verdict = validateAgentGeographyCorrection({
      county: 'Nairobi City',
      administrativeUnitId: MOMBASA_UNIT,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.correction).toBeNull();
    expect(verdict.field).toBe('administrativeUnitId');
    expect(verdict.error).toBe(AGENT_GEOGRAPHY_UNIT_MISMATCH_MESSAGE);
  });
});


describe('B6-A — a stored geography renders as one label, never as a verified boundary', () => {
  it('joins the canonical county with its sub-county name', () => {
    expect(describeGeographyLabel('Nairobi City', NAIROBI_UNIT)).toBe(
      `Nairobi City — ${nairobiUnits[0].name}`,
    );
  });

  it('falls back to the county alone when no sub-county is recorded', () => {
    expect(describeGeographyLabel('nairobi', null)).toBe('Nairobi City');
  });

  it('returns null when there is no county at all', () => {
    expect(describeGeographyLabel(null, NAIROBI_UNIT)).toBeNull();
    expect(describeGeographyLabel('   ', NAIROBI_UNIT)).toBeNull();
  });
});

describe('B6-D — the assignment assessment asks for an acknowledgement only on a known disagreement', () => {
  it('flags a different county and requires an explicit acknowledgement', () => {
    const assessment = assessAssignmentGeography({
      itemCounty: 'Nairobi City',
      itemAdministrativeUnitId: NAIROBI_UNIT,
      agentCounty: 'Mombasa',
      agentAdministrativeUnitId: MOMBASA_UNIT,
    });
    expect(assessment.county_match).toBe('different');
    expect(assessment.requires_acknowledgement).toBe(true);
    expect(assessment.boundary_verified).toBe(false);
    expect(assessment.item_county).toBe('Nairobi City');
    expect(assessment.agent_county).toBe('Mombasa');
    expect(assessment.summary).toContain('Mombasa');
    expect(assessment.summary).toContain('Nairobi City');
  });

  it('does not ask for anything when the counties match, whatever the sub-county', () => {
    const sameSubCounty = assessAssignmentGeography({
      itemCounty: 'Nairobi City',
      itemAdministrativeUnitId: NAIROBI_UNIT,
      agentCounty: 'Nairobi City',
      agentAdministrativeUnitId: NAIROBI_UNIT,
    });
    expect(sameSubCounty.county_match).toBe('same');
    expect(sameSubCounty.sub_county_match).toBe(true);
    expect(sameSubCounty.requires_acknowledgement).toBe(false);

    const differentSubCounty = assessAssignmentGeography({
      itemCounty: 'Nairobi City',
      itemAdministrativeUnitId: NAIROBI_UNIT,
      agentCounty: 'Nairobi City',
      agentAdministrativeUnitId: nairobiUnits[nairobiUnits.length - 1].id,
    });
    expect(differentSubCounty.county_match).toBe('same');
    expect(differentSubCounty.requires_acknowledgement).toBe(false);
  });

  it('does not turn a missing county into a mismatch', () => {
    const noItemCounty = assessAssignmentGeography({
      itemCounty: null,
      agentCounty: 'Nairobi City',
      agentAdministrativeUnitId: NAIROBI_UNIT,
    });
    expect(noItemCounty.county_match).toBe('unknown');
    expect(noItemCounty.requires_acknowledgement).toBe(false);

    const noAgentCounty = assessAssignmentGeography({
      itemCounty: 'Nairobi City',
      agentCounty: null,
    });
    expect(noAgentCounty.county_match).toBe('unknown');
    expect(noAgentCounty.requires_acknowledgement).toBe(false);
  });

  it('tolerates an alias on either side (the Stage 3B-6C regression)', () => {
    const assessment = assessAssignmentGeography({
      itemCounty: 'Nairobi City',
      itemAdministrativeUnitId: NAIROBI_UNIT,
      agentCounty: ' nairobi ',
      agentAdministrativeUnitId: NAIROBI_UNIT,
    });
    expect(assessment.county_match).toBe('same');
    expect(assessment.requires_acknowledgement).toBe(false);
    expect(assessment.agent_county).toBe('Nairobi City');
  });

  it('reports the sub-county comparison only when both sides have one', () => {
    const assessment = assessAssignmentGeography({
      itemCounty: 'Nairobi City',
      agentCounty: 'Nairobi City',
    });
    expect(assessment.sub_county_match).toBeNull();
  });
});

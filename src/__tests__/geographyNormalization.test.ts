import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { KENYA_COUNTIES } from '../config/kenyaCounties';
import {
  CANONICAL_ENTITY_OVERRIDES,
  KENYA_ADMINISTRATIVE_UNITS,
  administrativeUnitById,
  administrativeUnitsForCounty,
  findAdministrativeUnitIdByName,
  resolveAdministrativeUnitAlias,
  resolveAdministrativeUnitId,
  type CanonicalEntityType,
} from '../config/kenyaAdministrativeUnits';

// GEO-A / GEO-B — normalisation foundation. Locks in the classification of the
// 312 immutable product units and the four county-aware alias spellings,
// WITHOUT touching ids, county associations, display names, GPS or matching.

const ALL_TYPES: CanonicalEntityType[] = [
  'electoral_constituency',
  'administrative_subcounty',
  'ward',
  'unknown',
];

// The four spelling variants (still electoral constituencies; corrected name).
const VARIANT_IDS = ['KE-20-SC-04', 'KE-21-SC-03', 'KE-35-SC-05', 'KE-44-SC-03'];

// Genuine KNBS administrative sub-counties.
const SUBCOUNTY_IDS = [
  'KE-11-SC-01', 'KE-11-SC-02', 'KE-11-SC-03',
  'KE-19-SC-02', 'KE-19-SC-03', 'KE-19-SC-04', 'KE-19-SC-05',
  'KE-20-SC-01', 'KE-20-SC-02', 'KE-42-SC-08', 'KE-43-SC-07', 'KE-43-SC-08',
];

// Ward / division rows.
const WARD_IDS = ['KE-10-SC-05', 'KE-12-SC-10', 'KE-13-SC-04', 'KE-16-SC-09', 'KE-30-SC-09'];

// Audit-UNCERTAIN rows + the misplaced Kwale "Samburu East" row.
const UNKNOWN_IDS = [
  'KE-03-SC-08', 'KE-03-SC-09', 'KE-07-SC-07', 'KE-18-SC-04',
  'KE-18-SC-06', 'KE-20-SC-06', 'KE-21-SC-08', 'KE-30-SC-07', 'KE-30-SC-08', 'KE-41-SC-07',
  'KE-02-SC-05',
];

describe('GEO-A — normalised unit metadata', () => {
  it('gives every one of the 312 units a complete normalisation record', () => {
    expect(KENYA_ADMINISTRATIVE_UNITS).toHaveLength(312);
    for (const unit of KENYA_ADMINISTRATIVE_UNITS) {
      expect(unit.id, unit.name).toMatch(/^KE-\d{2}-SC-\d{2}$/);
      expect(unit.countyCode, unit.id).toMatch(/^KE-\d{2}$/);
      expect(unit.id.startsWith(`${unit.countyCode}-SC-`), unit.id).toBe(true);
      expect(ALL_TYPES).toContain(unit.canonicalEntityType);
      expect(typeof unit.canonicalEntityName).toBe('string');
      expect(unit.canonicalEntityName.length, unit.id).toBeGreaterThan(0);
    }
  });

  it('keeps exactly 312 unique product units and 47 county groups', () => {
    expect(KENYA_ADMINISTRATIVE_UNITS).toHaveLength(312);
    expect(new Set(KENYA_ADMINISTRATIVE_UNITS.map(unit => unit.id)).size).toBe(312);
    expect(new Set(KENYA_ADMINISTRATIVE_UNITS.map(unit => unit.countyCode)).size).toBe(47);
    for (const county of KENYA_COUNTIES) {
      expect(administrativeUnitsForCounty(county.name).length, county.name).toBeGreaterThan(0);
    }
  });

  it('preserves every product id, county association and display name (golden fingerprint)', () => {
    const fingerprint = KENYA_ADMINISTRATIVE_UNITS
      .map(unit => `${unit.id}=${unit.countyCode}:${unit.name}`)
      .join('|');
    expect(fingerprint).toHaveLength(8788);
    expect(createHash('sha256').update(fingerprint).digest('hex'))
      .toBe('a68eed79dba4eccb1731c02722d08049576ab51db7bf0de30df5cf651dfecb9d');
  });

  it('never renumbers ids and keeps the county association explicit', () => {
    const anchors: Array<[string, string, string]> = [
      ['KE-01-SC-01', 'KE-01', 'Changamwe'],
      ['KE-02-SC-05', 'KE-02', 'Samburu East'],
      ['KE-25-SC-03', 'KE-25', 'Samburu East'],
      ['KE-18-SC-04', 'KE-18', 'Ol Jorok'],
      ['KE-47-SC-17', 'KE-47', 'Mathare'],
    ];
    for (const [id, countyCode, name] of anchors) {
      expect(administrativeUnitById(id)).toMatchObject({ id, countyCode, name });
    }
  });

  it('classifies known constituency rows as electoral_constituency', () => {
    for (const id of ['KE-01-SC-01', 'KE-25-SC-01', 'KE-32-SC-01', 'KE-47-SC-17']) {
      expect(administrativeUnitById(id)?.canonicalEntityType, id).toBe('electoral_constituency');
    }
  });

  it.each(SUBCOUNTY_IDS)('classifies %s as administrative_subcounty', id => {
    expect(administrativeUnitById(id)?.canonicalEntityType).toBe('administrative_subcounty');
  });

  it.each(WARD_IDS)('classifies %s as ward', id => {
    expect(administrativeUnitById(id)?.canonicalEntityType).toBe('ward');
  });

  it('uses the corrected canonical name for the four spelling variants', () => {
    expect(administrativeUnitById('KE-20-SC-04')).toMatchObject({ name: 'Ndidia', canonicalEntityName: 'Ndia', canonicalEntityType: 'electoral_constituency' });
    expect(administrativeUnitById('KE-21-SC-03')).toMatchObject({ name: 'Kahuro', canonicalEntityName: 'Kiharu', canonicalEntityType: 'electoral_constituency' });
    expect(administrativeUnitById('KE-35-SC-05')).toMatchObject({ name: 'Soin Sigowet', canonicalEntityName: 'Sigowet/Soin', canonicalEntityType: 'electoral_constituency' });
    expect(administrativeUnitById('KE-44-SC-03')).toMatchObject({ name: 'Suna South', canonicalEntityName: 'Suna East', canonicalEntityType: 'electoral_constituency' });
  });

  it('does not present any UNCERTAIN row as a constituency', () => {
    for (const id of UNKNOWN_IDS) {
      expect(administrativeUnitById(id)?.canonicalEntityType, id).toBe('unknown');
    }
  });

  it('does not present the misplaced Kwale "Samburu East" row as a valid Kwale constituency', () => {
    const misplaced = administrativeUnitById('KE-02-SC-05');
    expect(misplaced).toMatchObject({ countyCode: 'KE-02', name: 'Samburu East' });
    expect(misplaced?.canonicalEntityType).not.toBe('electoral_constituency');
    expect(misplaced?.canonicalEntityType).toBe('unknown');
    expect(administrativeUnitById('KE-25-SC-03')).toMatchObject({
      countyCode: 'KE-25',
      canonicalEntityType: 'electoral_constituency',
      canonicalEntityName: 'Samburu East',
    });
  });

  it('annotates exactly the flagged rows and defaults the rest to clean constituencies', () => {
    const overrideIds = Object.keys(CANONICAL_ENTITY_OVERRIDES);
    expect(overrideIds).toHaveLength(32);
    for (const id of overrideIds) expect(administrativeUnitById(id), id).not.toBeNull();
    for (const unit of KENYA_ADMINISTRATIVE_UNITS) {
      if (CANONICAL_ENTITY_OVERRIDES[unit.id]) continue;
      expect(unit.canonicalEntityType, unit.id).toBe('electoral_constituency');
      expect(unit.canonicalEntityName, unit.id).toBe(unit.name);
    }
  });

  it('produces the expected totals per canonical entity type', () => {
    const tally = (type: CanonicalEntityType) => KENYA_ADMINISTRATIVE_UNITS.filter(unit => unit.canonicalEntityType === type).length;
    expect(tally('electoral_constituency')).toBe(284);
    expect(tally('administrative_subcounty')).toBe(12);
    expect(tally('ward')).toBe(5);
    expect(tally('unknown')).toBe(11);
    expect(
      tally('electoral_constituency') + tally('administrative_subcounty') + tally('ward') + tally('unknown'),
    ).toBe(312);
    expect(VARIANT_IDS.every(id => administrativeUnitById(id)?.canonicalEntityType === 'electoral_constituency')).toBe(true);
  });
});

describe('GEO-B — county-aware alias resolution', () => {
  it('resolves the four known variant spellings to their existing product rows', () => {
    expect(resolveAdministrativeUnitAlias('Kirinyaga', 'Ndidia')).toMatchObject({ id: 'KE-20-SC-04', canonicalEntityName: 'Ndia' });
    expect(resolveAdministrativeUnitAlias("Murang'a", 'Kahuro')).toMatchObject({ id: 'KE-21-SC-03', canonicalEntityName: 'Kiharu' });
    expect(resolveAdministrativeUnitAlias('Kericho', 'Soin Sigowet')).toMatchObject({ id: 'KE-35-SC-05', canonicalEntityName: 'Sigowet/Soin' });
    expect(resolveAdministrativeUnitAlias('Migori', 'Suna South')).toMatchObject({ id: 'KE-44-SC-03', canonicalEntityName: 'Suna East' });
  });

  it('is county-aware and never resolves outside its own county', () => {
    expect(resolveAdministrativeUnitAlias('Migori', 'Suna South')?.id).toBe('KE-44-SC-03');
    expect(resolveAdministrativeUnitAlias('Kericho', 'Suna South')).toBeNull();
    expect(resolveAdministrativeUnitAlias('Kiambu', 'Kahuro')).toBeNull();
    expect(resolveAdministrativeUnitAlias('Kwale', 'Ndidia')).toBeNull();
    expect(resolveAdministrativeUnitAlias('Atlantis', 'Kahuro')).toBeNull();
    expect(resolveAdministrativeUnitAlias('Migori', 'Nonexistent')).toBeNull();
  });

  it('accepts a county code and is case/whitespace tolerant', () => {
    expect(resolveAdministrativeUnitAlias('KE-21', '  kahuro ')?.id).toBe('KE-21-SC-03');
    expect(resolveAdministrativeUnitAlias('ke-20', 'ndidia')?.id).toBe('KE-20-SC-04');
  });

  it('is an alias mechanism only — it is not a global name resolver', () => {
    expect(resolveAdministrativeUnitAlias('Kwale', 'Samburu East')).toBeNull();
    expect(resolveAdministrativeUnitAlias('Samburu', 'Samburu East')).toBeNull();
  });

  it('leaves existing id-based resolution behaviour unchanged', () => {
    expect(resolveAdministrativeUnitId('Nairobi City', 'KE-47-SC-01')).toBe('KE-47-SC-01');
    expect(resolveAdministrativeUnitId('Kwale', 'KE-47-SC-01')).toBeNull();
    expect(resolveAdministrativeUnitId('Nairobi City', 12345)).toBeNull();
    expect(findAdministrativeUnitIdByName('Kirinyaga', 'Ndidia')).toBe('KE-20-SC-04');
    expect(findAdministrativeUnitIdByName('Kirinyaga', 'Ndia')).toBeNull();
  });
});



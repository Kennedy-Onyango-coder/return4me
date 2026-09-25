import { describe, expect, it } from 'vitest';
import { KENYA_COUNTIES, KENYA_COUNTY_NAMES } from '../config/kenyaCounties';
import {
  KENYA_ADMINISTRATIVE_UNITS,
  administrativeUnitById,
  administrativeUnitsForCounty,
  findAdministrativeUnitIdByName,
  resolveAdministrativeUnitId,
} from '../config/kenyaAdministrativeUnits';
import { validateLostReportPayload } from '../routes/lostReports';

describe('Kenya county → sub-county → exact place hierarchy', () => {
  it('keeps exactly 47 canonical counties with unique KE-01 through KE-47 codes', () => {
    expect(KENYA_COUNTIES).toHaveLength(47);
    expect(new Set(KENYA_COUNTY_NAMES)).toHaveLength(47);
    expect(KENYA_COUNTIES.map(county => county.code)).toEqual(
      Array.from({ length: 47 }, (_, index) => `KE-${String(index + 1).padStart(2, '0')}`),
    );
  });

  it('covers every canonical county and has stable, globally unique identities', () => {
    expect(new Set(KENYA_ADMINISTRATIVE_UNITS.map(unit => unit.countyCode))).toHaveLength(47);
    expect(new Set(KENYA_ADMINISTRATIVE_UNITS.map(unit => unit.id))).toHaveLength(KENYA_ADMINISTRATIVE_UNITS.length);
    for (const county of KENYA_COUNTIES) {
      expect(administrativeUnitsForCounty(county.name).length, county.name).toBeGreaterThan(0);
    }
  });

  it.each([
    ['Nairobi City', 'Westlands'],
    ['Mombasa', 'Changamwe'],
    ['Kiambu', 'Gatundu North'],
    ['Kisumu', 'Kisumu East'],
  ])('binds %s → %s to one county', (county, name) => {
    const id = findAdministrativeUnitIdByName(county, name);
    expect(id).not.toBeNull();
    expect(resolveAdministrativeUnitId(county, id)).toBe(id);
    expect(administrativeUnitById(id)).toMatchObject({ countyCode: KENYA_COUNTIES.find(c => c.name === county)?.code, name });
  });

  it('rejects a unit from another county', () => {
    const westlands = findAdministrativeUnitIdByName('Nairobi City', 'Westlands');
    expect(resolveAdministrativeUnitId('Mombasa', westlands)).toBeNull();
  });

  it('retains duplicate display names safely by explicit county relationship', () => {
    const samburuEast = findAdministrativeUnitIdByName('Kwale', 'Samburu East');
    const unit = findAdministrativeUnitIdByName('Samburu', 'Samburu East');
    expect(samburuEast).not.toBeNull();
    expect(unit).not.toBeNull();
    expect(samburuEast).not.toBe(unit);
    expect(resolveAdministrativeUnitId('Kwale', unit)).toBeNull();
  });

  it('requires and validates the sub-county on new lost reports while exact place stays separate', () => {
    const categories = [{ id: 'phone' }];
    const base = {
      categoryId: 'phone', county: 'Nairobi City', administrativeUnitId: 'KE-47-SC-01',
      locationArea: 'Near Sarit Centre', lostAtFrom: new Date(Date.now() - 3_600_000).toISOString(),
    };
    expect(validateLostReportPayload(base, categories).ok).toBe(true);
    expect(validateLostReportPayload({ ...base, administrativeUnitId: undefined }, categories).ok).toBe(false);
    expect(validateLostReportPayload({ ...base, administrativeUnitId: 'KE-01-SC-01' }, categories).ok).toBe(false);
    const valid = validateLostReportPayload(base, categories);
    expect(valid.draft).toMatchObject({ administrative_unit_id: 'KE-47-SC-01', location_area: 'Near Sarit Centre' });
  });
});

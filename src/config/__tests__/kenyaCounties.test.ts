import { describe, it, expect } from 'vitest';
import {
  KENYA_COUNTIES,
  KENYA_COUNTY_NAMES,
  UX_GROUP_ORDER,
  countiesByUxGroup,
  resolveCountyName,
} from '../kenyaCounties';

// Phase 9 — canonical Kenyan location data tripwires.
//
// The brief's requirement was "all 47 counties, no duplicates, no accidental
// omission, canonical source". These assertions are written against the
// OFFICIAL list (Article 6(1) + First Schedule of the Constitution of Kenya
// 2010 / ISO 3166-2:KE) so a future edit that drops, duplicates or misspells a
// county fails here rather than silently shipping a wrong location list.

const OFFICIAL_COUNTIES = [
  'Mombasa', 'Kwale', 'Kilifi', 'Tana River', 'Lamu', 'Taita-Taveta',
  'Garissa', 'Wajir', 'Mandera', 'Marsabit', 'Isiolo', 'Meru',
  'Tharaka-Nithi', 'Embu', 'Kitui', 'Machakos', 'Makueni', 'Nyandarua',
  'Nyeri', 'Kirinyaga', "Murang'a", 'Kiambu', 'Turkana', 'West Pokot',
  'Samburu', 'Trans Nzoia', 'Uasin Gishu', 'Elgeyo-Marakwet', 'Nandi',
  'Baringo', 'Laikipia', 'Nakuru', 'Narok', 'Kajiado', 'Kericho', 'Bomet',
  'Kakamega', 'Vihiga', 'Bungoma', 'Busia', 'Siaya', 'Kisumu', 'Homa Bay',
  'Migori', 'Kisii', 'Nyamira', 'Nairobi City',
] as const;

describe('Kenya county data is the complete official set', () => {
  it('carries exactly 47 counties', () => {
    expect(KENYA_COUNTIES).toHaveLength(47);
    expect(KENYA_COUNTY_NAMES).toHaveLength(47);
  });

  it('matches the official list exactly, in official order', () => {
    expect([...KENYA_COUNTY_NAMES]).toEqual([...OFFICIAL_COUNTIES]);
  });

  it('contains no duplicates (name or ISO code)', () => {
    const names = KENYA_COUNTIES.map((c) => c.name);
    const codes = KENYA_COUNTIES.map((c) => c.code);
    expect(new Set(names).size).toBe(47);
    expect(new Set(codes).size).toBe(47);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(47);
  });

  it('assigns every county to exactly one UX-only group, and every group is declared', () => {
    const seen = new Set<string>();
    for (const county of KENYA_COUNTIES) {
      expect(UX_GROUP_ORDER, `${county.name} has an undeclared UX group`).toContain(county.uxGroup);
      seen.add(county.uxGroup);
    }
    expect(seen.size).toBe(UX_GROUP_ORDER.length);
    const grouped = countiesByUxGroup();
    expect(grouped.reduce((total, g) => total + g.counties.length, 0)).toBe(47);
  });

  it('records the Constitution spelling only where it actually differs', () => {
    const differing = KENYA_COUNTIES.filter((c) => c.constitutionName);
    // ISO 3166-2:KE hyphenates these three; the Constitution's First Schedule
    // writes them with a space or a slash. Every other county — Nairobi City
    // included — is identical in both, so `constitutionName` stays undefined.
    expect(differing.map((c) => c.name).sort()).toEqual([
      'Elgeyo-Marakwet',
      'Taita-Taveta',
      'Tharaka-Nithi',
    ]);
    for (const county of differing) {
      expect(county.constitutionName!.toLowerCase().replace(/[/ ]/g, '-'))
        .toBe(county.name.toLowerCase());
    }
  });

  it('invents no sub-county / ward data (there is none in the data source)', () => {
    for (const county of KENYA_COUNTIES) {
      expect(Object.keys(county).sort()).toEqual(
        county.constitutionName ? ['code', 'constitutionName', 'name', 'uxGroup'] : ['code', 'name', 'uxGroup']
      );
    }
  });
});

describe('resolveCountyName never guesses', () => {
  it('resolves canonical names and known typed variants', () => {
    expect(resolveCountyName('Nairobi City')).toBe('Nairobi City');
    expect(resolveCountyName('  nairobi ')).toBe('Nairobi City');
    expect(resolveCountyName('muranga')).toBe("Murang'a");
    expect(resolveCountyName('TAITA TAVETA')).toBe('Taita-Taveta');
  });

  it('returns null for anything that is not a Kenyan county', () => {
    expect(resolveCountyName('Westlands')).toBeNull();
    expect(resolveCountyName('Kampala')).toBeNull();
    expect(resolveCountyName('')).toBeNull();
    expect(resolveCountyName(null)).toBeNull();
    expect(resolveCountyName(undefined)).toBeNull();
  });
});

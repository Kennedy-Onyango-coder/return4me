import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  KENYA_COUNTIES,
  KENYA_COUNTY_ALIASES,
  KENYA_COUNTY_NAMES,
  resolveCountyName,
} from '../kenyaCounties';
import {
  administrativeUnitsForCounty,
  administrativeUnitNameForCounty,
  resolveAdministrativeUnitId,
} from '../kenyaAdministrativeUnits';
import {
  AGENT_GEOGRAPHY_COUNTY_REQUIRED_MESSAGE,
  AGENT_GEOGRAPHY_UNIT_MISMATCH_MESSAGE,
  validateAgentGeographyCorrection,
} from '../../services/agentGeography';
import { resolveFoundCountyInput } from '../../services/foundItemCounty';

// =============================================================================
// STAGE 3B-6C — COUNTY FORMATTING NORMALISATION.
//
// WHAT IS PINNED, AND WHY IT IS PINNED THIS WAY
// ---------------------------------------------
// A county value reaches the platform from three human surfaces (Agent
// registration, the Finder's report, the lost-report wizard) and from an
// administrator's correction. Formatting differences that carry no meaning —
// case, padding, repeated spaces, the slash the Constitution writes in
// "Taita/Taveta" and "Elgeyo/Marakwet", a typographic apostrophe in "Murang’a",
// an optional trailing "County" — must not turn a correct answer into a
// validation failure.
//
// What must NOT change is the other half of the contract: an unknown value, a
// misspelling or a PARTIAL name is still refused, and no input may unlock
// another county's sub-counties. Those are asserted here too, because a
// normaliser that widened those would be a regression dressed up as tolerance.
//
// Every assertion goes through `resolveCountyName()` (via the flows that call
// it) — there is exactly one county resolver, and this file is written against
// it rather than against a second copy of the rules.
// =============================================================================

const SERVER_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');
const FINDER_REPORT_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../routes/finderReport.ts'),
  'utf8',
);

/** A formatting variation that must NOT change which county is meant. */
const FORMATTING_VARIANTS: Array<[string, (name: string) => string]> = [
  ['exact', (name) => name],
  ['upper case', (name) => name.toUpperCase()],
  ['lower case', (name) => name.toLowerCase()],
  ['padded', (name) => `  \t ${name}  `],
  ['repeated internal whitespace', (name) => name.replace(/ /g, '   ')],
  ['"County" suffix', (name) => `${name} County`],
  ['padded, upper-case "COUNTY" suffix', (name) => `  ${name.toUpperCase()}  COUNTY `],
  ['slash / dash / space separators', (name) => name.replace(/[-\s]/g, ' / ')],
];

describe('3B-6C — all 47 canonical counties survive every formatting variation', () => {
  for (const [label, toVariant] of FORMATTING_VARIANTS) {
    it(`resolves each canonical county from its ${label} form, unchanged and canonical`, () => {
      expect(KENYA_COUNTIES).toHaveLength(47);
      for (const county of KENYA_COUNTIES) {
        const submitted = toVariant(county.name);
        expect(resolveCountyName(submitted), submitted).toBe(county.name);
        // The canonical name is returned, never the submitted spelling.
        expect(KENYA_COUNTY_NAMES).toContain(resolveCountyName(submitted) as string);
      }
    });
  }

  it('is idempotent: canonicalising a resolved county changes nothing', () => {
    for (const county of KENYA_COUNTIES) {
      const once = resolveCountyName(county.name.toLowerCase());
      expect(once).toBe(county.name);
      expect(resolveCountyName(once as string)).toBe(county.name);
    }
  });
});

describe('3B-6C — the required formatting variants, spelled out', () => {
  it('accepts Taita/Taveta with any spacing around the slash', () => {
    // The Constitution writes this county with a slash; ISO and common usage
    // write "Taita-Taveta". Both name the same county.
    for (const submitted of [
      'Taita/Taveta',
      'Taita / Taveta',
      'Taita/ Taveta',
      'Taita /Taveta',
      'TAITA/TAVETA',
      'taita  /  taveta',
      'Taita/Taveta County',
      'Taita – Taveta',
    ]) {
      expect(resolveCountyName(submitted), submitted).toBe('Taita-Taveta');
    }
  });

  it('accepts Elgeyo/Marakwet with any spacing around the slash', () => {
    for (const submitted of [
      'Elgeyo/Marakwet',
      'Elgeyo / Marakwet',
      'Elgeyo/Marakwet County',
      'ELGEYO  /  MARAKWET',
      'elgeyo-marakwet',
    ]) {
      expect(resolveCountyName(submitted), submitted).toBe('Elgeyo-Marakwet');
    }
  });

  it('accepts straight, typographic and missing apostrophes in Murang’a', () => {
    for (const submitted of [
      "Murang'a",
      'Murang’a',
      'Murang‘a',
      'Murang´a',
      'Murang`a',
      'MURANG’A',
      '  murang’a  ',
      "Murang'a County",
      "MURANG’A   COUNTY",
      'muranga',
    ]) {
      expect(resolveCountyName(submitted), submitted).toBe("Murang'a");
    }
  });

  it('accepts leading, trailing and repeated internal whitespace', () => {
    expect(resolveCountyName('   Mombasa   ')).toBe('Mombasa');
    expect(resolveCountyName('\tTana   River\n')).toBe('Tana River');
    expect(resolveCountyName('  West    Pokot  ')).toBe('West Pokot');
    expect(resolveCountyName('Trans \t\n Nzoia')).toBe('Trans Nzoia');
    expect(resolveCountyName('Homa      Bay')).toBe('Homa Bay');
  });

  it('accepts case differences', () => {
    expect(resolveCountyName('nairobi city')).toBe('Nairobi City');
    expect(resolveCountyName('nAiRoBi CiTy')).toBe('Nairobi City');
    expect(resolveCountyName('KISUMU')).toBe('Kisumu');
    expect(resolveCountyName('tharaka-nithi')).toBe('Tharaka-Nithi');
  });

  it('accepts an optional "County" suffix, including the "City County" form', () => {
    expect(resolveCountyName('Nairobi County')).toBe('Nairobi City');
    expect(resolveCountyName('Nairobi City County')).toBe('Nairobi City');
    expect(resolveCountyName('  nairobi   county  ')).toBe('Nairobi City');
    expect(resolveCountyName('Kiambu County')).toBe('Kiambu');
    expect(resolveCountyName('Taita/Taveta County')).toBe('Taita-Taveta');
    expect(resolveCountyName('Elgeyo / Marakwet County')).toBe('Elgeyo-Marakwet');
    expect(resolveCountyName('Tharaka-Nithi County')).toBe('Tharaka-Nithi');
  });
});

describe('3B-6C — existing aliases keep working, and only point at real counties', () => {
  it('resolves every documented alias to its canonical county', () => {
    const aliases = Object.entries(KENYA_COUNTY_ALIASES);
    expect(aliases.length).toBeGreaterThan(0);
    for (const [alias, canonical] of aliases) {
      expect(KENYA_COUNTY_NAMES, alias).toContain(canonical);
      expect(resolveCountyName(alias), alias).toBe(canonical);
      expect(resolveCountyName(alias.toUpperCase()), alias).toBe(canonical);
      expect(resolveCountyName(`  ${alias}  `), alias).toBe(canonical);
    }
  });

  it('still answers "nairobi" with the canonical Nairobi City', () => {
    expect(resolveCountyName('nairobi')).toBe('Nairobi City');
    expect(resolveCountyName('NAIROBI')).toBe('Nairobi City');
  });
});

describe('3B-6C — unknown, partial and misspelled values are still REFUSED', () => {
  it('refuses values that name no Kenyan county', () => {
    for (const submitted of [
      'Atlantis',
      'Kampala',
      'Westlands',
      'Kitengela',
      'Mombasa Road',
      'Kiambu Road',
      'Nairobi-Mombasa Road',
      'Mount Kenya',
      'Kenya',
      '12345',
      'N/A',
      '-',
      '/',
      'County',
      'Nairobi County County',
      'Nairobi City County County',
      // Only real separators are tolerated: a stray backslash is not a spelling,
      // so it fails rather than being guessed away.
      'Taita\\Taveta',
    ]) {
      expect(resolveCountyName(submitted), submitted).toBeNull();
    }
  });

  it('refuses empty, blank and non-string values instead of defaulting to a county', () => {
    for (const submitted of ['', '   ', '\t\n  ']) {
      expect(resolveCountyName(submitted), JSON.stringify(submitted)).toBeNull();
    }
    expect(resolveCountyName(null)).toBeNull();
    expect(resolveCountyName(undefined)).toBeNull();
    expect(resolveCountyName(47 as unknown as string)).toBeNull();
    expect(resolveCountyName({} as unknown as string)).toBeNull();
  });

  it('refuses a misspelling — no fuzzy matching, no "close enough"', () => {
    for (const submitted of [
      'Nairobii',
      'Nairob',
      'Nairoba',
      'Mombassa',
      'Kisumuu',
      'Muranga East',
      'Murangaa',
      'Taita Taveeta',
      'Elgeyo Marakwe',
      'Tharaka Nithii',
      'Homa Bayy',
    ]) {
      expect(resolveCountyName(submitted), submitted).toBeNull();
    }
  });

  it('refuses a PARTIAL or ambiguous name rather than guessing between counties', () => {
    // Each of these is a fragment of one or more county names, or a sub-county
    // name. None of them identifies exactly one of the 47 counties, so none can
    // be resolved — the honest answer is "unknown", not a best match.
    for (const submitted of [
      'Taita',
      'Taveta',
      'Elgeyo',
      'Marakwet',
      'Keiyo',
      'Tharaka',
      'Nithi',
      'Homa',
      'Bay',
      'Murang',
      'Samburu East',
      'Magarini North',
      'Kiambu County Road',
      'Nairobi City Extra',
    ]) {
      expect(resolveCountyName(submitted), submitted).toBeNull();
    }
  });
});

describe('3B-6C — normalisation cannot bypass sub-county county ownership', () => {
  const NAIROBI_UNIT = administrativeUnitsForCounty('Nairobi City')[0].id;
  const MOMBASA_UNIT = administrativeUnitsForCounty('Mombasa')[0].id;
  const TAITA_UNIT = administrativeUnitsForCounty('Taita-Taveta')[0].id;

  it('accepts a county written with a "County" suffix for its OWN units', () => {
    expect(resolveAdministrativeUnitId('Nairobi County', NAIROBI_UNIT)).toBe(NAIROBI_UNIT);
    expect(resolveAdministrativeUnitId('  nairobi   county  ', NAIROBI_UNIT)).toBe(NAIROBI_UNIT);
    expect(resolveAdministrativeUnitId('Taita/Taveta', TAITA_UNIT)).toBe(TAITA_UNIT);
    expect(administrativeUnitNameForCounty(' Taita / Taveta County ', TAITA_UNIT)).not.toBeNull();
  });

  it('refuses another county’s unit even when the county value is a legitimate variant', () => {
    expect(resolveAdministrativeUnitId('Nairobi County', MOMBASA_UNIT)).toBeNull();
    expect(resolveAdministrativeUnitId('Taita/Taveta County', NAIROBI_UNIT)).toBeNull();
    expect(resolveAdministrativeUnitId("murang’a", NAIROBI_UNIT)).toBeNull();
    expect(administrativeUnitNameForCounty("murang’a", NAIROBI_UNIT)).toBeNull();
  });

  it('an unknown, partial or misspelled county unlocks NO units at all', () => {
    for (const submitted of ['Nairobii', 'Nairobi District', 'Taita', 'Atlantis', '']) {
      expect(resolveAdministrativeUnitId(submitted, NAIROBI_UNIT), submitted).toBeNull();
      expect(administrativeUnitsForCounty(submitted), submitted).toEqual([]);
    }
  });

  it('lists the same units for a county however its name is formatted', () => {
    const canonical = administrativeUnitsForCounty('Taita-Taveta');
    for (const submitted of ['Taita/Taveta', 'Taita / Taveta County', '  TAITA-TAVETA  ']) {
      expect(administrativeUnitsForCounty(submitted), submitted).toEqual(canonical);
    }
  });
});

describe('3B-6C — an administrator’s correction stores the CANONICAL county', () => {
  const NAIROBI_UNIT = administrativeUnitsForCounty('Nairobi City')[0].id;
  const MOMBASA_UNIT = administrativeUnitsForCounty('Mombasa')[0].id;

  it('accepts a formatting variant and writes the canonical name', () => {
    for (const submitted of ['nairobi county', '  NAIROBI  ', 'Nairobi City County', 'nairobi']) {
      const verdict = validateAgentGeographyCorrection({
        county: submitted,
        administrativeUnitId: NAIROBI_UNIT,
      });
      expect(verdict.ok, submitted).toBe(true);
      expect(verdict.correction).toEqual({
        county: 'Nairobi City',
        administrativeUnitId: NAIROBI_UNIT,
      });
      expect(verdict.error).toBe('');
      expect(verdict.field).toBeNull();
    }
  });

  it('accepts a slash and an apostrophe variant for their OWN sub-county', () => {
    const taitaUnit = administrativeUnitsForCounty('Taita-Taveta')[0].id;
    const murangaUnit = administrativeUnitsForCounty("Murang'a")[0].id;

    const taitaVerdict = validateAgentGeographyCorrection({
      county: 'Taita / Taveta',
      administrativeUnitId: taitaUnit,
    });
    expect(taitaVerdict.ok).toBe(true);
    expect(taitaVerdict.correction.county).toBe('Taita-Taveta');

    const murangaVerdict = validateAgentGeographyCorrection({
      county: 'MURANG’A',
      administrativeUnitId: murangaUnit,
    });
    expect(murangaVerdict.correction.county).toBe("Murang'a");
  });
});

describe('3B-6C — the correction still REFUSES what the resolver cannot justify', () => {
  const NAIROBI_UNIT = administrativeUnitsForCounty('Nairobi City')[0].id;
  const MOMBASA_UNIT = administrativeUnitsForCounty('Mombasa')[0].id;

  it('refuses an unknown or partial county, naming the county field', () => {
    for (const submitted of ['Nairobii', 'Taita', 'Nairobi District']) {
      const verdict = validateAgentGeographyCorrection({
        county: submitted,
        administrativeUnitId: NAIROBI_UNIT,
      });
      expect(verdict.ok, submitted).toBe(false);
      expect(verdict.field).toBe('county');
      expect(verdict.error).toBe(AGENT_GEOGRAPHY_COUNTY_REQUIRED_MESSAGE);
      expect(verdict.correction).toBeNull();
    }
  });

  it('refuses a cross-county sub-county even when the county is a variant spelling', () => {
    const verdict = validateAgentGeographyCorrection({
      county: 'Nairobi County',
      administrativeUnitId: MOMBASA_UNIT,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.field).toBe('administrativeUnitId');
    expect(verdict.error).toBe(AGENT_GEOGRAPHY_UNIT_MISMATCH_MESSAGE);
    expect(verdict.correction).toBeNull();
  });
});

describe('3B-6C — agent registration refuses county and sub-county SEPARATELY', () => {
  // POST /api/auth/verify-otp is declared inside startServer() and cannot be
  // mounted (the repository's established constraint), so the route contract is
  // pinned by reading its source — the convention used by
  // batch3Stage6AdminGeographyRoutes.test.ts and foundItemCounty.test.ts.
  it('resolves the county first, through the one canonical resolver', () => {
    expect(SERVER_SOURCE).toContain('const canonicalAgentCounty = resolveCountyName(county);');
    const countyGuard = SERVER_SOURCE.indexOf('if (!canonicalAgentCounty) {');
    const unitLookup = SERVER_SOURCE.indexOf(
      'const canonicalAgentUnit = resolveAdministrativeUnitId(canonicalAgentCounty, administrativeUnitId);',
    );
    const unitGuard = SERVER_SOURCE.indexOf('if (!canonicalAgentUnit) {');
    expect(countyGuard).toBeGreaterThan(-1);
    expect(unitLookup).toBeGreaterThan(countyGuard);
    expect(unitGuard).toBeGreaterThan(unitLookup);
  });

  it('no longer answers a county problem with a sub-county message', () => {
    // The regression this stage removes: one combined guard told an applicant to
    // choose a sub-county when the COUNTY was the invalid field, sending them to
    // a list that could never satisfy the refusal.
    expect(SERVER_SOURCE).not.toContain('if (!canonicalAgentCounty || !canonicalAgentUnit)');

    const countyGuard = SERVER_SOURCE.indexOf('if (!canonicalAgentCounty) {');
    const unitGuard = SERVER_SOURCE.indexOf('if (!canonicalAgentUnit) {');
    const unrecognised = SERVER_SOURCE.indexOf('That county is not a recognised Kenyan county.');
    const countyPrompt = SERVER_SOURCE.indexOf('Please choose the county your Agent hub serves.');
    const unitPrompt = SERVER_SOURCE.indexOf('Please choose a sub-county belonging to your service county.');

    expect(unrecognised).toBeGreaterThan(countyGuard);
    expect(unrecognised).toBeLessThan(unitGuard);
    expect(countyPrompt).toBeGreaterThan(countyGuard);
    expect(countyPrompt).toBeLessThan(unitGuard);
    expect(unitPrompt).toBeGreaterThan(unitGuard);
  });

  it('still stores the canonical county and sub-county on the new Agent row', () => {
    expect(SERVER_SOURCE).toContain('county: canonicalAgentCounty,');
    expect(SERVER_SOURCE).toContain('administrative_unit_id: canonicalAgentUnit,');
  });
});

describe('3B-6C — the Finder report accepts the same variants and stores canonical', () => {
  it('resolves every required formatting variant', () => {
    expect(resolveFoundCountyInput('Taita/Taveta')).toEqual({ ok: true, county: 'Taita-Taveta' });
    expect(resolveFoundCountyInput('elgeyo / marakwet').county).toBe('Elgeyo-Marakwet');
    expect(resolveFoundCountyInput('Murang’a').county).toBe("Murang'a");
    expect(resolveFoundCountyInput('nairobi county').county).toBe('Nairobi City');
    expect(resolveFoundCountyInput('  NAIROBI CITY COUNTY ').county).toBe('Nairobi City');
    expect(resolveFoundCountyInput('  taita   /   taveta  ').county).toBe('Taita-Taveta');
  });

  it('still refuses an unknown or partial county', () => {
    for (const submitted of ['Nairobii', 'Taita', 'Atlantis', 'Samburu East']) {
      expect(resolveFoundCountyInput(submitted).ok, submitted).toBe(false);
    }
  });

  it('derives the sub-county from the CANONICAL county, so ownership is checked', () => {
    expect(FINDER_REPORT_SOURCE).toContain(
      'resolveAdministrativeUnitId(canonicalFoundCounty, administrativeUnitId)',
    );
    expect(FINDER_REPORT_SOURCE).toContain('found_county: canonicalFoundCounty');
    expect(FINDER_REPORT_SOURCE).not.toContain('found_county: foundCounty');
  });
});

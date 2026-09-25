import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  KENYA_COUNTIES,
  KENYA_COUNTY_NAMES,
  KENYA_COUNTY_ALIASES,
  resolveCountyName,
  countiesByUxGroup,
  UX_GROUP_ORDER,
} from '../config/kenyaCounties';
import { resolveFoundCountyInput } from '../services/foundItemCounty';

// ===========================================================================
// P14C-3A — ONE canonical 47-county source + exact place as free text
//
// The product requirement is: every Kenyan county selector offers all 47
// canonical counties, and the human-entered location remains free text
// ("County → Exact place"). No sub-county dataset is part of this phase.
//
// Source-level assertions are the repository's established technique (there is
// no jsdom/RTL), so comments are stripped before scanning JSX.
// ===========================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const FINDER = stripComments(read('src/components/FinderView.tsx'));
const WIZARD = stripComments(read('src/components/customer/LostReportWizard.tsx'));
const OWNER = stripComments(read('src/components/OwnerView.tsx'));
const LOST_ROUTES = stripComments(read('src/routes/lostReports.ts'));
const TYPES_TS = read('src/types.ts');

/** The 47 county names the product must offer (verification reference only). */
const REQUIRED_COUNTY_NAMES = [
  'Mombasa', 'Kwale', 'Kilifi', 'Tana River', 'Lamu', 'Taita-Taveta', 'Garissa',
  'Wajir', 'Mandera', 'Marsabit', 'Isiolo', 'Meru', 'Tharaka-Nithi', 'Embu',
  'Kitui', 'Machakos', 'Makueni', 'Nyandarua', 'Nyeri', 'Kirinyaga', "Murang'a",
  'Kiambu', 'Turkana', 'West Pokot', 'Samburu', 'Trans Nzoia', 'Uasin Gishu',
  'Elgeyo-Marakwet', 'Nandi', 'Baringo', 'Laikipia', 'Nakuru', 'Narok', 'Kajiado',
  'Kericho', 'Bomet', 'Kakamega', 'Vihiga', 'Bungoma', 'Busia', 'Siaya', 'Kisumu',
  'Homa Bay', 'Migori', 'Kisii', 'Nyamira', 'Nairobi City',
];

describe('P14C-3A — the canonical county source is exactly 47, with no duplicates', () => {
  it('holds exactly 47 counties, coded KE-01..KE-47 in order and uniquely', () => {
    expect(KENYA_COUNTIES.length).toBe(47);
    const codes = KENYA_COUNTIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(47);
    expect(codes[0]).toBe('KE-01');
    expect(codes[46]).toBe('KE-47');
  });

  it('has 47 unique canonical names, and the derived name list matches', () => {
    const names = KENYA_COUNTIES.map((c) => c.name);
    expect(new Set(names).size).toBe(47);
    expect(KENYA_COUNTY_NAMES.length).toBe(47);
    expect([...KENYA_COUNTY_NAMES]).toEqual(names);
  });

  it('offers every county the product requires — none missing, none invented', () => {
    for (const name of REQUIRED_COUNTY_NAMES) {
      expect(KENYA_COUNTY_NAMES, `${name} must be selectable`).toContain(name);
    }
    expect([...KENYA_COUNTY_NAMES].sort()).toEqual([...REQUIRED_COUNTY_NAMES].sort());
  });

  it('keeps the canonical application naming (Nairobi City, not Nairobi)', () => {
    expect(KENYA_COUNTY_NAMES).toContain('Nairobi City');
    expect(KENYA_COUNTY_NAMES).not.toContain('Nairobi');
  });

  it('places every county in exactly one display group, and groups are unique', () => {
    const groups = countiesByUxGroup();
    const flattened = groups.flatMap((g) => g.counties.map((c) => c.name));
    expect(flattened.length).toBe(47);
    expect(new Set(flattened).size).toBe(47);
    expect(groups.length).toBe(UX_GROUP_ORDER.length);
    expect(new Set(groups.map((g) => g.group)).size).toBe(groups.length);
  });

  it('resolves known aliases to canonical names that exist in the list', () => {
    for (const [alias, canonical] of Object.entries(KENYA_COUNTY_ALIASES)) {
      expect(KENYA_COUNTY_NAMES, `alias ${alias}`).toContain(canonical);
    }
    expect(resolveCountyName('nairobi')).toBe('Nairobi City');
    expect(resolveCountyName('  MOMBASA ')).toBe('Mombasa');
  });
});

describe('P14C-3A — every real county selector consumes the ONE canonical source', () => {
  it('the Finder builds its REQUIRED county select from countiesByUxGroup()', () => {
    expect(FINDER).toContain('countiesByUxGroup');
    expect(FINDER).toMatch(/id="finder-county"/);
    expect(FINDER).toMatch(/COUNTY_GROUPS\.map\(/);
    expect(FINDER).toContain('group.counties.map');
    // The option VALUE is the canonical name the server validates.
    expect(FINDER).toMatch(/value=\{county\.name\}/);
    expect(FINDER).toMatch(/required/);
  });

  it('the lost-report wizard builds its REQUIRED county select from countiesByUxGroup()', () => {
    expect(WIZARD).toContain('countiesByUxGroup');
    expect(WIZARD).toContain('countyGroups.map');
    expect(WIZARD).toContain('group.counties.map');
    expect(WIZARD).toMatch(/value=\{county\.name\}/);
    expect(WIZARD).toMatch(/label=\{t\('County', 'Kaunti'\)\}/);
    expect(WIZARD).toMatch(/required/);
  });

  it('no suggested county vocabulary is re-introduced on the exact-place fields', () => {
    expect(FINDER).not.toContain('<datalist');
    expect(WIZARD).not.toContain('<datalist');
    expect(FINDER).not.toContain('KENYA_COUNTY_NAMES');
    expect(WIZARD).not.toContain('KENYA_COUNTY_NAMES');
  });

  it('the Owner search county selector consumes the ONE canonical source too', () => {
    // Phase 16.1 (GEO-16-01): the Owner's old "Area Quick Selector" was fed by
    // GET /api/regions — counties, towns and estates mixed — and is now a county
    // select built from the same canonical dataset as the Finder's and the
    // wizard's.
    expect(OWNER).toContain('countiesByUxGroup');
    expect(OWNER).toContain('COUNTY_GROUPS.map');
    expect(OWNER).toContain('group.counties.map');
    expect(OWNER).toMatch(/value=\{county\.name\}/);
    expect(OWNER).not.toContain("fetch('/api/regions')");
  });

  it('there is no second hardcoded county list in application source', () => {
    // src/config/kenyaCounties.ts is the ONE canonical county dataset. No other
    // application source file may maintain a second county-shaped vocabulary:
    // the old /api/regions mixed area/town list was retired in Phase 16.1
    // (GEO-16-07), together with its endpoint and its data-layer method.
    // A file quoting five or more distinct canonical county names is therefore
    // either the ONE source or an offender, and this test expects NONE.
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
        return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
      });

    const offenders: string[] = [];
    for (const file of walk(path.resolve(repoRoot, 'src'))) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      if (rel === 'src/config/kenyaCounties.ts') continue;
      const body = stripComments(fs.readFileSync(file, 'utf8'));
      const hits = KENYA_COUNTY_NAMES.filter(
        (name) => body.includes(`'${name}'`) || body.includes(`"${name}"`),
      );
      if (hits.length >= 5) offenders.push(rel);
    }

    expect(offenders, `unexpected hardcoded county list(s): ${offenders.join(', ')}`)
      .toEqual([]);

    // …and there is genuinely no permitted hit any more: Phase 16.1 (GEO-16-07) retired the /api/regions fallback (a 30-entry AREA/TOWN list that mainly held non-counties) together with the endpoint, so no application file may keep a second county-shaped vocabulary.
    const database = stripComments(read('src/db/database.ts'));
    expect(database).not.toContain('getDistinctRegions');
    expect(database).not.toContain('fallbackRegions');
  });
});

describe('P14C-3A — "Exact place" is free text, clearly labelled, never a vocabulary', () => {
  it('the Finder label says "Exact place" in both languages', () => {
    expect(TYPES_TS).toContain("locLabel: 'Exact place'");
    expect(TYPES_TS).toContain("locLabel: 'Mahali halisi'");
  });

  it('the Finder exact-place field is a required free-text input posting verbatim', () => {
    expect(FINDER).toMatch(/id="finder-location"/);
    expect(FINDER).toMatch(/value=\{locationDescription\}/);
    expect(FINDER).toMatch(/onChange=\{\(e\) => setLocationDescription\(e\.target\.value\)\}/);
    expect(FINDER).toMatch(/aria-describedby="finder-location-hint"/);
    expect(FINDER).toMatch(/id="finder-location-hint"/);
    // No county knowledge is attached to the field.
    expect(FINDER).not.toMatch(/id="finder-location"[^>]*list=/);
  });

  it('the lost-report field is labelled "Exact place" and keeps its API/DB field', () => {
    expect(WIZARD).toContain("label={t('Exact place', 'Mahali halisi')}");
    expect(WIZARD).toMatch(/value=\{form\.locationArea\}/);
    expect(WIZARD).toMatch(/set\('locationArea', e\.target\.value\)/);
    // The separately-supported optional landmark field is retained.
    expect(WIZARD).toContain("label={t('Landmark (optional)', 'Alama ya eneo (si lazima)')}");
    expect(WIZARD).toMatch(/set\('locationLandmark', e\.target\.value\)/);
  });

  it('neither exact-place field promises automatic identification or better payout', () => {
    for (const [label, src] of [['FinderView', FINDER], ['LostReportWizard', WIZARD]] as const) {
      expect(src, label).not.toMatch(/will (automatically )?(find|identify|detect)/i);
      expect(src, label).not.toMatch(/faster payout/i);
    }
  });
});

describe('P14C-3A — API validation and payload compatibility are unchanged', () => {
  it('the server still canonicalises the county through the ONE resolver', () => {
    expect(LOST_ROUTES).toContain('resolveCountyName');
    expect(LOST_ROUTES).toMatch(/const county = resolveCountyName\(body\.county\)/);
  });

  it('the lost-report request field is still `locationArea` (label change only)', () => {
    expect(LOST_ROUTES).toMatch(/requiredText\(body\.locationArea/);
    expect(LOST_ROUTES).toContain("'Exact place'");
    expect(LOST_ROUTES).not.toContain("'Town/Area'");
    expect(LOST_ROUTES).toMatch(/location_area: locationArea\.value as string/);
  });

  it('a Finder still posts the same two location fields', () => {
    expect(FINDER).toMatch(/foundCounty,/);
    expect(FINDER).toMatch(/locationDescription,/);
  });

  it('behaviour: a canonical county is accepted, an arbitrary string is rejected', () => {
    expect(resolveFoundCountyInput('Mombasa')).toEqual({ ok: true, county: 'Mombasa' });
    expect(resolveFoundCountyInput('nairobi').county).toBe('Nairobi City');
    for (const bogus of ['Atlantis', 'Westlands', 'Mombasa Road', 'Kitengela', '12345', '']) {
      expect(resolveFoundCountyInput(bogus).ok, bogus).toBe(false);
    }
    // The exact place is NOT a county and must never be coerced into one.
    expect(resolveCountyName('Near Sarit Centre, Westlands')).toBeNull();
    expect(resolveCountyName('Opposite Nyayo Stadium')).toBeNull();
  });
});

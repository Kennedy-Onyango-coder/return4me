/**
 * Supplied Kenya second-level administrative geography baseline.
 *
 * The 47 county identities/order remain owned exclusively by kenyaCounties.ts.
 * Each row below explicitly binds a supplied display name to that county code;
 * it is never inferred from the name. The user-facing product calls this level
 * "sub-county". These values are the supplied implementation baseline, not a
 * claim of a separately researched legal Gazette register.
 *
 * IDENTIFIER VS GEOGRAPHIC MEANING (GEO-A)
 *   - `id` (e.g. "KE-11-SC-01") is a Return4me PRODUCT / SERVICE-AREA surrogate
 *     key. It is stored on items, lost reports and agent records, so it is
 *     IMMUTABLE: never renumber, merge, delete or reuse an id.
 *   - `canonicalEntityType` / `canonicalEntityName` describe what geographic
 *     entity the product row most closely represents — an IEBC electoral
 *     constituency, a KNBS administrative sub-county, a ward/division, or an
 *     entity the audit could not identify.
 *   - Neither the product id nor the canonical metadata is by itself a legal
 *     boundary identifier, and no polygon/geometry is implied or stored here.
 *
 * Every row NOT listed in CANONICAL_ENTITY_OVERRIDES below is a clean IEBC
 * electoral constituency whose canonical name equals its displayed name.
 */
import { KENYA_COUNTIES, type KenyanCounty } from './kenyaCounties';

/** Controlled vocabulary for what geographic entity a product row represents. */
export type CanonicalEntityType =
  | 'electoral_constituency'
  | 'administrative_subcounty'
  | 'ward'
  | 'unknown';

/** Normalised geographic meaning of a product row. Not a legal boundary. */
export interface CanonicalEntity {
  readonly type: CanonicalEntityType;
  readonly name: string;
}

export interface KenyaAdministrativeUnit {
  /** Immutable Return4me product/service-area key. Never renumber or reuse. */
  id: string;
  countyCode: KenyanCounty['code'];
  /** The supplied user-facing display name. Unchanged in this batch. */
  name: string;
  /** GEO-A: normalised geographic entity type of this product row. */
  canonicalEntityType: CanonicalEntityType;
  /** GEO-A: corrected canonical entity name; equals `name` for clean rows. */
  canonicalEntityName: string;
}

type CountyUnitGroup = readonly [KenyanCounty['code'], readonly string[]];

const COUNTY_UNIT_GROUPS: readonly CountyUnitGroup[] = [
  ['KE-01', ['Changamwe', 'Jomvu', 'Kisauni', 'Nyali', 'Likoni', 'Mvita']],
  ['KE-02', ['Msambweni', 'Lunga Lunga', 'Matuga', 'Kinango', 'Samburu East']],
  ['KE-03', ['Kilifi North', 'Kilifi South', 'Kaloleni', 'Rabai', 'Ganze', 'Malindi', 'Magarini', 'Magarini North', 'Magarini South']],
  ['KE-04', ['Garsen', 'Galole', 'Bura']],
  ['KE-05', ['Lamu East', 'Lamu West']],
  ['KE-06', ['Taveta', 'Wundanyi', 'Mwatate', 'Voi']],
  ['KE-07', ['Garissa Township', 'Balambala', 'Lagdera', 'Dadaab', 'Fafi', 'Ijara', 'Bothai']],
  ['KE-08', ['Wajir North', 'Wajir East', 'Tarbaj', 'Wajir West', 'Eldas', 'Wajir South']],
  ['KE-09', ['Mandera West', 'Banissa', 'Mandera North', 'Mandera South', 'Mandera East', 'Lafey']],
  ['KE-10', ['Moyale', 'North Horr', 'Saku', 'Laisamis', 'Illeret']],
  ['KE-11', ['Isiolo', 'Merti', 'Garbatulla']],
  ['KE-12', ['Igembe South', 'Igembe Central', 'Igembe North', 'Tigania West', 'Tigania East', 'North Imenti', 'Buuri', 'Central Imenti', 'South Imenti', 'Akachiu']],
  ['KE-13', ['Maara', 'Chuka/Igambang\'ombe', 'Tharaka', 'Mukothima']],
  ['KE-14', ['Manyatta', 'Runyenjes', 'Mbeere North', 'Mbeere South']],
  ['KE-15', ['Mwingi North', 'Mwingi West', 'Mwingi Central', 'Kitui West', 'Kitui Rural', 'Kitui Central', 'Kitui East', 'Kitui South']],
  ['KE-16', ['Masinga', 'Yatta', 'Kangundo', 'Matungulu', 'Kathiani', 'Mavoko', 'Machakos Town', 'Mwala', 'Ndithini']],
  ['KE-17', ['Mbooni', 'Kilome', 'Kaiti', 'Makueni', 'Kibwezi West', 'Kibwezi East']],
  ['KE-18', ['Kinangop', 'Kipipiri', 'Ol Kalou', 'Ol Jorok', 'Ndaragwa', 'Aberdares']],
  ['KE-19', ['Tetu', 'Kieni East', 'Kieni West', 'Mathira East', 'Mathira West', 'Othaya', 'Mukurweini', 'Nyeri Town']],
  ['KE-20', ['Mwea East', 'Mwea West', 'Gichugu', 'Ndidia', 'Kirinyaga Central', 'Kirinyaga East']],
  ['KE-21', ['Kangema', 'Mathioya', 'Kahuro', 'Kigumo', 'Maragua', 'Kandara', 'Gatanga', 'Murang\'a South']],
  ['KE-22', ['Gatundu South', 'Gatundu North', 'Juja', 'Thika Town', 'Ruiru', 'Githunguri', 'Kiambu', 'Kiambaa', 'Kabete', 'Kikuyu', 'Lari', 'Limuru']],
  ['KE-23', ['Turkana North', 'Turkana West', 'Turkana Central', 'Loima', 'Turkana South', 'Turkana East']],
  ['KE-24', ['Kapenguria', 'Sigor', 'Kacheliba', 'Pokot South']],
  ['KE-25', ['Samburu West', 'Samburu North', 'Samburu East']],
  ['KE-26', ['Cherangany', 'Endebess', 'Saboti', 'Kwanza', 'Kiminini']],
  ['KE-27', ['Soy', 'Turbo', 'Moiben', 'Ainabkoi', 'Kapseret', 'Kesses']],
  ['KE-28', ['Marakwet East', 'Marakwet West', 'Keiyo North', 'Keiyo South']],
  ['KE-29', ['Tinderet', 'Aldai', 'Nandi Hills', 'Chesumei', 'Emgwen', 'Mosop']],
  ['KE-30', ['Tiaty', 'Baringo North', 'Baringo Central', 'Baringo South', 'Mogotio', 'Eldama Ravine', 'Kolowa', 'Baringo West', 'Mukutani']],
  ['KE-31', ['Laikipia West', 'Laikipia East', 'Laikipia North']],
  ['KE-32', ['Molo', 'Njoro', 'Naivasha', 'Gilgil', 'Kuresoi South', 'Kuresoi North', 'Subukia', 'Rongai', 'Bahati', 'Nakuru Town West', 'Nakuru Town East']],
  ['KE-33', ['Kilgoris', 'Emurua Dikirr', 'Narok North', 'Narok East', 'Narok South', 'Narok West']],
  ['KE-34', ['Kajiado North', 'Kajiado Central', 'Kajiado East', 'Kajiado West', 'Kajiado South']],
  ['KE-35', ['Kipkelion East', 'Kipkelion West', 'Belgut', 'Ainamoi', 'Soin Sigowet', 'Bureti']],
  ['KE-36', ['Sotik', 'Chepalungu', 'Bomet East', 'Bomet Central', 'Konoin']],
  ['KE-37', ['Lugari', 'Likuyani', 'Malava', 'Lurambi', 'Navakholo', 'Mumias West', 'Mumias East', 'Matungu', 'Butere', 'Khwisero', 'Shinyalu', 'Ikolomani']],
  ['KE-38', ['Vihiga', 'Sabatia', 'Hamisi', 'Luanda', 'Emuhaya']],
  ['KE-39', ['Mount Elgon', 'Sirisia', 'Kabuchai', 'Bumula', 'Kanduyi', 'Webuye East', 'Webuye West', 'Kimilili', 'Tongaren']],
  ['KE-40', ['Teso North', 'Teso South', 'Nambale', 'Matayos', 'Butula', 'Funyula', 'Budalangi']],
  ['KE-41', ['Ugenya', 'Ugunja', 'Alego Usonga', 'Gem', 'Bondo', 'Rarieda', 'Siaya West']],
  ['KE-42', ['Kisumu East', 'Kisumu West', 'Kisumu Central', 'Seme', 'Nyando', 'Muhoroni', 'Nyakach', 'North East Kano']],
  ['KE-43', ['Kasipul', 'Kabondo Kasipul', 'Karachuonyo', 'Rangwe', 'Homa Bay Town', 'Ndhiwa', 'Ndhiwa East', 'Ndhiwa West', 'Suba North', 'Suba South']],
  ['KE-44', ['Rongo', 'Awendo', 'Suna South', 'Suna West', 'Uriri', 'Nyatike', 'Kuria West', 'Kuria East']],
  ['KE-45', ['Bonchari', 'South Mugirango', 'Bomachoge Borabu', 'Bobasi', 'Bomachoge Chache', 'Nyaribari Masaba', 'Nyaribari Chache', 'Kitutu Chache North', 'Kitutu Chache South']],
  ['KE-46', ['Kitutu Masaba', 'West Mugirango', 'North Mugirango', 'Borabu']],
  ['KE-47', ['Westlands', 'Dagoretti North', 'Dagoretti South', 'Lang\'ata', 'Kibra', 'Roysambu', 'Kasarani', 'Ruaraka', 'Embakasi South', 'Embakasi North', 'Embakasi Central', 'Embakasi East', 'Embakasi West', 'Makadara', 'Kamukunji', 'Starehe', 'Mathare']],
];

/**
 * GEO-A normalisation overrides, keyed by immutable product id. Every id NOT
 * present here is a clean electoral constituency (canonical name === display
 * name). Only the 32 rows the GEO-1.5 audit flagged as non-clean appear here.
 * This map changes NO id, county association or display name.
 */
export const CANONICAL_ENTITY_OVERRIDES: Readonly<Record<string, CanonicalEntity>> = {
  // Misplaced row: this display name belongs to Samburu county, not Kwale. The
  // row is kept in place (id / county / name unchanged) but is NOT presented as
  // a valid Kwale constituency — classified `unknown` rather than inventing one.
  'KE-02-SC-05': { type: 'unknown', name: 'Samburu East' },

  // Spelling variants: the product label misspells the canonical constituency.
  'KE-20-SC-04': { type: 'electoral_constituency', name: 'Ndia' }, // label "Ndidia"
  'KE-21-SC-03': { type: 'electoral_constituency', name: 'Kiharu' }, // label "Kahuro"
  'KE-35-SC-05': { type: 'electoral_constituency', name: 'Sigowet/Soin' }, // label "Soin Sigowet"
  'KE-44-SC-03': { type: 'electoral_constituency', name: 'Suna East' }, // label "Suna South"

  // Genuine KNBS administrative sub-counties (not IEBC constituencies).
  'KE-11-SC-01': { type: 'administrative_subcounty', name: 'Isiolo' },
  'KE-11-SC-02': { type: 'administrative_subcounty', name: 'Merti' },
  'KE-11-SC-03': { type: 'administrative_subcounty', name: 'Garbatulla' },
  'KE-19-SC-02': { type: 'administrative_subcounty', name: 'Kieni East' },
  'KE-19-SC-03': { type: 'administrative_subcounty', name: 'Kieni West' },
  'KE-19-SC-04': { type: 'administrative_subcounty', name: 'Mathira East' },
  'KE-19-SC-05': { type: 'administrative_subcounty', name: 'Mathira West' },
  'KE-20-SC-01': { type: 'administrative_subcounty', name: 'Mwea East' },
  'KE-20-SC-02': { type: 'administrative_subcounty', name: 'Mwea West' },
  'KE-42-SC-08': { type: 'administrative_subcounty', name: 'North East Kano' },
  'KE-43-SC-07': { type: 'administrative_subcounty', name: 'Ndhiwa East' },
  'KE-43-SC-08': { type: 'administrative_subcounty', name: 'Ndhiwa West' },

  // Ward / division rows.
  'KE-10-SC-05': { type: 'ward', name: 'Illeret' },
  'KE-12-SC-10': { type: 'ward', name: 'Akachiu' },
  'KE-13-SC-04': { type: 'ward', name: 'Mukothima' },
  'KE-16-SC-09': { type: 'ward', name: 'Ndithini' },
  'KE-30-SC-09': { type: 'ward', name: 'Mukutani' },

  // Not conclusively identified by the audit — classified `unknown` rather than
  // guessing a constituency (includes Ol Jorok, which the audit read as a
  // medium-confidence constituency; see the GEO-A/B report for the discrepancy).
  'KE-03-SC-08': { type: 'unknown', name: 'Magarini North' },
  'KE-03-SC-09': { type: 'unknown', name: 'Magarini South' },
  'KE-07-SC-07': { type: 'unknown', name: 'Bothai' },
  'KE-18-SC-04': { type: 'unknown', name: 'Ol Jorok' },
  'KE-18-SC-06': { type: 'unknown', name: 'Aberdares' },
  'KE-20-SC-06': { type: 'unknown', name: 'Kirinyaga East' },
  'KE-21-SC-08': { type: 'unknown', name: "Murang'a South" },
  'KE-30-SC-07': { type: 'unknown', name: 'Kolowa' },
  'KE-30-SC-08': { type: 'unknown', name: 'Baringo West' },
  'KE-41-SC-07': { type: 'unknown', name: 'Siaya West' },
};

export const KENYA_ADMINISTRATIVE_UNITS: readonly KenyaAdministrativeUnit[] = COUNTY_UNIT_GROUPS.flatMap(([countyCode, names]) => names.map((name, index) => {
  const id = `${countyCode}-SC-${String(index + 1).padStart(2, '0')}`;
  const canonical = CANONICAL_ENTITY_OVERRIDES[id];
  return {
    id,
    countyCode,
    name,
    canonicalEntityType: canonical?.type ?? 'electoral_constituency',
    canonicalEntityName: canonical?.name ?? name,
  };
}));

const unitMap = new Map(KENYA_ADMINISTRATIVE_UNITS.map(unit => [unit.id, unit]));
const unitIdByCountyAndName = new Map(KENYA_ADMINISTRATIVE_UNITS.map(unit => [
  `${unit.countyCode}\u0000${unit.name.toLocaleLowerCase('en')}`,
  unit.id,
]));

export function administrativeUnitsForCounty(countyName: string): readonly KenyaAdministrativeUnit[] {
  const county = KENYA_COUNTIES.find(item => item.name === countyName);
  return county ? KENYA_ADMINISTRATIVE_UNITS.filter(unit => unit.countyCode === county.code) : [];
}

export function resolveAdministrativeUnitId(countyName: string, unitId: unknown): string | null {
  if (typeof unitId !== 'string') return null;
  const county = KENYA_COUNTIES.find(item => item.name === countyName);
  const unit = unitMap.get(unitId);
  return county && unit?.countyCode === county.code ? unit.id : null;
}

export function administrativeUnitById(unitId: string | null | undefined): KenyaAdministrativeUnit | null {
  return unitId ? unitMap.get(unitId) ?? null : null;
}

export function administrativeUnitNameForCounty(countyName: string, unitId: string | null | undefined): string | null {
  if (!unitId) return null;
  const county = KENYA_COUNTIES.find(item => item.name === countyName);
  const unit = unitMap.get(unitId);
  return county && unit?.countyCode === county.code ? unit.name : null;
}

// Exported for tests/diagnostics; runtime submission resolution is ID-based.
export function findAdministrativeUnitIdByName(countyName: string, name: string): string | null {
  const county = KENYA_COUNTIES.find(item => item.name === countyName);
  return county ? unitIdByCountyAndName.get(`${county.code}\u0000${name.trim().toLocaleLowerCase('en')}`) ?? null : null;
}

/**
 * GEO-B alias table: county-aware user/provider spellings that denote an
 * existing immutable product row WITHOUT changing its stored id, county or
 * display name. Keyed by county so a name in one county can never resolve to a
 * same-named unit in another county.
 */
const UNIT_ALIASES: readonly { readonly countyCode: KenyanCounty['code']; readonly alias: string; readonly unitId: string }[] = [
  { countyCode: 'KE-20', alias: 'ndidia', unitId: 'KE-20-SC-04' }, // → Ndia
  { countyCode: 'KE-21', alias: 'kahuro', unitId: 'KE-21-SC-03' }, // → Kiharu
  { countyCode: 'KE-35', alias: 'soin sigowet', unitId: 'KE-35-SC-05' }, // → Sigowet/Soin
  { countyCode: 'KE-44', alias: 'suna south', unitId: 'KE-44-SC-03' }, // → Suna East
];

const aliasUnitIdByCountyAndName = new Map(UNIT_ALIASES.map(alias => [
  `${alias.countyCode}\u0000${alias.alias.toLocaleLowerCase('en')}`,
  alias.unitId,
]));

/**
 * Resolves a user/provider spelling to the existing immutable product unit it
 * denotes, or null. County-aware: `countyIdentity` accepts the canonical county
 * name or its "KE-NN" code (case-tolerantly), and the alias only matches WITHIN
 * that county. The alias is a lookup only — it never renames, merges, deletes or
 * re-homes a unit, and the normal write path stays id-based via
 * resolveAdministrativeUnitId().
 */
export function resolveAdministrativeUnitAlias(countyIdentity: string, suppliedName: string): KenyaAdministrativeUnit | null {
  if (typeof countyIdentity !== 'string' || typeof suppliedName !== 'string') return null;
  const needle = countyIdentity.trim().toLocaleLowerCase('en');
  const county = KENYA_COUNTIES.find(item => item.name.toLocaleLowerCase('en') === needle || item.code.toLocaleLowerCase('en') === needle);
  if (!county) return null;
  const unitId = aliasUnitIdByCountyAndName.get(`${county.code}\u0000${suppliedName.trim().toLocaleLowerCase('en')}`);
  return unitId ? unitMap.get(unitId) ?? null : null;
}

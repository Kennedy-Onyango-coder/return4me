/**
 * CANONICAL KENYAN LOCATION DATA
 * ==============================
 * This file is the application's ONE canonical county dataset. There is exactly
 * one list, it is imported rather than re-typed, and no component may keep a
 * second copy of it.
 *
 * WHAT IS STORED, AND HOW A COUNTY IS VALIDATED
 *   - `items.found_county` and `lost_reports.county` hold a CANONICAL county
 *     name — one of the 47 below — or nothing at all where the row predates the
 *     field. No other value is ever written there.
 *   - The county VALUE is validated and canonicalised at the API boundary by
 *     `resolveCountyName()` in this file. That function is the only county
 *     resolver in the codebase: it returns a canonical name or `null`, and it
 *     never guesses a nearby county.
 *   - The Finder (`components/FinderView.tsx`) and the lost-report wizard
 *     (`components/customer/LostReportWizard.tsx`) both present the county as a
 *     REQUIRED selector built from `countiesByUxGroup()` — not a free-text
 *     field, and not a second hard-coded list.
 *
 * "EXACT PLACE" IS FREE TEXT, AND IS NEVER INTERPRETED
 *   The human detail of where something was found or lost stays the user's own
 *   words, stored verbatim: `items.location_description` (the Finder's "Exact
 *   place") and `lost_reports.location_area` (the lost report's "Exact place",
 *   alongside an optional separate `location_landmark`).
 *
 *   That text is deliberately NOT parsed. Nothing in this codebase reads an
 *   exact-place string and derives a sub-county, city, town, ward, estate or
 *   landmark from it, and no administrative geography is inferred from it —
 *   not here, not at the API boundary, not in matching. (The single place free
 *   text is sent to a forward geocoder is operational agent routing, which uses
 *   the returned COORDINATES and never rewrites or reinterprets the text.)
 *
 * AUTHORITY — the 47 counties are those created by Article 6(1) and the First
 * Schedule of the Constitution of Kenya (2010); there are exactly 47, and they
 * are the only county-level administrative units. Spellings below follow
 * ISO 3166-2:KE, the published international form of the same list (the
 * Constitution writes two of them with a slash: "Taita/Taveta" and
 * "Elgeyo/Marakwet"; ISO and common usage write "Taita-Taveta" and
 * "Elgeyo-Marakwet" — `constitutionName` records that difference so nobody has
 * to guess later).
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN
 *   - no sub-counties, wards, villages or "areas": those are large (290+
 *     sub-counties, 1,450 wards) and change; hard-coding them here would create
 *     invented or stale administrative data. The UI asks for the COUNTY as a
 *     selector (see `countiesByUxGroup()`), and everything below it as typed
 *     free text — the "Exact place" field.
 *   - no coordinates per county: an approximate centroid would be a fabricated
 *     location, and the only coordinates Return4me uses are the ones the browser
 *     actually reports (see FinderView) or the geocoder actually returns (see
 *     AgentMatchingService).
 *
 * `uxGroup` IS NOT A GOVERNMENT UNIT. It is a label-only convenience grouping
 * modelled on the eight former provinces that Kenyan users still navigate by
 * ("Coast", "Rift Valley", …). It exists purely to keep a 47-item option list
 * usable on a phone. Nothing is stored, matched or authorised by it, and no code
 * may treat it as an administrative division.
 */

export interface KenyanCounty {
  /** ISO 3166-2:KE code, e.g. 'KE-47'. */
  code: string;
  /** Canonical county name used for storage and display. */
  name: string;
  /** The Constitution's own spelling, when it differs from `name`. */
  constitutionName?: string;
  /** UX-only grouping label (former province). Never an administrative unit. */
  uxGroup: UxGroup;
}

export type UxGroup =
  | 'Coast'
  | 'North Eastern'
  | 'Eastern'
  | 'Central'
  | 'Rift Valley'
  | 'Western'
  | 'Nyanza'
  | 'Nairobi';

/** The official county-level administrative units of Kenya — all 47. */
export const KENYA_COUNTIES: readonly KenyanCounty[] = [
  { code: 'KE-01', name: 'Mombasa', uxGroup: 'Coast' },
  { code: 'KE-02', name: 'Kwale', uxGroup: 'Coast' },
  { code: 'KE-03', name: 'Kilifi', uxGroup: 'Coast' },
  { code: 'KE-04', name: 'Tana River', uxGroup: 'Coast' },
  { code: 'KE-05', name: 'Lamu', uxGroup: 'Coast' },
  { code: 'KE-06', name: 'Taita-Taveta', constitutionName: 'Taita/Taveta', uxGroup: 'Coast' },
  { code: 'KE-07', name: 'Garissa', uxGroup: 'North Eastern' },
  { code: 'KE-08', name: 'Wajir', uxGroup: 'North Eastern' },
  { code: 'KE-09', name: 'Mandera', uxGroup: 'North Eastern' },
  { code: 'KE-10', name: 'Marsabit', uxGroup: 'Eastern' },
  { code: 'KE-11', name: 'Isiolo', uxGroup: 'Eastern' },
  { code: 'KE-12', name: 'Meru', uxGroup: 'Eastern' },
  { code: 'KE-13', name: 'Tharaka-Nithi', constitutionName: 'Tharaka Nithi', uxGroup: 'Eastern' },
  { code: 'KE-14', name: 'Embu', uxGroup: 'Eastern' },
  { code: 'KE-15', name: 'Kitui', uxGroup: 'Eastern' },
  { code: 'KE-16', name: 'Machakos', uxGroup: 'Eastern' },
  { code: 'KE-17', name: 'Makueni', uxGroup: 'Eastern' },
  { code: 'KE-18', name: 'Nyandarua', uxGroup: 'Central' },
  { code: 'KE-19', name: 'Nyeri', uxGroup: 'Central' },
  { code: 'KE-20', name: 'Kirinyaga', uxGroup: 'Central' },
  { code: 'KE-21', name: "Murang'a", uxGroup: 'Central' },
  { code: 'KE-22', name: 'Kiambu', uxGroup: 'Central' },
  { code: 'KE-23', name: 'Turkana', uxGroup: 'Rift Valley' },
  { code: 'KE-24', name: 'West Pokot', uxGroup: 'Rift Valley' },
  { code: 'KE-25', name: 'Samburu', uxGroup: 'Rift Valley' },
  { code: 'KE-26', name: 'Trans Nzoia', uxGroup: 'Rift Valley' },
  { code: 'KE-27', name: 'Uasin Gishu', uxGroup: 'Rift Valley' },
  { code: 'KE-28', name: 'Elgeyo-Marakwet', constitutionName: 'Elgeyo/Marakwet', uxGroup: 'Rift Valley' },
  { code: 'KE-29', name: 'Nandi', uxGroup: 'Rift Valley' },
  { code: 'KE-30', name: 'Baringo', uxGroup: 'Rift Valley' },
  { code: 'KE-31', name: 'Laikipia', uxGroup: 'Rift Valley' },
  { code: 'KE-32', name: 'Nakuru', uxGroup: 'Rift Valley' },
  { code: 'KE-33', name: 'Narok', uxGroup: 'Rift Valley' },
  { code: 'KE-34', name: 'Kajiado', uxGroup: 'Rift Valley' },
  { code: 'KE-35', name: 'Kericho', uxGroup: 'Rift Valley' },
  { code: 'KE-36', name: 'Bomet', uxGroup: 'Rift Valley' },
  { code: 'KE-37', name: 'Kakamega', uxGroup: 'Western' },
  { code: 'KE-38', name: 'Vihiga', uxGroup: 'Western' },
  { code: 'KE-39', name: 'Bungoma', uxGroup: 'Western' },
  { code: 'KE-40', name: 'Busia', uxGroup: 'Western' },
  { code: 'KE-41', name: 'Siaya', uxGroup: 'Nyanza' },
  { code: 'KE-42', name: 'Kisumu', uxGroup: 'Nyanza' },
  { code: 'KE-43', name: 'Homa Bay', uxGroup: 'Nyanza' },
  { code: 'KE-44', name: 'Migori', uxGroup: 'Nyanza' },
  { code: 'KE-45', name: 'Kisii', uxGroup: 'Nyanza' },
  { code: 'KE-46', name: 'Nyamira', uxGroup: 'Nyanza' },
  { code: 'KE-47', name: 'Nairobi City', uxGroup: 'Nairobi' },
] as const;

/** Canonical county names, in official numeric order. */
export const KENYA_COUNTY_NAMES: readonly string[] = KENYA_COUNTIES.map((c) => c.name);

/**
 * Spelling variants users actually type. Kept separate from the canonical list
 * so storage/display stays exact while search and de-duplication still work.
 */
export const KENYA_COUNTY_ALIASES: Readonly<Record<string, string>> = {
  'nairobi': 'Nairobi City',
  'nairobi city': 'Nairobi City',
  'taita taveta': 'Taita-Taveta',
  'elgeyo marakwet': 'Elgeyo-Marakwet',
  'tharaka nithi': 'Tharaka-Nithi',
  'muranga': "Murang'a",
  'homa bay': 'Homa Bay',
};

/**
 * Resolves a free-text county entry to its canonical name, or null when the
 * text does not name a Kenyan county. Case-tolerant; never "guesses" a
 * nearby county.
 */
export function resolveCountyName(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const needle = input.trim().toLowerCase().replace(/\./g, '');
  if (!needle) return null;
  for (const county of KENYA_COUNTIES) {
    if (county.name.toLowerCase() === needle) return county.name;
  }
  return KENYA_COUNTY_ALIASES[needle] ?? null;
}

/**
 * Counties grouped for display. Returned in `UX_GROUP_ORDER`; each group keeps
 * the official numeric order of its members.
 */
export function countiesByUxGroup(): Array<{ group: UxGroup; counties: KenyanCounty[] }> {
  return UX_GROUP_ORDER.map((group) => ({
    group,
    counties: KENYA_COUNTIES.filter((c) => c.uxGroup === group),
  })).filter((entry) => entry.counties.length > 0);
}

/** UX-only ordering of the eight grouping labels. Not an administrative list. */
export const UX_GROUP_ORDER: readonly UxGroup[] = [
  'Nairobi',
  'Central',
  'Coast',
  'Eastern',
  'North Eastern',
  'Nyanza',
  'Rift Valley',
  'Western',
] as const;

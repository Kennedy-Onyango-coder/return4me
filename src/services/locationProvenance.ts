// LOCATION PROVENANCE FOUNDATION (GEO-C)
// ======================================
// An explicit vocabulary for WHERE a location value came from. It exists so the
// application can reason about the reliability of the geography it holds WITHOUT
// inventing history and WITHOUT a database change in this batch.
//
// WHAT THIS IS NOT
//   * It is NOT a persistence layer. No column is added, no row is backfilled,
//     and no existing record is annotated. Existing production/legacy rows
//     remain exactly as they are — their origin is simply UNKNOWN, which is the
//     honest value, not a guess.
//   * It is NOT an authority signal. `browser_gps` and `reverse_geocoder` are
//     ADVISORY sources; only `user_selected` and `admin_corrected` represent a
//     human decision, and even those are still re-validated server-side against
//     the canonical county/unit configuration.
//
// PERSISTENCE DEFERRED TO A LATER PHASE (GEO-D+). If provenance is ever stored,
// that migration would add ONE text/enum column per geography-bearing table
// (reusing the existing coordinate/accuracy columns where a coordinate is kept):
//     items.location_source          (found-item flow)
//     lost_reports.location_source   (lost-item flow)
//     agents.location_source         (service area vs operational address)
// There is NO migration in GEO-C — this constant only NAMES what such a
// migration would need, so the names cannot drift.

export type LocationSource =
  | 'browser_gps'
  | 'reverse_geocoder'
  | 'user_selected'
  | 'admin_corrected'
  | 'forward_geocoder';

export const LOCATION_SOURCES: readonly LocationSource[] = [
  'browser_gps',
  'reverse_geocoder',
  'user_selected',
  'admin_corrected',
  'forward_geocoder',
] as const;

/**
 * Sources that are ADVISORY only: they may propose an area, but they never
 * prove a boundary. `user_selected` and `admin_corrected` are the only human
 * decisions and are still canonicalised + validated by the server.
 */
export const ADVISORY_LOCATION_SOURCES: readonly LocationSource[] = [
  'browser_gps',
  'reverse_geocoder',
  'forward_geocoder',
] as const;

/** Runtime guard for an untrusted provenance value. */
export function isLocationSource(value: unknown): value is LocationSource {
  return typeof value === 'string' && (LOCATION_SOURCES as readonly string[]).includes(value);
}

/** True when a source may only ever SUGGEST geography, never assert it. */
export function isAdvisoryLocationSource(value: LocationSource): boolean {
  return (ADVISORY_LOCATION_SOURCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// GEO-D+ — COORDINATE-SOURCE axis.
//
// `coordinate_source` answers a DIFFERENT question from `location_source`: not
// "how was the county/service geography chosen?" but "how was the stored
// latitude/longitude PAIR established?". It is deliberately a SEPARATE
// vocabulary because the two axes are not interchangeable — an Agent's service
// geography can be user-selected while its operational hub coordinate came from
// the browser, a forward geocoder, or an administrator's manual correction.
//
// The values below are exactly the three code paths that produce a stored
// coordinate today. There is deliberately no `reverse_geocoder` here: reverse
// geocoding is an ADVISORY UI suggestion and never itself establishes a stored
// coordinate pair. Do not add speculative values.
// ---------------------------------------------------------------------------

export type CoordinateSource = 'browser_gps' | 'forward_geocoder' | 'admin_corrected';

export const COORDINATE_SOURCES: readonly CoordinateSource[] = [
  'browser_gps',
  'forward_geocoder',
  'admin_corrected',
] as const;

/** Runtime guard for an untrusted coordinate-provenance value. */
export function isCoordinateSource(value: unknown): value is CoordinateSource {
  return typeof value === 'string' && (COORDINATE_SOURCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// GEO-D+ — the GEOGRAPHY-provenance subset that may be PERSISTED as an
// authoritative `location_source`. Today that is exactly `user_selected`: the
// canonical county/sub-county had to be explicitly chosen and then re-validated
// server-side. The ADVISORY sources (browser_gps, reverse_geocoder,
// forward_geocoder) may SUGGEST a location in the UI but must never be written
// into the authoritative geography column — a suggestion is not a decision.
// ---------------------------------------------------------------------------

export const AUTHORITATIVE_LOCATION_SOURCES: readonly LocationSource[] = ['user_selected'] as const;

/** Runtime guard for a value that may be persisted as authoritative geography. */
export function isAuthoritativeLocationSource(value: unknown): value is LocationSource {
  return typeof value === 'string' && (AUTHORITATIVE_LOCATION_SOURCES as readonly string[]).includes(value);
}

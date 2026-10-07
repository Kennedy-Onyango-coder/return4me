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

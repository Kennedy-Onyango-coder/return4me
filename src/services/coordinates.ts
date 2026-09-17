// COORDINATE VALIDATION (Phase 9D)
// ================================
// The ONE place that decides whether a latitude/longitude pair is usable.
//
// WHY THIS EXISTS
//   Before Phase 9D the only coordinate handling in this codebase was a bare
//   `parseFloat()` at the item-report route plus truthiness checks at the
//   persistence boundary. That combination had four defects the Phase 9D
//   forensic audit recorded (findings C1-C4), all of which are fixed here:
//
//     1. NO RANGE CHECK — `latitude: 5000` reached the database and could only
//        fail at the Postgres NUMERIC(9,6) boundary (a 500, not a controlled
//        rejection).
//     2. NO FINITENESS CHECK — `parseFloat('abc')` is NaN, which then flowed
//        into the Haversine comparison and into persistence.
//     3. ZERO TREATED AS ABSENT — `latitude ? ... : null` discarded a
//        legitimate coordinate of exactly 0 (the equator crosses Kenya).
//     4. LENIENT PARSING — `parseFloat('1.2921junk')` silently truncated to
//        1.2921 and was accepted as a real coordinate.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO — and this is the important part
//   It does NOT give a coordinate a MEANING. A validated pair is still only
//   "an optional numeric pair the caller supplied". Nothing here may be used
//   to assert that a point is where an item was found, where a person lives, or
//   which county it lies in.
//
//   The Phase 9D audit established that `items.latitude/longitude` semantics
//   are UNKNOWN (the UI describes them as the reporting device's position at
//   report time, used to route a drop-off to a nearby Agent hub; the code never
//   asserts they are the item's found location). Validation is therefore NOT
//   permission to reinterpret anything:
//     - coordinates are NEVER converted into a county;
//     - coordinates are NEVER used for lost/found matching (see
//       services/lostReportMatching.ts, which reads no coordinate at all);
//     - an existing stored value that is out of range or non-numeric is simply
//       reported as UNUSABLE by `isValidCoordinatePair()` — it is never
//       "corrected" into a different location.
//
// BOUNDS
//   Latitude  [-90, 90] and longitude [-180, 180] inclusive. Both fit the
//   existing `NUMERIC(9, 6)` storage (at most 3 integer digits, ~0.11 m
//   resolution), so no coordinate that passes here can overflow the column.

export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;

/** A real, finite number (rejects NaN, Infinity, -Infinity and non-numbers). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidLatitude(value: unknown): value is number {
  return isFiniteNumber(value) && value >= LATITUDE_MIN && value <= LATITUDE_MAX;
}

export function isValidLongitude(value: unknown): value is number {
  return isFiniteNumber(value) && value >= LONGITUDE_MIN && value <= LONGITUDE_MAX;
}

/**
 * True only when BOTH halves are present, finite and in range. A pair is never
 * partially accepted: half a coordinate is not a location, and storing one half
 * is exactly how a "position" claim gets invented.
 *
 * NOTE ON `0`: zero is a VALID coordinate and this function accepts it. The
 * previous truthiness checks did not — see the header.
 */
export function isValidCoordinatePair(latitude: unknown, longitude: unknown): boolean {
  return isValidLatitude(latitude) && isValidLongitude(longitude);
}

/**
 * STRICT numeric parse for a client-supplied coordinate.
 *
 * Accepts a real number, or a string that is ENTIRELY a decimal/scientific
 * number. Returns null for anything else, including trailing garbage — so
 * `'1.29junk'`, `'abc'`, `''`, `' '`, `NaN` and `Infinity` all become null
 * rather than a silently-truncated value (audit finding C4).
 *
 * Deliberately NOT used to "repair" stored historical values: it is an input
 * boundary only.
 */
export function parseCoordinateInput(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalizes an untrusted latitude/longitude INPUT PAIR into a validated pair,
 * or null when either half is unusable.
 *
 * Both halves must be supplied together. A missing/blank/invalid half yields
 * null for the whole pair, so no caller can accidentally persist a half
 * coordinate and later read it back as a position.
 */
export function normalizeCoordinateInput(
  latitude: unknown,
  longitude: unknown,
): { latitude: number; longitude: number } | null {
  const lat = parseCoordinateInput(latitude);
  const lon = parseCoordinateInput(longitude);
  if (lat === null || lon === null) return null;
  if (!isValidLatitude(lat) || !isValidLongitude(lon)) return null;
  return { latitude: lat, longitude: lon };
}

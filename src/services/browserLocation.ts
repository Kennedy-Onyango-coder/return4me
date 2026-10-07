// SHARED BROWSER LOCATION DETECTION (GEO-C)
// ========================================
// One GPS/reverse-geocoding contract reused by the Finder and Agent signup.
//
// INVARIANTS THIS MODULE HOLDS
//   * A detected result is a SUGGESTION. Detection never mutates a user's
//     selected geography — only an explicit user action may, and the server
//     still re-validates the county/sub-county pairing.
//   * A COORDINATE IS NOT A COUNTY. The reverse geocoder is advisory (see
//     services/geocoding/index.ts); its output is offered, never asserted as
//     proof of a boundary.
//   * The coordinate pair and the reported accuracy are VALIDATED here, and the
//     reading's age is recorded, so a caller can decide whether it is fresh
//     enough and whether it is precise enough to even suggest an area.
//   * Failure degrades to manual entry. A geocoder or network failure keeps the
//     coordinate and simply leaves the geography unresolved.

import { isValidLatitude, isValidLongitude } from './coordinates';
import { findAdministrativeUnitIdByName } from '../config/kenyaAdministrativeUnits';

export interface BrowserCoordinates {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

/**
 * Advisory confidence band derived from the browser's reported `accuracy`. It
 * is a statement about the READING, never about a boundary: even `strong`
 * does not prove a county or sub-county.
 */
export type LocationAccuracyTier = 'strong' | 'usable' | 'poor' | 'unknown';

export interface DetectedLocation extends BrowserCoordinates {
  county: string | null;
  subCountyId: string | null;
  place: string | null;
  /** Confidence band of the GPS reading (advisory only). */
  accuracyTier: LocationAccuracyTier;
  /** Epoch-ms the DEVICE reported the position, or the read time when absent. */
  capturedAt: number;
}

export type LocationDetectionFailure =
  | 'unsupported'
  | 'insecure_context'
  | 'permission_denied'
  | 'unavailable'
  | 'timeout'
  | 'invalid_coordinates'
  | 'low_accuracy'
  // Reserved. A reverse-geocoder FAILURE is deliberately NOT surfaced as an
  // error today: the coordinate is still captured and the geography suggestion
  // is simply absent (see the catch below), so a provider outage never breaks
  // manual entry. Kept in the union so a future hard-failure mode has a name.
  | 'reverse_geocoding';

export type LocationDetectionResult =
  | { status: 'detected'; location: DetectedLocation }
  | { status: 'error'; reason: LocationDetectionFailure; message: string };

/**
 * Named accuracy thresholds, in metres. Conservative on purpose.
 *
 *   DETECT_REJECT      — above this the reading is not offered as geography at
 *                        all (the caller may still override via
 *                        `acceptLowAccuracy`). 5 km is roughly the width of a
 *                        Nairobi sub-county, so anything coarser cannot even
 *                        narrow a sub-county choice honestly.
 *   PREFILL_ACCEPT     — at or below this a detected AREA may be offered as an
 *                        advisory prefill the user confirms. 2 km is a walkable
 *                        neighbourhood.
 *   PREFILL_CONFIDENCE — at or below this the reading is treated as `strong`.
 *                        300 m is a normal urban GPS fix.
 *
 * These gate PRESENTATION ONLY. None of them turns a coordinate into an
 * authoritative county or sub-county.
 */
export const LOCATION_ACCURACY_METRES = {
  DETECT_REJECT: 5_000,
  PREFILL_ACCEPT: 2_000,
  PREFILL_CONFIDENCE: 300,
} as const;

/** Classifies a reported accuracy into an advisory tier. */
export function classifyLocationAccuracyTier(accuracy: number | null | undefined): LocationAccuracyTier {
  if (accuracy === null || accuracy === undefined || !Number.isFinite(accuracy)) return 'unknown';
  if (accuracy <= LOCATION_ACCURACY_METRES.PREFILL_CONFIDENCE) return 'strong';
  if (accuracy <= LOCATION_ACCURACY_METRES.PREFILL_ACCEPT) return 'usable';
  return 'poor';
}

/**
 * True when an EXPLICIT user selection and a GPS/geocoder suggestion name
 * different counties. Callers must surface this rather than silently replace
 * one with the other.
 */
export function hasGeographyConflict(
  selectedCounty: string | null | undefined,
  detectedCounty: string | null | undefined,
): boolean {
  return Boolean(selectedCounty && detectedCounty && selectedCounty !== detectedCounty);
}

export function detectBrowserLocation(options?: { acceptLowAccuracy?: boolean }): Promise<LocationDetectionResult> {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return Promise.resolve({ status: 'error', reason: 'insecure_context', message: 'Location is only available on a secure HTTPS connection. You can continue by entering your location manually.' });
  }
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve({ status: 'error', reason: 'unsupported', message: 'Location is not supported by this browser.' });
  }
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(async position => {
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;

      // (1) VALIDATE THE COORDINATE PAIR. A browser value that is non-finite or
      // out of range is not a location and is never passed on. This reuses the
      // one shared validator (services/coordinates.ts); it does NOT give the
      // pair any meaning — a coordinate is still just a coordinate.
      if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
        resolve({ status: 'error', reason: 'invalid_coordinates', message: 'We could not read a usable position from your device. You can continue by entering your location manually.' });
        return;
      }

      // (2) VALIDATE ACCURACY. A non-finite or negative accuracy is treated as
      // "not reported" (null) rather than trusted — never as a precise reading.
      const rawAccuracy = position.coords.accuracy;
      const accuracy = Number.isFinite(rawAccuracy) && rawAccuracy >= 0 ? rawAccuracy : null;
      const accuracyTier = classifyLocationAccuracyTier(accuracy);
      const capturedAt = typeof position.timestamp === 'number' && Number.isFinite(position.timestamp) ? position.timestamp : Date.now();

      // (3) VERY POOR ACCURACY: do not offer geography. The caller can still
      // opt in with `acceptLowAccuracy` when it wants the coordinates anyway.
      if (!options?.acceptLowAccuracy && accuracy !== null && accuracy > LOCATION_ACCURACY_METRES.DETECT_REJECT) {
        resolve({ status: 'error', reason: 'low_accuracy', message: `Location accuracy is approximately ${Math.round(accuracy)} metres. Enter your location manually or try again outdoors.` });
        return;
      }

      // A coordinate-only reading: no geography suggestion. Used both when the
      // reverse geocoder is unavailable and when it simply found nothing.
      const coordinateOnly = (): DetectedLocation => ({ latitude, longitude, accuracy, county: null, subCountyId: null, place: null, accuracyTier, capturedAt });

      try {
        const response = await fetch('/api/location/reverse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ latitude, longitude }) });
        // Provider/route failure degrades GRACEFULLY: the coordinate is kept and
        // the geography stays unresolved — manual entry is never broken.
        if (!response.ok) {
          resolve({ status: 'detected', location: coordinateOnly() });
          return;
        }
        const data = await response.json();
        const county = typeof data.countyCandidate === 'string' ? data.countyCandidate : null;
        const subCountyName = typeof data.subCountyCandidate === 'string' ? data.subCountyCandidate : null;
        resolve({ status: 'detected', location: {
          latitude,
          longitude,
          accuracy,
          // The geocoder's suggestion is ADVISORY. It is mapped onto the existing
          // 312-unit vocabulary (never a new list) and is offered to the user,
          // never written as though the coordinate proved the sub-county.
          county,
          subCountyId: county && subCountyName ? findAdministrativeUnitIdByName(county, subCountyName) : null,
          place: typeof data.displayName === 'string' && data.displayName.trim() ? data.displayName.trim() : null,
          accuracyTier,
          capturedAt,
        } });
      } catch {
        resolve({ status: 'detected', location: coordinateOnly() });
      }
    }, error => {
      const reason: LocationDetectionFailure = error.code === 1 ? 'permission_denied' : error.code === 3 ? 'timeout' : 'unavailable';
      resolve({ status: 'error', reason, message: reason === 'permission_denied' ? 'Location permission was denied. You can continue by entering your location manually.' : reason === 'timeout' ? 'Location detection timed out. You can continue manually.' : 'Your current location is unavailable. You can continue manually.' });
    }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 });
  });
}

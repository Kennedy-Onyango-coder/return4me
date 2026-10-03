// SHARED BROWSER LOCATION DETECTION
// One GPS/reverse-geocoding contract reused by Finder and Agent signup. A detected
// result is a suggestion, never an automatic mutation of user-selected geography.

import { findAdministrativeUnitIdByName } from '../config/kenyaAdministrativeUnits';

export interface BrowserCoordinates {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

export interface DetectedLocation extends BrowserCoordinates {
  county: string | null;
  subCountyId: string | null;
  place: string | null;
}

export type LocationDetectionFailure = 'unsupported' | 'insecure_context' | 'permission_denied' | 'unavailable' | 'timeout' | 'low_accuracy' | 'reverse_geocoding';

export type LocationDetectionResult =
  | { status: 'detected'; location: DetectedLocation }
  | { status: 'error'; reason: LocationDetectionFailure; message: string };

const LOW_ACCURACY_METRES = 5_000;

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
      const accuracy = Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null;
      if (!options?.acceptLowAccuracy && accuracy !== null && accuracy > LOW_ACCURACY_METRES) {
        resolve({ status: 'error', reason: 'low_accuracy', message: `Location accuracy is approximately ${Math.round(accuracy)} metres. Enter your location manually or try again outdoors.` });
        return;
      }
      try {
        const response = await fetch('/api/location/reverse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ latitude, longitude }) });
        if (!response.ok) {
          resolve({ status: 'detected', location: { latitude, longitude, accuracy, county: null, subCountyId: null, place: null } });
          return;
        }
        const data = await response.json();
        const county = typeof data.countyCandidate === 'string' ? data.countyCandidate : null;
        const subCountyName = typeof data.subCountyCandidate === 'string' ? data.subCountyCandidate : null;
        resolve({ status: 'detected', location: { latitude, longitude, accuracy, county, subCountyId: county && subCountyName ? findAdministrativeUnitIdByName(county, subCountyName) : null, place: typeof data.displayName === 'string' && data.displayName.trim() ? data.displayName.trim() : null } });
      } catch {
        resolve({ status: 'detected', location: { latitude, longitude, accuracy, county: null, subCountyId: null, place: null } });
      }
    }, error => {
      const reason: LocationDetectionFailure = error.code === 1 ? 'permission_denied' : error.code === 3 ? 'timeout' : 'unavailable';
      resolve({ status: 'error', reason, message: reason === 'permission_denied' ? 'Location permission was denied. You can continue by entering your location manually.' : reason === 'timeout' ? 'Location detection timed out. You can continue manually.' : 'Your current location is unavailable. You can continue manually.' });
    }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 });
  });
}

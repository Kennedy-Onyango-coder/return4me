import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectBrowserLocation,
  classifyLocationAccuracyTier,
  hasGeographyConflict,
  LOCATION_ACCURACY_METRES,
} from '../browserLocation';
import {
  findAdministrativeUnitIdByName,
  resolveAdministrativeUnitAlias,
  resolveAdministrativeUnitId,
} from '../../config/kenyaAdministrativeUnits';

// =============================================================================
// GEO-C — the shared browser location CONTRACT (services/browserLocation.ts).
//
// This module is the ONE place a browser coordinate is read. It runs in a
// browser, so the suite installs a minimal `window`/`navigator`/`fetch` stub and
// NEVER touches a real device, network or geocoder.
//
// The tests cover the behaviours the GEO-C brief lists (A–O), grouped here by
// the module they exercise; the source/DTO assertions for K–O live in
// __tests__/geoCLocationFoundation.test.ts.
// =============================================================================

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Installs a secure-context `window` and a `navigator.geolocation` stub. */
function stubGeolocation(impl: (success: any, error: any, options: any) => void) {
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: impl } });
}

function stubGeolocationSuccess(coords: { latitude: number; longitude: number; accuracy: number; timestamp?: number }) {
  stubGeolocation((success: any) => success({ coords, timestamp: coords.timestamp ?? Date.now() }));
}

function stubGeolocationError(code: number) {
  stubGeolocation((_success: any, error: any) => error({ code }));
}

function stubGeocoder(payload: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => payload })));
}

describe('GEO-C accuracy model — named thresholds (no scattered magic numbers)', () => {
  it('exposes the three named thresholds', () => {
    expect(LOCATION_ACCURACY_METRES).toEqual({
      DETECT_REJECT: 5_000,
      PREFILL_ACCEPT: 2_000,
      PREFILL_CONFIDENCE: 300,
    });
  });

  it('classifies a reported accuracy into an advisory tier', () => {
    expect(classifyLocationAccuracyTier(50)).toBe('strong');
    expect(classifyLocationAccuracyTier(300)).toBe('strong');
    expect(classifyLocationAccuracyTier(301)).toBe('usable');
    expect(classifyLocationAccuracyTier(2_000)).toBe('usable');
    expect(classifyLocationAccuracyTier(2_001)).toBe('poor');
    expect(classifyLocationAccuracyTier(5_000)).toBe('poor');
  });

  it('treats a missing or non-finite accuracy as unknown, never precise', () => {
    expect(classifyLocationAccuracyTier(null)).toBe('unknown');
    expect(classifyLocationAccuracyTier(undefined)).toBe('unknown');
    expect(classifyLocationAccuracyTier(NaN)).toBe('unknown');
    expect(classifyLocationAccuracyTier(Infinity)).toBe('unknown');
  });
});

describe('GEO-C conflict helper — an explicit selection is never silently replaced', () => {
  it('flags only a genuine disagreement between two named counties', () => {
    expect(hasGeographyConflict('Mombasa', 'Nairobi City')).toBe(true);
    expect(hasGeographyConflict('Nairobi City', 'Nairobi City')).toBe(false);
    expect(hasGeographyConflict('', 'Nairobi City')).toBe(false);
    expect(hasGeographyConflict(null, 'Nairobi City')).toBe(false);
    expect(hasGeographyConflict(undefined, 'Nairobi City')).toBe(false);
    expect(hasGeographyConflict('Nairobi City', null)).toBe(false);
  });
});

describe('GEO-C detectBrowserLocation — environment and failure modes', () => {
  it('F: reports a denied permission', async () => {
    stubGeolocationError(1);
    const result = await detectBrowserLocation();
    expect(result).toMatchObject({ status: 'error', reason: 'permission_denied' });
  });

  it('G: reports an unavailable position', async () => {
    stubGeolocationError(2);
    const result = await detectBrowserLocation();
    expect(result).toMatchObject({ status: 'error', reason: 'unavailable' });
  });

  it('H: reports a timeout', async () => {
    stubGeolocationError(3);
    const result = await detectBrowserLocation();
    expect(result).toMatchObject({ status: 'error', reason: 'timeout' });
  });

  it('reports an unsupported browser', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', {});
    const result = await detectBrowserLocation();
    expect(result).toMatchObject({ status: 'error', reason: 'unsupported' });
  });

  it('refuses to read location on an insecure context', async () => {
    vi.stubGlobal('window', { isSecureContext: false });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: () => { throw new Error('must not be called'); } } });
    const result = await detectBrowserLocation();
    expect(result).toMatchObject({ status: 'error', reason: 'insecure_context' });
  });
});

describe('GEO-C detectBrowserLocation — coordinate + accuracy validation', () => {
  it('A: accepts a valid pair and records accuracy, tier and capture time', async () => {
    stubGeolocationSuccess({ latitude: -1.2921, longitude: 36.8219, accuracy: 40, timestamp: 1_700_000_000_000 });
    stubGeocoder({ countyCandidate: 'Nairobi City', subCountyCandidate: 'Westlands', displayName: 'Westlands, Nairobi' });
    const result = await detectBrowserLocation();
    expect(result.status).toBe('detected');
    if (result.status !== 'detected') return;
    expect(result.location.latitude).toBeCloseTo(-1.2921, 4);
    expect(result.location.longitude).toBeCloseTo(36.8219, 4);
    expect(result.location.accuracy).toBe(40);
    expect(result.location.accuracyTier).toBe('strong');
    expect(result.location.capturedAt).toBe(1_700_000_000_000);
  });

  it('B: rejects an out-of-range latitude', async () => {
    stubGeolocationSuccess({ latitude: 200, longitude: 36.8219, accuracy: 40 });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await detectBrowserLocation();
    expect(result).toMatchObject({ status: 'error', reason: 'invalid_coordinates' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('C: rejects an out-of-range longitude', async () => {
    stubGeolocationSuccess({ latitude: -1.2921, longitude: 500, accuracy: 40 });
    const result = await detectBrowserLocation();
    expect(result).toMatchObject({ status: 'error', reason: 'invalid_coordinates' });
  });

  it('rejects a non-finite coordinate', async () => {
    stubGeolocationSuccess({ latitude: NaN, longitude: 36.8219, accuracy: 40 });
    const result = await detectBrowserLocation();
    expect(result).toMatchObject({ status: 'error', reason: 'invalid_coordinates' });
  });

  it('D: treats a non-finite or negative accuracy as unknown, not as precise', async () => {
    stubGeolocationSuccess({ latitude: -1.2921, longitude: 36.8219, accuracy: NaN });
    stubGeocoder({ countyCandidate: null, subCountyCandidate: null, displayName: null });
    const nan = await detectBrowserLocation();
    expect(nan.status).toBe('detected');
    if (nan.status === 'detected') {
      expect(nan.location.accuracy).toBeNull();
      expect(nan.location.accuracyTier).toBe('unknown');
    }

    stubGeolocationSuccess({ latitude: -1.2921, longitude: 36.8219, accuracy: -5 });
    const negative = await detectBrowserLocation();
    expect(negative.status).toBe('detected');
    if (negative.status === 'detected') {
      expect(negative.location.accuracy).toBeNull();
      expect(negative.location.accuracyTier).toBe('unknown');
    }
  });
});

describe('GEO-C detectBrowserLocation — accuracy gating', () => {
  it('E: refuses geography above the reject threshold', async () => {
    stubGeolocationSuccess({ latitude: -1.2921, longitude: 36.8219, accuracy: 8_000 });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await detectBrowserLocation();
    expect(result).toMatchObject({ status: 'error', reason: 'low_accuracy' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('E: keeps a coarse-but-usable reading and marks it poor', async () => {
    stubGeolocationSuccess({ latitude: -1.2921, longitude: 36.8219, accuracy: 3_000 });
    stubGeocoder({ countyCandidate: null, subCountyCandidate: null, displayName: null });
    const result = await detectBrowserLocation();
    expect(result.status).toBe('detected');
    if (result.status === 'detected') expect(result.location.accuracyTier).toBe('poor');
  });

  it('E: may still capture coordinates when the caller opts into low accuracy', async () => {
    stubGeolocationSuccess({ latitude: -1.2921, longitude: 36.8219, accuracy: 9_000 });
    stubGeocoder({ countyCandidate: null, subCountyCandidate: null, displayName: null });
    const result = await detectBrowserLocation({ acceptLowAccuracy: true });
    expect(result.status).toBe('detected');
    if (result.status === 'detected') {
      expect(result.location.accuracy).toBe(9_000);
      expect(result.location.accuracyTier).toBe('poor');
    }
  });
});

describe('GEO-C detectBrowserLocation — geocoder role', () => {
  it('J: offers the geocoder result as an advisory suggestion mapped onto the 312-unit vocabulary', async () => {
    stubGeolocationSuccess({ latitude: -1.2921, longitude: 36.8219, accuracy: 20 });
    stubGeocoder({ countyCandidate: 'Nairobi City', subCountyCandidate: 'Westlands', displayName: 'Westlands, Nairobi' });
    const result = await detectBrowserLocation();
    expect(result.status).toBe('detected');
    if (result.status !== 'detected') return;
    expect(result.location.county).toBe('Nairobi City');
    expect(result.location.subCountyId).toBe(findAdministrativeUnitIdByName('Nairobi City', 'Westlands'));
    expect(result.location.place).toBe('Westlands, Nairobi');
  });

  it('I: a reverse-geocoder failure degrades to a coordinate-only result, never an error', async () => {
    stubGeolocationSuccess({ latitude: -1.2921, longitude: 36.8219, accuracy: 20 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await detectBrowserLocation();
    expect(result.status).toBe('detected');
    if (result.status === 'detected') {
      expect(result.location.latitude).toBeCloseTo(-1.2921, 4);
      expect(result.location.county).toBeNull();
      expect(result.location.subCountyId).toBeNull();
    }
  });

  it('I: a non-OK geocoder response also degrades to coordinate-only', async () => {
    stubGeolocationSuccess({ latitude: -1.2921, longitude: 36.8219, accuracy: 20 });
    stubGeocoder({}, false);
    const result = await detectBrowserLocation();
    expect(result.status).toBe('detected');
    if (result.status === 'detected') expect(result.location.county).toBeNull();
  });

  it('never turns a geocoder name into a unit from a DIFFERENT county (L)', async () => {
    // 'Mombasa' county with the Nairobi 'Westlands' name must NOT resolve.
    stubGeolocationSuccess({ latitude: -4.0435, longitude: 39.6682, accuracy: 20 });
    stubGeocoder({ countyCandidate: 'Mombasa', subCountyCandidate: 'Westlands', displayName: 'Westlands' });
    const result = await detectBrowserLocation();
    expect(result.status).toBe('detected');
    if (result.status === 'detected') {
      expect(result.location.county).toBe('Mombasa');
      expect(result.location.subCountyId).toBeNull();
    }
  });
});

describe('GEO-C geography relationships used by the location path (L, M)', () => {
  it('L: a unit belongs to exactly one county', () => {
    expect(resolveAdministrativeUnitId('Nairobi City', 'KE-47-SC-01')).toBe('KE-47-SC-01');
    expect(resolveAdministrativeUnitId('Mombasa', 'KE-47-SC-01')).toBeNull();
    expect(findAdministrativeUnitIdByName('Nairobi City', 'Westlands')).toBe('KE-47-SC-01');
    expect(findAdministrativeUnitIdByName('Mombasa', 'Westlands')).toBeNull();
  });

  it('M: resolves the four GEO-B county-aware aliases without changing the id', () => {
    expect(resolveAdministrativeUnitAlias('KE-20', 'Ndidia')?.id).toBe('KE-20-SC-04');
    expect(resolveAdministrativeUnitAlias('KE-21', 'Kahuro')?.id).toBe('KE-21-SC-03');
    expect(resolveAdministrativeUnitAlias('KE-35', 'Soin Sigowet')?.id).toBe('KE-35-SC-05');
    expect(resolveAdministrativeUnitAlias('KE-44', 'Suna South')?.id).toBe('KE-44-SC-03');
    // County-aware: a Kiambu alias must not resolve for a Mombasa county identity.
    expect(resolveAdministrativeUnitAlias('KE-01', 'Kahuro')).toBeNull();
  });
});



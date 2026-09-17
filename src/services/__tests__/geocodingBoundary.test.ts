import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  geocodeForward,
  readGeocodingConfig,
  isGeocodingEnabled,
  resolveProvider,
  resetGeocodingRuntime,
  createNominatimProvider,
} from '../geocoding/index';
import { BoundedTtlCache, RequestThrottle, normalizeGeocodingKey } from '../geocoding/cache';

// ---------------------------------------------------------------------------
// PHASE 9D — the provider-neutral geocoding boundary.
//
// THESE TESTS NEVER TOUCH THE NETWORK. Every provider interaction is a mocked
// global `fetch`. The suite must pass on a machine with no internet connection
// and must never contact the real Nominatim instance (see the Phase 9D brief,
// §39) — the point of this phase is boundary hardening, not provider
// validation.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'GEOCODING_PROVIDER',
  'GEOCODING_ENDPOINT',
  'GEOCODING_TIMEOUT_MS',
  'GEOCODING_CACHE_TTL_MS',
  'GEOCODING_CACHE_MAX_ENTRIES',
  'GEOCODING_MIN_INTERVAL_MS',
  'GEOCODING_USER_AGENT',
];

// Preserve whatever the environment already had so this suite leaves no trace.
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

/**
 * Sets the geocoding environment for one test.
 *
 * `GEOCODING_MIN_INTERVAL_MS` defaults to 1 here purely so the suite does not
 * spend a second per outbound call; the DEFAULT (1100 ms) is asserted
 * separately from `readGeocodingConfig`, so this does not mask the production
 * value.
 */
function setGeocodingEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GEOCODING_MIN_INTERVAL_MS = '1';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

/** A fetch stub that returns a clean single-result Nominatim-shaped payload. */
function okFetch(lat = '-1.2921', lon = '36.8219') {
  // The parameters are declared (even though the stub ignores them) so
  // TypeScript types `mock.calls` as a real argument tuple. With a zero-arg
  // mock it infers `calls: []`, which makes `mock.calls[0][0]` a TS2493 error.
  // Type-only: the signature changes nothing at runtime.
  return vi.fn(async (_url: string, _init?: any) => ({ ok: true, status: 200, json: async () => [{ lat, lon }] }));
}

beforeEach(() => {
  setGeocodingEnv();
  resetGeocodingRuntime();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreEnv();
  resetGeocodingRuntime();
});

// ---------------------------------------------------------------------------
// CACHE-KEY NORMALIZATION
// ---------------------------------------------------------------------------
describe('cache keys are deterministic and do not rewrite user input', () => {
  it('collapses case, punctuation and whitespace to one key', () => {
    expect(normalizeGeocodingKey('Nairobi  CBD.')).toBe('nairobi cbd');
    expect(normalizeGeocodingKey('nairobi cbd')).toBe('nairobi cbd');
    expect(normalizeGeocodingKey('  NAIROBI CBD  ')).toBe('nairobi cbd');
  });

  it('returns an empty key for non-strings and blank input', () => {
    expect(normalizeGeocodingKey('')).toBe('');
    expect(normalizeGeocodingKey('   ')).toBe('');
    expect(normalizeGeocodingKey(null as any)).toBe('');
  });

  it('never MUTATES the value it is given', () => {
    const original = 'Near Yaya Centre, Kilimani';
    normalizeGeocodingKey(original);
    expect(original).toBe('Near Yaya Centre, Kilimani');
  });
});

// ---------------------------------------------------------------------------
// BOUNDED TTL CACHE
// ---------------------------------------------------------------------------
describe('BoundedTtlCache', () => {
  it('stores and returns a value before its TTL elapses', () => {
    let now = 1_000;
    const cache = new BoundedTtlCache<string>({ maxEntries: 10, ttlMs: 100, now: () => now });
    cache.set('k', 'v');
    now = 1_099;
    expect(cache.get('k')).toBe('v');
  });

  it('expires an entry once its TTL has passed', () => {
    let now = 1_000;
    const cache = new BoundedTtlCache<string>({ maxEntries: 10, ttlMs: 100, now: () => now });
    cache.set('k', 'v');
    now = 1_100; // exactly at expiry
    expect(cache.get('k')).toBeUndefined();
  });

  it('NEVER grows past maxEntries, and evicts the OLDEST entry first', () => {
    const cache = new BoundedTtlCache<number>({ maxEntries: 3, ttlMs: 10_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4); // should push 'a' out

    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('d')).toBe(4);
  });

  it('treats a re-set key as the most recently used', () => {
    const cache = new BoundedTtlCache<number>({ maxEntries: 2, ttlMs: 10_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 11); // refresh 'a' -> 'b' is now the oldest
    cache.set('c', 3);  // should evict 'b'
    expect(cache.get('a')).toBe(11);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('clear() empties the cache', () => {
    const cache = new BoundedTtlCache<number>({ maxEntries: 5, ttlMs: 10_000 });
    cache.set('a', 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// REQUEST THROTTLE
// ---------------------------------------------------------------------------
describe('RequestThrottle spaces outbound requests and cannot be bypassed', () => {
  it('lets the FIRST request through immediately', async () => {
    const slept: number[] = [];
    const throttle = new RequestThrottle({
      minIntervalMs: 1000,
      now: () => 0,
      sleep: async (ms) => { slept.push(ms); },
    });
    await throttle.acquire();
    expect(slept).toEqual([]);
  });

  it('makes a second request wait for the remainder of the interval', async () => {
    const slept: number[] = [];
    let now = 0;
    const throttle = new RequestThrottle({
      minIntervalMs: 1000,
      now: () => now,
      sleep: async (ms) => { slept.push(ms); now += ms; },
    });
    await throttle.acquire();
    now = 400; // only 400ms have actually passed
    await throttle.acquire();
    expect(slept).toEqual([600]);
  });

  it('SERIALIZES concurrent callers so they cannot collectively bypass the cap', async () => {
    // A naive "was the last request recent?" check would let all five callers
    // read the same stale timestamp and fire at once. The serialized queue must
    // instead enforce one slot per interval.
    const starts: number[] = [];
    let now = 0;
    const throttle = new RequestThrottle({
      minIntervalMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    await Promise.all(
      [1, 2, 3, 4, 5].map(() => throttle.acquire().then(() => { starts.push(now); })),
    );
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(100);
    }
  });

  it('keeps working after a ticket is rejected (no deadlock)', async () => {
    const throttle = new RequestThrottle({ minIntervalMs: 0, now: () => 0, sleep: async () => {} });
    await throttle.acquire();
    await expect(throttle.acquire()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------
describe('geocoding configuration', () => {
  it('is ENABLED by default, with conservative bounds', () => {
    // Clear the suite's fast-throttle default so the PRODUCTION default shows.
    setGeocodingEnv({ GEOCODING_MIN_INTERVAL_MS: undefined });
    const config = readGeocodingConfig(process.env);
    expect(config.enabled).toBe(true);
    expect(config.provider).toBe('nominatim');
    expect(config.endpoint).toContain('nominatim');
    expect(config.timeoutMs).toBe(2500);
    expect(config.cacheTtlMs).toBe(24 * 60 * 60 * 1000);
    expect(config.cacheMaxEntries).toBe(500);
    expect(config.minIntervalMs).toBe(1100); // the provider's 1 req/s cap
  });

  it('DISABLES the provider for the documented off-switch values', () => {
    for (const value of ['none', 'off', 'disabled', 'false', '', ' NONE ']) {
      process.env.GEOCODING_PROVIDER = value;
      expect(isGeocodingEnabled(process.env), `value=${JSON.stringify(value)}`).toBe(false);
      expect(resolveProvider(readGeocodingConfig(process.env))).toBeNull();
    }
  });

  it('treats an UNKNOWN provider name as no provider at all', () => {
    // A typo must not silently fall back to a live provider someone meant to
    // switch off.
    process.env.GEOCODING_PROVIDER = 'mapbox';
    expect(resolveProvider(readGeocodingConfig(process.env))).toBeNull();
  });

  it('accepts a CONFIGURED endpoint, timeout and bounds', () => {
    process.env.GEOCODING_ENDPOINT = 'https://geo.example.test/search';
    process.env.GEOCODING_TIMEOUT_MS = '750';
    process.env.GEOCODING_CACHE_TTL_MS = '60000';
    process.env.GEOCODING_CACHE_MAX_ENTRIES = '25';
    process.env.GEOCODING_MIN_INTERVAL_MS = '250';
    const config = readGeocodingConfig(process.env);
    expect(config.endpoint).toBe('https://geo.example.test/search');
    expect(config.timeoutMs).toBe(750);
    expect(config.cacheTtlMs).toBe(60_000);
    expect(config.cacheMaxEntries).toBe(25);
    expect(config.minIntervalMs).toBe(250);
  });

  it('falls back to the default for a nonsensical numeric setting', () => {
    process.env.GEOCODING_TIMEOUT_MS = 'not-a-number';
    expect(readGeocodingConfig(process.env).timeoutMs).toBe(2500);
    process.env.GEOCODING_TIMEOUT_MS = '-5';
    expect(readGeocodingConfig(process.env).timeoutMs).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// geocodeForward — PROVIDER DISABLED
// ---------------------------------------------------------------------------
describe('provider disabled means NO outbound request, ever', () => {
  it('returns a controlled "disabled" outcome and never calls fetch', async () => {
    setGeocodingEnv({ GEOCODING_PROVIDER: 'none' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await geocodeForward('Nairobi CBD');

    expect(outcome).toEqual({ status: 'unavailable', reason: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still refuses (rather than calls out) for a blank query', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await geocodeForward('   ');

    expect(outcome).toEqual({ status: 'unavailable', reason: 'empty_query' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// geocodeForward — SUCCESS
// ---------------------------------------------------------------------------
describe('a successful provider response', () => {
  it('returns a validated coordinate pair from the provider', async () => {
    const fetchMock = okFetch('-1.2921', '36.8219');
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await geocodeForward('Nairobi CBD');

    expect(outcome).toEqual({ status: 'ok', latitude: -1.2921, longitude: 36.8219, source: 'provider' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends only the normalized place query — no identity, contact or claim data', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await geocodeForward('Near Yaya Centre, Kilimani');

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    // encodeURIComponent encodes spaces as %20 (not '+').
    expect(calledUrl).toContain('near%20yaya%20centre%20kilimani');
    // The request carries NO other application data of any kind.
    expect(calledUrl).not.toMatch(/phone|email|customer|claim|payment|token|hash|document/i);
    const init = fetchMock.mock.calls[0][1] as any;
    expect(Object.keys(init.headers).sort()).toEqual(['Accept', 'User-Agent']);
  });

  it('honours a CONFIGURED endpoint instead of a hard-coded one', async () => {
    setGeocodingEnv({ GEOCODING_ENDPOINT: 'https://geo.example.test/search' });
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await geocodeForward('Westlands');

    expect(String(fetchMock.mock.calls[0][0])).toContain('https://geo.example.test/search');
  });

  it('accepts a provider result of exactly 0 (not treated as absent)', async () => {
    const fetchMock = okFetch('0', '36.8219');
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await geocodeForward('Somewhere on the equator');

    expect(outcome).toEqual({ status: 'ok', latitude: 0, longitude: 36.8219, source: 'provider' });
  });
});

// ---------------------------------------------------------------------------
// geocodeForward — CACHE
// ---------------------------------------------------------------------------
describe('caching', () => {
  it('serves an identical (normalized) lookup from cache without a second call', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const first = await geocodeForward('Nairobi CBD');
    const second = await geocodeForward('  nairobi   cbd.  ');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ source: 'provider' });
    expect(second).toMatchObject({ status: 'ok', source: 'cache' });
  });

  it('does NOT cache a failure (a transient outage must not be frozen for the TTL)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, json: async () => [] }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await geocodeForward('Westlands');
    const second = await geocodeForward('Westlands');

    expect(first).toEqual({ status: 'unavailable', reason: 'provider_error' });
    expect(second).toEqual({ status: 'unavailable', reason: 'provider_error' });
    // Two real attempts — the first failure was not remembered as a result.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-consults the provider after the cache TTL has elapsed', async () => {
    setGeocodingEnv({ GEOCODING_CACHE_TTL_MS: '1' });
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await geocodeForward('Westlands');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await geocodeForward('Westlands');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// geocodeForward — IN-FLIGHT DEDUPLICATION
// ---------------------------------------------------------------------------
describe('in-flight deduplication', () => {
  it('makes ONE provider request for concurrent identical lookups', async () => {
    // The provider is deliberately SLOW here, so all three callers are in
    // flight at the same moment — which is the only situation in which
    // deduplication can be observed at all.
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, status: 200, json: async () => [{ lat: '-1.29', lon: '36.82' }] };
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b, c] = await Promise.all([
      geocodeForward('Nairobi CBD'),
      geocodeForward('nairobi  cbd'),
      geocodeForward('Nairobi CBD.'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ status: 'ok' });
    expect(b).toMatchObject({ status: 'ok' });
    expect(c).toMatchObject({ status: 'ok' });
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('clears the in-flight entry after a FAILURE, so a retry can run', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', fetchMock);

    await geocodeForward('Westlands');
    await geocodeForward('Westlands');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// geocodeForward — CONTROLLED FAILURE
//
// Every one of these must return a value, never throw, and never leave the
// caller unable to continue. This is the property that makes geocoding
// optional infrastructure rather than a single point of failure for item
// reporting and agent application.
// ---------------------------------------------------------------------------
describe('provider failures are contained and never throw', () => {
  it('HTTP failure -> provider_error (not "no result")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => [] })));
    await expect(geocodeForward('Westlands')).resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
  });

  it('transport failure -> provider_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(geocodeForward('Westlands')).resolves.toEqual({ status: 'unavailable', reason: 'provider_error' });
  });

  it('an EMPTY result set -> no_result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })));
    await expect(geocodeForward('Nowhere At All')).resolves.toEqual({ status: 'unavailable', reason: 'no_result' });
  });

  it('a MALFORMED payload -> a controlled outcome, never a throw', async () => {
    for (const payload of [{}, { error: 'nope' }, [null], [{ lat: 'abc', lon: '36.8' }], [{ lat: null, lon: null }]]) {
      resetGeocodingRuntime();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
      const outcome = await geocodeForward(`malformed-${JSON.stringify(payload)}`);
      expect(outcome.status, JSON.stringify(payload)).toBe('unavailable');
    }
  });

  it('unparseable JSON -> a controlled outcome', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })));
    await expect(geocodeForward('Westlands')).resolves.toEqual({ status: 'unavailable', reason: 'no_result' });
  });

  it('does NOT turn a NULL/EMPTY provider coordinate into a valid 0,0 point', async () => {
    // Regression for a subtle real bug: `Number(null)` and `Number('')` are both
    // 0, so a naive conversion reads a provider that returned NOTHING as the
    // perfectly valid coordinate 0,0 — inventing a location in the Gulf of
    // Guinea. The strict parser must reject these instead.
    for (const payload of [[{ lat: null, lon: null }], [{ lat: '', lon: '' }], [{ lat: null, lon: '36.8' }]]) {
      resetGeocodingRuntime();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
      const outcome = await geocodeForward(`null-coord-${JSON.stringify(payload)}`);
      expect(outcome, JSON.stringify(payload)).toEqual({ status: 'unavailable', reason: 'no_result' });
    }
  });

  it('an OUT-OF-RANGE provider coordinate -> invalid_response, never clamped', async () => {
    vi.stubGlobal('fetch', okFetch('999', '36.8219'));
    await expect(geocodeForward('Impossible Place')).resolves.toEqual({ status: 'unavailable', reason: 'invalid_response' });
  });

  it('an out-of-range LONGITUDE -> invalid_response', async () => {
    vi.stubGlobal('fetch', okFetch('-1.2921', '5000'));
    await expect(geocodeForward('Impossible Place 2')).resolves.toEqual({ status: 'unavailable', reason: 'invalid_response' });
  });
});

describe('timeout', () => {
  it('aborts a hanging provider request and reports "timeout"', async () => {
    setGeocodingEnv({ GEOCODING_TIMEOUT_MS: '25' });
    // A provider that never answers on its own, but honours the abort signal —
    // exactly how a real hung request behaves.
    vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })));

    const outcome = await geocodeForward('Hanging Provider');

    expect(outcome).toEqual({ status: 'unavailable', reason: 'timeout' });
  });

  it('passes an AbortSignal to the provider so the request is actually cancellable', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await geocodeForward('Westlands');

    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.signal).toBeDefined();
    expect(typeof init.signal.aborted).toBe('boolean');
  });
});


// ---------------------------------------------------------------------------
// LOGGING PRIVACY
// ---------------------------------------------------------------------------
describe('logging never contains raw user location text or coordinates', () => {
  it('logs only provider name + coarse reason on failure', async () => {
    const query = 'Outside my house on Kiambu Road, gate 4';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await geocodeForward(query);

    const everythingLogged = [...warnSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls]
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');

    // The raw user wording must NOT appear...
    expect(everythingLogged).not.toContain('Kiambu Road');
    expect(everythingLogged).not.toContain('gate 4');
    expect(everythingLogged.toLowerCase()).not.toContain('outside my house');
    // ...nor any coordinate.
    expect(everythingLogged).not.toMatch(/-?\d+\.\d{3,}/);
    // What IS logged is safe operational metadata only.
    expect(everythingLogged).toContain('provider');
    expect(everythingLogged).toContain('reason');
  });

  it('logs nothing at all for a clean, successful lookup', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', okFetch());

    await geocodeForward('Westlands');

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ARCHITECTURAL BOUNDARY — the provider must exist in exactly ONE place.
//
// This is the enforceable version of "no route or service knows a provider
// URL". It reads the real source tree, so a future edit that re-introduces a
// hard-coded geocoding endpoint into business logic fails this suite.
// ---------------------------------------------------------------------------
describe('the geocoding provider is confined to the geocoding boundary', () => {
  const srcRoot = path.resolve(__dirname, '..', '..');

  function allSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...allSourceFiles(full));
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const files = allSourceFiles(srcRoot);

  it('finds no provider HOSTNAME outside src/services/geocoding/', () => {
    const offenders = files.filter((file) => {
      const relative = path.relative(srcRoot, file).replace(/\\/g, '/');
      if (relative.startsWith('services/geocoding/')) return false;
      const content = fs.readFileSync(file, 'utf8');
      return /openstreetmap\.org|nominatim\.openstreetmap/i.test(content);
    });
    expect(offenders.map((f) => path.relative(srcRoot, f))).toEqual([]);
  });

  it('src/services/agent.ts contains no outbound geocoding fetch and no provider URL', () => {
    const agentSource = fs.readFileSync(path.join(srcRoot, 'services', 'agent.ts'), 'utf8');
    expect(agentSource).not.toMatch(/openstreetmap/i);
    expect(agentSource).not.toMatch(/https?:\/\//i);
    expect(agentSource).not.toMatch(/\bfetch\(/);
    // ...and it does go through the boundary, which is the whole point.
    expect(agentSource).toContain("from './geocoding/index.ts'");
  });

  it('the server route and the agent service never hand-build a provider URL', () => {
    const serverSource = fs.readFileSync(path.join(srcRoot, 'server.ts'), 'utf8');
    expect(serverSource).not.toMatch(/openstreetmap/i);
    expect(serverSource).not.toMatch(/nominatim/i);
  });
});


// ---------------------------------------------------------------------------
// PHASE 9D (F2) — THE ORDINARY TEST ENVIRONMENT CANNOT CONTACT A LIVE PROVIDER
//
// The repository already force-neutralises every other outbound provider
// credential before any test module loads (src/__tests__/setup.testEnv.ts) —
// it exists because a live SMS was genuinely dispatched from a test run during
// the production audit. Geocoding was missing from that list, so the suite
// inherited whatever the machine's .env happened to say.
//
// `ORIGINAL_ENV` above is captured at module load, i.e. AFTER setupFiles have
// run and BEFORE this suite mutates anything — so it is exactly the ambient
// test environment. These assertions FAIL if GEOCODING_PROVIDER is removed
// from the kill-switch list (the code default would then be an enabled
// 'nominatim' provider).
//
// No external request is made: this only reads configuration.
// ---------------------------------------------------------------------------
describe('the ordinary test environment cannot reach a live geocoding provider', () => {
  it('has geocoding DISABLED in the ambient environment', () => {
    const ambient = ORIGINAL_ENV as unknown as NodeJS.ProcessEnv;
    expect(isGeocodingEnabled(ambient)).toBe(false);
  });

  it('resolves to no provider at all in the ambient environment', () => {
    const ambient = ORIGINAL_ENV as unknown as NodeJS.ProcessEnv;
    expect(resolveProvider(readGeocodingConfig(ambient))).toBeNull();
  });

  it('the kill switch is the EMPTY "not configured" value setup.testEnv.ts documents', () => {
    // Empty string is the single value every guard in this codebase reads as
    // "not configured", and it is what readGeocodingConfig treats as disabled.
    expect(ORIGINAL_ENV.GEOCODING_PROVIDER).toBe('');
  });

  it('a blank provider makes geocodeForward return disabled without touching fetch', async () => {
    // Positive proof of the runtime consequence, with the ambient value.
    process.env.GEOCODING_PROVIDER = ORIGINAL_ENV.GEOCODING_PROVIDER;
    resetGeocodingRuntime();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await geocodeForward('Westlands');

    expect(outcome).toEqual({ status: 'unavailable', reason: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


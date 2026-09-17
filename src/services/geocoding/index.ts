// PROVIDER-NEUTRAL GEOCODING BOUNDARY (Phase 9D)
// =============================================
// The ONLY place in this application that knows a geocoding provider exists.
//
// WHY THIS EXISTS
//   Before Phase 9D a hard-coded Nominatim URL sat directly inside
//   services/agent.ts and was reached from the request paths of
//   `POST /api/items/report` and `POST /api/agents/apply`. The Phase 9D
//   forensic audit recorded five separate defects with that arrangement:
//
//     1. NO TIMEOUT — a hanging provider could hold an application request
//        indefinitely (Node's fetch has no default total timeout).
//     2. NO CACHE — the same query was re-sent every time, which the
//        provider's own usage policy prohibits ("Results must be cached on
//        your side. Clients sending repeatedly the same query may be
//        classified as faulty and blocked").
//     3. NO THROTTLE — the policy caps the public instance at 1 request/second
//        across the whole application.
//     4. NOT SWITCHABLE — the policy requires that a client be able to switch
//        provider without a software update; a hard-coded URL in the bundle
//        makes that impossible.
//     5. NO DISABLE PATH — there was no way to run the platform with geocoding
//        off, which is the safety property that makes it non-critical.
//
// WHAT THIS MODULE GUARANTEES
//   * Geocoding is BEST-EFFORT AND OPTIONAL. Every failure mode — disabled,
//     timeout, HTTP error, transport error, malformed payload, no result,
//     out-of-range coordinates — returns a controlled
//     `{ status: 'unavailable' }` value. It NEVER throws to the caller and
//     NEVER fails the surrounding workflow. Reporting, claiming, agent
//     application and public browsing all continue without it.
//   * No route or service contains a provider URL. They call
//     `geocodeForward()` and nothing else.
//   * The provider can be switched or disabled by CONFIGURATION alone.
//   * No query text, coordinate or provider payload is ever logged at INFO
//     level. Diagnostics are limited to provider name and a coarse reason code
//     (see §19 of the Phase 9D brief).
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//   * It does NOT reverse geocode. There is no coordinate->place operation
//     here, because no Phase 9D requirement needs one and adding it would
//     create an arbitrary-coordinate oracle (see the audit's section 12).
//   * It does NOT decide a county. A provider result is a coordinate pair only.
//     Canonical Kenyan county resolution remains `resolveCountyName()` in
//     config/kenyaCounties.ts, and the found-item county is the value the
//     FINDER explicitly chose — never anything a provider returned.
//   * It does NOT feed matching. services/lostReportMatching.ts reads no
//     geocoding output and no coordinate.
//   * It adds NO new provider and NO SDK. Nominatim-over-HTTP is the single
//     implementation, kept deliberately replaceable.
import { BoundedTtlCache, RequestThrottle, normalizeGeocodingKey } from './cache.ts';
import { isValidLatitude, isValidLongitude, parseCoordinateInput } from '../coordinates.ts';

// ---------------------------------------------------------------------------
// RESULT / INTERFACE TYPES
// ---------------------------------------------------------------------------

/** Why a lookup produced nothing usable. Machine-readable; safe to log. */
export type GeocodingUnavailableReason =
  | 'disabled'          // no provider configured — no request was made
  | 'empty_query'       // nothing to look up
  | 'timeout'           // the provider did not answer inside the bound
  | 'provider_error'    // HTTP error, transport error, or provider threw
  | 'no_result'         // provider answered cleanly with nothing
  | 'invalid_response'; // provider answered with an unusable coordinate

export type GeocodeOutcome =
  | { status: 'ok'; latitude: number; longitude: number; source: 'provider' | 'cache' }
  | { status: 'unavailable'; reason: GeocodingUnavailableReason };

/**
 * The provider contract. Small on purpose: one forward lookup, one abort
 * signal, one result. A future provider implements exactly this and nothing
 * else in the application changes.
 *
 * Implementations MUST honour `signal` and MUST NOT mutate anything.
 * `lookup` returns:
 *   - a coordinate pair when the provider found something usable,
 *   - `null` when the provider answered but found nothing, or answered with a
 *     payload this implementation cannot read,
 *   - and THROWS only for transport/HTTP-level failure (the orchestrator turns
 *     that into `provider_error`).
 */
export interface GeocodingProvider {
  readonly name: string;
  lookup(query: string, signal: AbortSignal): Promise<{ latitude: number; longitude: number } | null>;
}

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------
export interface GeocodingConfig {
  /** false => NO outbound request is ever made. */
  enabled: boolean;
  provider: string;
  /** Configurable endpoint, so a provider can be switched without a deploy. */
  endpoint: string;
  timeoutMs: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  /** Minimum spacing between ACTUAL outbound requests. */
  minIntervalMs: number;
  userAgent: string;
}

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const DEFAULT_USER_AGENT = 'Return4me-Kenya-Lost-and-Found-Platform/1.0 (contact@return4me.co.ke)';

/** Values that mean "do not call anyone". */
const DISABLED_PROVIDERS = new Set(['', 'none', 'off', 'disabled', 'false']);

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Reads configuration from the environment on every call, so a process can be
 * started with geocoding off — or switched — without any code change.
 *
 * DEFAULTS ARE DELIBERATELY CONSERVATIVE:
 *   - timeout 2500 ms — geocoding sits in a user-facing request path, so it
 *     must never be the slowest thing that happens.
 *   - cache TTL 24 h — place names do not move.
 *   - 500 entries — a bounded footprint, evicted oldest-first.
 *   - 1100 ms spacing — the public Nominatim instance is capped at 1 req/s.
 *
 * `GEOCODING_PROVIDER=none` (or `off`/`disabled`/`false`/empty) disables the
 * boundary completely and is the supported way to run without a provider.
 */
export function readGeocodingConfig(env: NodeJS.ProcessEnv = process.env): GeocodingConfig {
  const provider = String(env.GEOCODING_PROVIDER ?? 'nominatim').trim().toLowerCase();
  const enabled = !DISABLED_PROVIDERS.has(provider);
  return {
    enabled,
    provider,
    endpoint: String(env.GEOCODING_ENDPOINT || DEFAULT_ENDPOINT),
    timeoutMs: readPositiveInt(env.GEOCODING_TIMEOUT_MS, 2500),
    cacheTtlMs: readPositiveInt(env.GEOCODING_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
    cacheMaxEntries: readPositiveInt(env.GEOCODING_CACHE_MAX_ENTRIES, 500),
    minIntervalMs: readPositiveInt(env.GEOCODING_MIN_INTERVAL_MS, 1100),
    userAgent: String(env.GEOCODING_USER_AGENT || DEFAULT_USER_AGENT),
  };
}

/** True when a configured provider will actually be called. */
export function isGeocodingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readGeocodingConfig(env).enabled;
}

// ---------------------------------------------------------------------------
// NOMINATIM IMPLEMENTATION (the only provider; deliberately replaceable)
// ---------------------------------------------------------------------------
/**
 * Forward geocoding against an OSM/Nominatim-compatible endpoint.
 *
 * This is the SAME provider the codebase already used — it is not a new
 * dependency, and no SDK or key is required. What changed is that it is now
 * configurable, timed out, cached, throttled and fully failure-isolated
 * instead of a bare `fetch` on a hard-coded URL inside a request path.
 *
 * PRIVACY: the outbound query is the location string ALREADY being sent today,
 * and nothing else. No customer identity, phone number, email, claim id,
 * payment reference, document number, document hash or auth token is ever
 * attached. The query is normalized-but-not-rewritten, and it is never logged.
 *
 * `limit=1` is retained for compatibility with the previous behaviour, but the
 * result is now VALIDATED (finite + in range) before it is used, so an
 * out-of-range or non-numeric payload becomes `invalid_response` rather than a
 * coordinate.
 */
export function createNominatimProvider(config: GeocodingConfig): GeocodingProvider {
  return {
    name: 'nominatim',
    async lookup(query: string, signal: AbortSignal) {
      const url = `${config.endpoint}?q=${encodeURIComponent(`${query}, Kenya`)}&format=json&limit=1`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': config.userAgent,
          'Accept': 'application/json',
        },
        signal,
      });

      // Transport worked but the provider rejected the request. Treated as a
      // provider error (not "no result"), so it surfaces as unavailable rather
      // than as a claim that the place does not exist.
      if (!response.ok) {
        throw new Error(`geocoding provider returned HTTP ${response.status}`);
      }

      const payload: unknown = await response.json().catch(() => null);

      // Malformed / unreadable payload => treat as "nothing usable" rather than
      // throwing, so a provider changing its response shape degrades quietly.
      if (!Array.isArray(payload) || payload.length === 0) return null;

      const first = payload[0];
      if (!first || typeof first !== 'object') return null;

      // STRICT parsing, deliberately reusing the shared validator rather than
      // `Number(...)`. This matters: `Number(null)` and `Number('')` are both
      // 0, so a payload of `{ lat: null, lon: null }` would otherwise be read
      // as the VALID coordinate 0,0 — inventing a location in the Gulf of
      // Guinea out of a provider that actually returned nothing. The strict
      // parser rejects null/''/trailing-garbage and accepts a real 0.
      const lat = parseCoordinateInput((first as any).lat);
      const lon = parseCoordinateInput((first as any).lon);
      if (lat === null || lon === null) return null;

      return { latitude: lat, longitude: lon };
    },
  };
}

/** The provider for a given configuration, or null when geocoding is off. */
export function resolveProvider(config: GeocodingConfig): GeocodingProvider | null {
  if (!config.enabled) return null;
  // Only one implementation exists in Phase 9D. An unknown provider name is
  // treated as "no provider" rather than silently falling back to Nominatim,
  // so a typo can never quietly re-enable an outbound call someone intended to
  // turn off.
  if (config.provider === 'nominatim') return createNominatimProvider(config);
  return null;
}

// ---------------------------------------------------------------------------
// RUNTIME STATE (bounded cache + throttle + in-flight dedup)
// ---------------------------------------------------------------------------
interface GeocodingRuntime {
  /** Identifies the config this state was built for. */
  signature: string;
  cache: BoundedTtlCache<{ latitude: number; longitude: number }>;
  throttle: RequestThrottle;
  inFlight: Map<string, Promise<GeocodeOutcome>>;
}

let runtime: GeocodingRuntime | null = null;

function configSignature(config: GeocodingConfig): string {
  return [
    config.provider, config.endpoint, config.timeoutMs,
    config.cacheTtlMs, config.cacheMaxEntries, config.minIntervalMs,
  ].join('|');
}

/** (Re)builds the runtime whenever the configuration changes. */
function getRuntime(config: GeocodingConfig): GeocodingRuntime {
  const signature = configSignature(config);
  if (!runtime || runtime.signature !== signature) {
    runtime = {
      signature,
      cache: new BoundedTtlCache({ maxEntries: config.cacheMaxEntries, ttlMs: config.cacheTtlMs }),
      throttle: new RequestThrottle({ minIntervalMs: config.minIntervalMs }),
      inFlight: new Map(),
    };
  }
  return runtime;
}

/**
 * Drops all cached/in-flight geocoding state. Exported for tests and for an
 * operator who deliberately wants to re-query after a provider change; it is
 * NOT called from any request path.
 */
export function resetGeocodingRuntime(): void {
  runtime = null;
}

// ---------------------------------------------------------------------------
// THE SINGLE OUTBOUND CALL
// ---------------------------------------------------------------------------
/**
 * Performs the timed, validated provider call.
 *
 * FAILURE ISOLATION SCOPE — this is the security-relevant detail: the ONLY
 * work inside the `try` is the outbound provider request and the validation of
 * its result. A database error, an authorization error or a bug in a caller
 * can never be swallowed here, because none of that executes inside this
 * function. Conversely, every expected provider failure (timeout, DNS, TLS,
 * non-2xx status) is contained and becomes `unavailable`.
 */
async function runProviderLookup(
  provider: GeocodingProvider,
  normalizedQuery: string,
  config: GeocodingConfig,
): Promise<GeocodeOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  try {
    const place = await provider.lookup(normalizedQuery, controller.signal);
    if (!place) return { status: 'unavailable', reason: 'no_result' };
    if (!isValidLatitude(place.latitude) || !isValidLongitude(place.longitude)) {
      // A provider answer outside valid ranges is NOT a location. It is
      // discarded rather than clamped or reinterpreted.
      return { status: 'unavailable', reason: 'invalid_response' };
    }
    return { status: 'ok', latitude: place.latitude, longitude: place.longitude, source: 'provider' };
  } catch {
    const reason = timedOut ? 'timeout' : 'provider_error';
    // SAFE DIAGNOSTIC ONLY: provider name + coarse reason. Never the query,
    // never a coordinate, never the raw provider payload (Phase 9D §19).
    console.warn('[GEOCODING] lookup unavailable', { provider: provider.name, reason });
    return { status: 'unavailable', reason };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// PUBLIC API — the only entry point the rest of the application may use
// ---------------------------------------------------------------------------
/**
 * Forward-geocodes a place description to a coordinate pair.
 *
 * ORDER OF OPERATIONS (each step is a deliberate control):
 *   1. provider disabled / unknown  -> `disabled`, and NO request is made;
 *   2. blank after normalization    -> `empty_query`, and NO request is made;
 *   3. cache hit                    -> `ok` with `source: 'cache'`, and NO
 *                                      request, and no throttle slot used;
 *   4. identical lookup already in flight -> that SAME promise is returned, so
 *                                      concurrent callers produce ONE request;
 *   5. otherwise                    -> throttle, then one timed, validated
 *                                      provider request.
 *
 * NEVER THROWS. NEVER returns a partially-populated result. Only SUCCESSFUL
 * lookups are cached, so a transient provider outage can never be frozen in
 * place for the TTL window.
 *
 * `source: 'cache'` exists so a caller (or a test) can distinguish a real
 * outbound request from a cache hit — the throttle requirement depends on that
 * distinction.
 */
export async function geocodeForward(rawQuery: string): Promise<GeocodeOutcome> {
  const config = readGeocodingConfig();
  const provider = resolveProvider(config);

  // (1) Disabled or unrecognised provider: no network activity of any kind.
  if (!provider) return { status: 'unavailable', reason: 'disabled' };

  // The cache key doubles as the outbound query. It is a lower-cased,
  // punctuation-normalized copy — the caller's stored text is never modified.
  const key = normalizeGeocodingKey(rawQuery);
  if (!key) return { status: 'unavailable', reason: 'empty_query' };

  const rt = getRuntime(config);

  // (2) Cache hit: nothing leaves the process.
  const cached = rt.cache.get(key);
  if (cached) {
    return { status: 'ok', latitude: cached.latitude, longitude: cached.longitude, source: 'cache' };
  }

  // (3) In-flight deduplication: share the one outstanding lookup.
  const existing = rt.inFlight.get(key);
  if (existing) return existing;

  const attempt: Promise<GeocodeOutcome> = (async () => {
    try {
      await rt.throttle.acquire();
      const outcome = await runProviderLookup(provider, key, config);
      if (outcome.status === 'ok') {
        rt.cache.set(key, { latitude: outcome.latitude, longitude: outcome.longitude });
      }
      return outcome;
    } finally {
      // Cleared on BOTH success and failure so a failed lookup cannot wedge
      // this key forever.
      rt.inFlight.delete(key);
    }
  })();

  rt.inFlight.set(key, attempt);
  return attempt;
}

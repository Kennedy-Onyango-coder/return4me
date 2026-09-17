// GEOCODING CACHE / THROTTLE / DEDUPLICATION PRIMITIVES (Phase 9D)
// ==============================================================
// Three small, independent, dependency-free mechanisms that make an outbound
// geocoding request safe to make from inside an application request path.
// They live in their own file so they can be unit-tested without touching the
// network at all.
//
// WHY EACH ONE EXISTS (from the Phase 9D forensic audit, section 13)
//   * CACHE       — the provider's own terms require caching, and caching is
//                   also what stops "Nairobi CBD" being re-queried on every
//                   single report. Bounded + TTL so it can never grow without
//                   limit inside a long-lived process.
//   * THROTTLE    — the provider's terms cap outbound request rate. The
//                   throttle is applied to ACTUAL OUTBOUND REQUESTS only
//                   (cache hits never reach it), and it is a serialized queue
//                   so concurrent callers cannot collectively bypass the cap.
//   * IN-FLIGHT   — two identical lookups arriving at the same moment must
//                   produce ONE provider request, not two.
//
// NO PERSISTENCE, NO LOGGING OF QUERY TEXT
//   Nothing here writes to a database, a disk or a log. Cache keys are
//   normalized strings held in memory only. Raw user-supplied location text is
//   never logged by this file.

/**
 * Deterministic cache key for a location query.
 *
 * Mirrors the token normalization the rest of the platform already uses
 * (lowercase, strip accents, punctuation -> separator, collapse whitespace) so
 * `'Nairobi  CBD.'` and `'nairobi cbd'` share one entry.
 *
 * This is a CACHE-KEY transform only. It is deliberately NOT county
 * canonicalization — that remains `config/kenyaCounties.ts`
 * (`resolveCountyName`), which is the single canonical implementation. This
 * function never resolves, corrects or infers a place name: it only makes two
 * spellings of the same lookup occupy the same cache slot.
 *
 * It also NEVER modifies the caller's stored value — the item's
 * `location_description` is untouched (see §8 of the Phase 9D brief).
 */
export function normalizeGeocodingKey(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents
    .replace(/[^a-z0-9\s]/g, ' ')    // punctuation -> separator
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bounded, TTL-based in-memory cache with predictable eviction.
 *
 * EVICTION IS DETERMINISTIC: a JS Map preserves insertion order, so the oldest
 * inserted entry is always `keys().next().value`. When the cache is full the
 * OLDEST entry is dropped — never a random one, never "the whole cache".
 * Re-setting an existing key refreshes its recency by re-inserting it.
 *
 * Only successful lookups are stored by the caller (see geocoding/index.ts);
 * a provider failure is never cached, so a transient outage cannot be frozen
 * in place for the TTL window.
 */
export class BoundedTtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  /** Injectable clock so TTL behaviour is testable without real waiting. */
  private readonly now: () => number;

  constructor(options: { maxEntries: number; ttlMs: number; now?: () => number }) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.ttlMs = Math.max(0, Math.floor(options.ttlMs));
    this.now = options.now ?? (() => Date.now());
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    // Re-insert so this key becomes the most recently used.
    if (this.entries.has(key)) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** Live (non-expired) entry count. Used by tests to prove the bound holds. */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Serialized request throttle: at most one outbound request starts per
 * `minIntervalMs`, and callers queue rather than overlap.
 *
 * WHY SERIALIZED RATHER THAN A TIMESTAMP CHECK: a "was the last request more
 * than N ms ago?" test lets N concurrent callers all read the same stale
 * timestamp and fire simultaneously, which is exactly the bypass the brief
 * forbids. Chaining each acquirer onto the previous one guarantees the spacing
 * holds no matter how many callers arrive at once.
 */
export class RequestThrottle {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(options: { minIntervalMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    this.minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Resolves when the caller is allowed to make its outbound request. */
  acquire(): Promise<void> {
    const ticket = this.chain.then(async () => {
      const waitMs = Math.max(0, this.lastStart + this.minIntervalMs - this.now());
      if (waitMs > 0) await this.sleep(waitMs);
      this.lastStart = this.now();
    });
    // Keep the chain alive even if a ticket rejects, so one failure cannot
    // deadlock every subsequent acquirer.
    this.chain = ticket.catch(() => undefined);
    return ticket;
  }
}

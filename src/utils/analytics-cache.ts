/**
 * Lightweight in-process TTL cache for analytics aggregation results.
 *
 * Design rationale
 * ────────────────
 * Analytics aggregation queries touch three tables (payments, escrowEvents,
 * agreementEvents) and perform full-range scans bounded only by user address
 * and calendar year.  These are among the most expensive read paths in the
 * backend, yet the underlying data changes at most once per Starknet block
 * (≈6–12 s).  A short-lived in-process cache keyed by the full set of query
 * parameters absorbs repeated identical requests within a single TTL window
 * without adding a Redis dependency or cross-process coordination.
 *
 * Security
 * ────────
 * Cache keys MUST include the user address and every query parameter that
 * affects the result.  This ensures that no caller ever receives data scoped
 * to a different identity.  The cache intentionally holds only public
 * aggregation totals (no raw rows, no PII beyond the address already in the
 * key) so cross-request leakage is structurally impossible.
 *
 * TTL configuration
 * ─────────────────
 * The TTL is configurable via `ANALYTICS_CACHE_TTL_MS` (see `src/config.ts`).
 * The default (30 000 ms, i.e. 30 s) is deliberately conservative: it covers
 * ~2–5 Starknet blocks while keeping data staleness well below what a human
 * user would notice.  Set it lower in test environments or higher for very
 * large deployments.
 */

/** A single cache entry storing the cached value and its absolute expiry. */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Build the canonical cache key from all parameters that affect a query result.
 *
 * All query parameters are lowercased and sorted so that identical logical
 * queries produce identical keys regardless of URL encoding variations.
 *
 * @param userAddress  The normalised Starknet address of the queried user.
 * @param params       Additional query parameters (e.g., `{ year: 2026 }`).
 * @returns            An opaque string suitable for use as a `Map` key.
 */
export function buildAnalyticsCacheKey(
  userAddress: string,
  params: Record<string, string | number | undefined>,
): string {
  const sorted = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
  return `analytics:${userAddress.toLowerCase()}?${sorted}`;
}

/**
 * A minimal TTL-based in-process cache.
 *
 * Entries are stored in a plain `Map`; expired items are evicted lazily on
 * the next `get` call for the same key.  No background timer is needed for
 * correctness — callers receive either a fresh cached value or `undefined`.
 *
 * If you need periodic bulk eviction (e.g., to bound memory under heavy load),
 * call `evictExpired()` on an application-level interval.
 */
export class AnalyticsCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  /**
   * @param ttlMs  Time-to-live in milliseconds for newly inserted entries.
   */
  constructor(private readonly ttlMs: number) {}

  /**
   * Retrieve a cached value.
   *
   * Returns `undefined` if the key is absent or the entry has expired.
   * Expired entries are deleted eagerly on access so memory is reclaimed
   * without a background sweeper.
   */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Insert or replace a value in the cache.
   *
   * The entry expires `ttlMs` milliseconds after this call, regardless of
   * how many times it is read in between.
   */
  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Remove all entries whose TTL has elapsed.
   *
   * Call this periodically if memory growth is a concern in long-running
   * deployments that receive a large variety of distinct query keys.
   */
  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Remove a single key from the cache unconditionally.
   *
   * Primarily intended for tests that need to assert on fresh fetches after
   * a mutation.
   */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Wipe all cached entries.  Useful in test `beforeEach` hooks. */
  clear(): void {
    this.store.clear();
  }

  /** Current number of live entries (including those that may be stale). */
  get size(): number {
    return this.store.size;
  }
}

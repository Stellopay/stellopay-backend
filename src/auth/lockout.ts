export type LockoutRecord = {
  failures: number;
  lockedUntil: number;
};

export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Store abstraction
// ---------------------------------------------------------------------------

/**
 * Pluggable store for lockout state.  Implementations must handle TTL /
 * bounded growth internally so entries do not accumulate indefinitely.
 *
 * The async signature is intentional: Redis and other shared backends are
 * inherently async.  In-process callers already run inside async Express
 * handlers so adding `await` is trivial.
 */
export interface LockoutStore {
  get(key: string): Promise<LockoutRecord | undefined>;
  set(key: string, record: LockoutRecord, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Return the approximate number of live entries (best-effort). */
  size(): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory store (tests, single-instance deployments)
// ---------------------------------------------------------------------------

/**
 * In-memory lockout store with TTL-based eviction.
 *
 * Suitable for single-instance deployments and testing.  Every entry is
 * assigned an absolute expiry based on the `ttlMs` passed to {@link set}.
 * Expired entries are reclaimed lazily on read; call {@link evictExpired}
 * periodically if you need bulk reclamation under heavy load.
 */
export class InMemoryLockoutStore implements LockoutStore {
  private readonly store = new Map<string, { record: LockoutRecord; expiresAt: number }>();

  async get(key: string): Promise<LockoutRecord | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.record;
  }

  async set(key: string, record: LockoutRecord, ttlMs: number): Promise<void> {
    this.store.set(key, { record, expiresAt: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async size(): Promise<number> {
    return this.store.size;
  }

  /** Evict entries whose TTL has elapsed.  O(n) scan. */
  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Redis store (multi-instance production)
// ---------------------------------------------------------------------------

/**
 * Shape of the Redis client accepted by {@link RedisLockoutStore}.
 * Matches the subset of `ioredis` used for lockout operations.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const REDIS_KEY_PREFIX = "lockout:";

/**
 * Redis-backed lockout store with native TTL via `PX` (millisecond expiry).
 *
 * Keys are prefixed with `lockout:` to avoid collisions.  When Redis is
 * unavailable the store **fails open** — `get()` returns `undefined` (not
 * locked out) and writes are silently dropped.  This matches the rate
 * limiter's precedent in `src/middleware/rate-limit.ts:180-186`: a Redis
 * outage should not bring down authentication, and the degraded state is
 * identical to the pre-fix in-process behaviour.
 *
 * ## Fail-open justification
 *
 * The rate limiter deliberately fails open (`passOnStoreError: true`) so
 * that a Redis outage does not cascade into a full API outage.  Lockout
 * should follow the same precedent because:
 *
 * 1. **Consistency** — operators already expect degraded-to-open on Redis
 *    failure from the rate limiter.  Having lockout behave differently
 *    would be surprising.
 * 2. **Worst case is unchanged** — without this fix every instance already
 *    fails open (each has its own in-memory Map).  Failing open during a
 *    Redis outage is no worse than the status quo, while every other moment
 *    is strictly better (shared state).
 * 3. **Availability** — credential-guessing protection is a defence-in-depth
 *    control, not the sole authentication gate.  The signature challenge
 *    remains cryptographically strong regardless.
 *
 * If the operator needs fail-closed behaviour (e.g. regulatory requirement),
 * they should wrap the store in a circuit breaker that rejects requests
 * when Redis is down.
 */
export class RedisLockoutStore implements LockoutStore {
  constructor(private readonly redis: RedisClient) {}

  async get(key: string): Promise<LockoutRecord | undefined> {
    try {
      const raw = await this.redis.get(`${REDIS_KEY_PREFIX}${key}`);
      return raw ? (JSON.parse(raw) as LockoutRecord) : undefined;
    } catch {
      // Fail-open: treat Redis errors as "not locked out".
      return undefined;
    }
  }

  async set(key: string, record: LockoutRecord, ttlMs: number): Promise<void> {
    try {
      await this.redis.set(
        `${REDIS_KEY_PREFIX}${key}`,
        JSON.stringify(record),
        "PX",
        ttlMs,
      );
    } catch {
      // Fail-open: write failure logged by caller (Redis client error event).
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(`${REDIS_KEY_PREFIX}${key}`);
    } catch {
      // Best-effort cleanup.
    }
  }

  async clear(): Promise<void> {
    // Intentionally no-op for Redis — tests should use InMemoryLockoutStore.
    // A production "reset all lockouts" is an unusual operation that should
    // go through a deliberate admin action, not a bulk wipe.
  }

  async size(): Promise<number> {
    // Redis does not have a cheap COUNT.  Return -1 as "unknown".
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Module-level store + setter
// ---------------------------------------------------------------------------

/**
 * The active lockout store.  Defaults to an {@link InMemoryLockoutStore}.
 * Replace at startup with a {@link RedisLockoutStore} for multi-instance
 * deployments:
 *
 * ```ts
 * import { setLockoutStore, RedisLockoutStore } from "./auth/lockout.js";
 * if (env.REDIS_URL) {
 *   setLockoutStore(new RedisLockoutStore(redisClient));
 * }
 * ```
 */
let store: LockoutStore = new InMemoryLockoutStore();

/**
 * Swap the backing store.  Call at startup (before any requests) or in
 * test `beforeEach` hooks to get an isolated store.
 */
export function setLockoutStore(s: LockoutStore): void {
  store = s;
}

/**
 * The currently active lockout store.  Exported so callers can call
 * `.clear()` in tests or inspect `.size()`.
 */
export const lockouts: LockoutStore = {
  get: (key) => store.get(key),
  set: (key, rec, ttl) => store.set(key, rec, ttl),
  delete: (key) => store.delete(key),
  clear: () => store.clear(),
  size: () => store.size(),
};

// ---------------------------------------------------------------------------
// Core lockout functions
// ---------------------------------------------------------------------------

/**
 * Records a failed login attempt for the given address.
 * If failures reach {@link MAX_FAILURES}, locks the account for {@link LOCKOUT_MS}.
 */
export async function recordFailure(address: string): Promise<void> {
  const key = address.toLowerCase();
  let rec = await store.get(key);

  if (!rec || (rec.lockedUntil > 0 && rec.lockedUntil < Date.now())) {
    // Start fresh if no record, or if a previous lockout has expired.
    rec = { failures: 0, lockedUntil: 0 };
  }

  rec.failures++;

  if (rec.failures >= MAX_FAILURES) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;

    console.warn(
      JSON.stringify({
        metric: "account_lockout",
        address: key,
        locked_for_ms: LOCKOUT_MS,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  await store.set(key, rec, LOCKOUT_MS);
}

/**
 * Checks if the given address is currently locked out.
 */
export async function isLockedOut(address: string): Promise<boolean> {
  const key = address.toLowerCase();
  const rec = await store.get(key);
  if (!rec) return false;
  return rec.lockedUntil > Date.now();
}

/**
 * Clears failures and lockout state for the given address upon successful login.
 */
export async function clearFailures(address: string): Promise<void> {
  await store.delete(address.toLowerCase());
}

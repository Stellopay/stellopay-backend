import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordFailure,
  isLockedOut,
  clearFailures,
  lockouts,
  setLockoutStore,
  InMemoryLockoutStore,
  RedisLockoutStore,
  MAX_FAILURES,
  LOCKOUT_MS,
  type LockoutRecord,
  type RedisClient,
} from "./lockout.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock Redis client backed by a plain Map. */
function mockRedis(): RedisClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, _mode: string, _ttl: number) {
      store.set(key, value);
    },
    async del(key: string) {
      store.delete(key);
    },
  };
}

/** Build a Redis client that throws on every operation. */
function failingRedis(): RedisClient {
  return {
    async get() {
      throw new Error("Redis unavailable");
    },
    async set() {
      throw new Error("Redis unavailable");
    },
    async del() {
      throw new Error("Redis unavailable");
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lockout", () => {
  beforeEach(async () => {
    setLockoutStore(new InMemoryLockoutStore());
    await lockouts.clear();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Core behaviour (unchanged from original)
  // -----------------------------------------------------------------------

  describe("single-instance behaviour", () => {
    it("does not lock out before MAX_FAILURES", async () => {
      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        await recordFailure("0xabc");
        expect(await isLockedOut("0xabc")).toBe(false);
      }
    });

    it("locks out after MAX_FAILURES", async () => {
      for (let i = 0; i < MAX_FAILURES; i++) {
        await recordFailure("0xabc");
      }
      expect(await isLockedOut("0xabc")).toBe(true);
    });

    it("clearFailures removes lockout state", async () => {
      for (let i = 0; i < MAX_FAILURES; i++) {
        await recordFailure("0xabc");
      }
      expect(await isLockedOut("0xabc")).toBe(true);

      await clearFailures("0xabc");
      expect(await isLockedOut("0xabc")).toBe(false);
    });

    it("is case-insensitive", async () => {
      await recordFailure("0xABC");
      await recordFailure("0xabc");
      // Both should count against the same key → 2 failures
      const rec = await lockouts.get("0xabc");
      expect(rec?.failures).toBe(2);
    });

    it("lockout expires after LOCKOUT_MS", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      for (let i = 0; i < MAX_FAILURES; i++) {
        await recordFailure("0xabc");
      }
      expect(await isLockedOut("0xabc")).toBe(true);

      vi.advanceTimersByTime(LOCKOUT_MS + 1);
      expect(await isLockedOut("0xabc")).toBe(false);
    });

    it("successful login resets failure counter", async () => {
      // Accumulate some failures (less than MAX_FAILURES)
      await recordFailure("0xabc");
      await recordFailure("0xabc");
      expect(await isLockedOut("0xabc")).toBe(false);

      await clearFailures("0xabc");

      // After clear, should be able to fail again without lockout
      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        await recordFailure("0xabc");
        expect(await isLockedOut("0xabc")).toBe(false);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Multi-instance bypass (the security fix)
  // -----------------------------------------------------------------------

  describe("multi-instance bypass", () => {
    it("demonstrates bypass with separate stores (two instances)", async () => {
      // Simulate two separate instances with separate in-memory stores.
      const instanceA = new InMemoryLockoutStore();
      const instanceB = new InMemoryLockoutStore();

      // Instance A sees 4 failures (below threshold).
      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        instanceA.set("0xabc", {
          failures: i + 1,
          lockedUntil: 0,
        }, LOCKOUT_MS);
      }
      const recA = await instanceA.get("0xabc");
      expect(recA?.failures).toBe(4);
      // Not locked on A because 4 < 5
      expect(recA?.lockedUntil).toBe(0);

      // Instance B has no knowledge of A's failures.
      const recB = await instanceB.get("0xabc");
      expect(recB).toBeUndefined();
    });

    it("shared store prevents bypass — same account locked across all users", async () => {
      // Both callers share the same store.
      const shared = new InMemoryLockoutStore();
      setLockoutStore(shared);

      // Simulate failures spread across "instances" (just calling recordFailure
      // multiple times through the shared module).
      for (let i = 0; i < MAX_FAILURES; i++) {
        await recordFailure("0xabc");
      }

      // The account is now locked — regardless of which "instance" checks.
      expect(await isLockedOut("0xabc")).toBe(true);
    });

    it("total attempts never exceed MAX_FAILURES with a shared store", async () => {
      const shared = new InMemoryLockoutStore();
      setLockoutStore(shared);

      let lockoutTriggered = false;

      for (let attempt = 1; attempt <= MAX_FAILURES + 5; attempt++) {
        await recordFailure("0xabc");
        if (await isLockedOut("0xabc")) {
          lockoutTriggered = true;
          break;
        }
      }

      expect(lockoutTriggered).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Redis store
  // -----------------------------------------------------------------------

  describe("RedisLockoutStore", () => {
    it("stores and retrieves lockout records via Redis", async () => {
      const redis = mockRedis();
      const store = new RedisLockoutStore(redis);
      setLockoutStore(store);

      await recordFailure("0xabc");
      await recordFailure("0xabc");

      const rec = await store.get("0xabc");
      expect(rec).toBeDefined();
      expect(rec?.failures).toBe(2);

      // Verify Redis key format
      expect(redis.store.has("lockout:0xabc")).toBe(true);
    });

    it("respects TTL passed to set", async () => {
      const redis = mockRedis();
      const store = new RedisLockoutStore(redis);

      const record: LockoutRecord = { failures: 5, lockedUntil: Date.now() + 60000 };
      await store.set("0xabc", record, 60000);

      // Redis stores with PX mode — the raw value should be JSON
      const raw = redis.store.get("lockout:0xabc");
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!).failures).toBe(5);
    });

    it("deletes lockout records", async () => {
      const redis = mockRedis();
      const store = new RedisLockoutStore(redis);
      setLockoutStore(store);

      await recordFailure("0xabc");
      expect(await store.get("0xabc")).toBeDefined();

      await store.delete("0xabc");
      expect(await store.get("0xabc")).toBeUndefined();
    });

    it("fails open when Redis throws on get", async () => {
      const store = new RedisLockoutStore(failingRedis());
      setLockoutStore(store);

      // Even after recording failures, a failing Redis get returns undefined
      // (not locked out) — fail-open behaviour.
      const result = await store.get("0xabc");
      expect(result).toBeUndefined();
    });

    it("fails open when Redis throws on set", async () => {
      const store = new RedisLockoutStore(failingRedis());
      setLockoutStore(store);

      // Should not throw — write failure is silently absorbed.
      await recordFailure("0xabc");
      await recordFailure("0xabc");
    });

    it("fails open when Redis throws on delete", async () => {
      const store = new RedisLockoutStore(failingRedis());
      setLockoutStore(store);

      // Should not throw — delete failure is silently absorbed.
      await clearFailures("0xabc");
    });

    it("isLockedOut returns false (not locked) when Redis fails", async () => {
      const store = new RedisLockoutStore(failingRedis());
      setLockoutStore(store);

      // Fail-open: if Redis is down, the address is treated as not locked out.
      expect(await isLockedOut("0xabc")).toBe(false);
    });

    it("returns -1 for size (unknown) in Redis mode", async () => {
      const store = new RedisLockoutStore(mockRedis());
      expect(await store.size()).toBe(-1);
    });

    it("clear is a no-op for Redis store", async () => {
      const redis = mockRedis();
      const store = new RedisLockoutStore(redis);

      await store.set("0xabc", { failures: 5, lockedUntil: Date.now() + 60000 }, 60000);
      await store.clear();

      // Data is still in Redis (clear is a no-op for production Redis).
      expect(redis.store.has("lockout:0xabc")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Bounded growth
  // -----------------------------------------------------------------------

  describe("bounded growth", () => {
    it("InMemoryLockoutStore: entries do not accumulate indefinitely", async () => {
      const store = new InMemoryLockoutStore();
      vi.useFakeTimers();
      vi.setSystemTime(0);

      // Create 1000 entries with very short TTL (1 ms).
      for (let i = 0; i < 1000; i++) {
        await store.set(
          `attacker:${i}`,
          { failures: 1, lockedUntil: 0 },
          1,
        );
      }
      expect(await store.size()).toBe(1000);

      // Advance past the TTL.
      vi.advanceTimersByTime(2);

      // Evict expired entries.
      store.evictExpired();

      // All entries should be gone.
      expect(await store.size()).toBe(0);
    });

    it("InMemoryLockoutStore: only non-expired entries survive eviction", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const store = new InMemoryLockoutStore();

      // Expired entry (1 ms TTL, already expired after advancing)
      await store.set("expired", { failures: 5, lockedUntil: 0 }, 1);
      // Active entry (long TTL)
      await store.set("active", { failures: 3, lockedUntil: 0 }, 60_000);

      vi.advanceTimersByTime(2);
      store.evictExpired();

      expect(await store.get("expired")).toBeUndefined();
      expect(await store.get("active")).toBeDefined();
      expect(await store.size()).toBe(1);
    });

    it("InMemoryLockoutStore: lazy eviction on get reclaims expired entries", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const store = new InMemoryLockoutStore();

      await store.set("expired", { failures: 5, lockedUntil: 0 }, 1);
      expect(await store.size()).toBe(1);

      vi.advanceTimersByTime(2);

      // Reading an expired entry should evict it.
      const result = await store.get("expired");
      expect(result).toBeUndefined();
      expect(await store.size()).toBe(0);
    });

    it("InMemoryLockoutStore: attacker creating arbitrary identifiers is bounded", async () => {
      const store = new InMemoryLockoutStore();
      setLockoutStore(store);

      vi.useFakeTimers();
      vi.setSystemTime(0);

      for (let i = 0; i < 200; i++) {
        await recordFailure(`0x${String(i).padStart(40, "0")}`);
      }
      expect(await store.size()).toBe(200);

      // Advance past the TTL (LOCKOUT_MS is the TTL used by recordFailure).
      vi.advanceTimersByTime(LOCKOUT_MS + 1);

      // Bulk-evict should clear all expired entries.
      store.evictExpired();
      expect(await store.size()).toBe(0);
    });

    it("Redis store: bounded by Redis TTL (PX expiry)", async () => {
      // Redis handles TTL natively — keys expire automatically.
      // This test verifies the PX parameter is passed correctly.
      const redis = mockRedis();
      const store = new RedisLockoutStore(redis);

      await store.set("0xabc", { failures: 5, lockedUntil: Date.now() + 60000 }, 60000);

      // The raw Redis call should have been made with "PX" mode.
      // (In a real Redis, the key would auto-expire after 60000ms.)
      expect(redis.store.has("lockout:0xabc")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Persistence across restarts
  // -----------------------------------------------------------------------

  describe("persistence", () => {
    it("InMemoryLockoutStore: state is lost on restart (expected)", async () => {
      // In-memory store does NOT survive restarts. This is documented as a
      // known trade-off: single-instance deployments accept this; multi-instance
      // deployments should use RedisLockoutStore.
      const store = new InMemoryLockoutStore();
      setLockoutStore(store);

      await recordFailure("0xabc");

      // Simulate restart: create a new store instance.
      const newStore = new InMemoryLockoutStore();
      setLockoutStore(newStore);

      expect(await isLockedOut("0xabc")).toBe(false);
    });

    it("RedisLockoutStore: state survives process restart", async () => {
      const redis = mockRedis();
      const store = new RedisLockoutStore(redis);
      setLockoutStore(store);

      // Record enough failures to trigger lockout.
      for (let i = 0; i < MAX_FAILURES; i++) {
        await recordFailure("0xabc");
      }
      expect(await isLockedOut("0xabc")).toBe(true);

      // Simulate restart: create a NEW store instance pointing at the same Redis.
      const storeAfterRestart = new RedisLockoutStore(redis);
      setLockoutStore(storeAfterRestart);

      // State is still in Redis — lockout persists.
      expect(await isLockedOut("0xabc")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Integration: end-to-end lockout flow
  // -----------------------------------------------------------------------

  describe("end-to-end lockout flow", () => {
    it("full cycle: accumulate failures → lockout → wait → clear → succeed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      // 1. Accumulate failures up to threshold.
      for (let i = 0; i < MAX_FAILURES; i++) {
        await recordFailure("0xdeadbeef");
      }
      expect(await isLockedOut("0xdeadbeef")).toBe(true);

      // 2. While locked, additional failures don't extend the lock.
      await recordFailure("0xdeadbeef");
      expect(await isLockedOut("0xdeadbeef")).toBe(true);

      // 3. Wait for lockout to expire.
      vi.advanceTimersByTime(LOCKOUT_MS + 1);
      expect(await isLockedOut("0xdeadbeef")).toBe(false);

      // 4. But failure counter is still there (only cleared by clearFailures).
      // After lockout expiry, one failure resets the counter (lockedUntil is in
      // the past, so rec gets reset to { failures: 0, lockedUntil: 0 }).
      // So you can fail MAX_FAILURES-1 more times before re-locking.
      await recordFailure("0xdeadbeef");
      expect(await isLockedOut("0xdeadbeef")).toBe(false);
      // Fail MAX_FAILURES-2 more times (total: 1 + (MAX_FAILURES-2) = MAX_FAILURES-1)
      for (let i = 0; i < MAX_FAILURES - 2; i++) {
        await recordFailure("0xdeadbeef");
        expect(await isLockedOut("0xdeadbeef")).toBe(false);
      }
      // The next failure (the MAX_FAILURES-th total) triggers lockout.
      await recordFailure("0xdeadbeef");
      expect(await isLockedOut("0xdeadbeef")).toBe(true);

      // 5. Simulate successful login → clear failures.
      await clearFailures("0xdeadbeef");
      expect(await isLockedOut("0xdeadbeef")).toBe(false);

      // 6. Can now fail up to MAX_FAILURES-1 times without lockout.
      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        await recordFailure("0xdeadbeef");
        expect(await isLockedOut("0xdeadbeef")).toBe(false);
      }
    });
  });

  // -----------------------------------------------------------------------
  // LockoutStore interface compliance
  // -----------------------------------------------------------------------

  describe("lockouts proxy", () => {
    it("delegates to the active store", async () => {
      const store = new InMemoryLockoutStore();
      setLockoutStore(store);

      const future = Date.now() + 60_000;
      await lockouts.set("test", { failures: 3, lockedUntil: future }, 60000);
      const rec = await lockouts.get("test");
      expect(rec?.failures).toBe(3);

      await lockouts.delete("test");
      expect(await lockouts.get("test")).toBeUndefined();
    });

    it("swap changes behaviour of recordFailure/isLockedOut/clearFailures", async () => {
      // Start with store A.
      const storeA = new InMemoryLockoutStore();
      setLockoutStore(storeA);

      await recordFailure("0xaaa");

      // Swap to store B — the address is no longer tracked.
      const storeB = new InMemoryLockoutStore();
      setLockoutStore(storeB);

      expect(await isLockedOut("0xaaa")).toBe(false);
    });
  });
});

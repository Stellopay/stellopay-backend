import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  current as fakeDbHolder,
  type FakeIdempotencyDb,
} from "./test-support/fake-idempotency-db.js";

vi.mock("../db/index.js", async () => {
  const helper = await import("./test-support/fake-idempotency-db.js");
  const instance = helper.createFakeIdempotencyDb();
  helper.current.instance = instance;
  return { db: instance.db, schema: {} };
});

import {
  IdempotencyStore,
  IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_CLEANUP_INTERVAL_MS,
  computeFingerprint,
  stableSerialize,
} from "./idempotency-store.js";

function fakeDb(): FakeIdempotencyDb {
  const instance = fakeDbHolder.instance;
  if (!instance) throw new Error("fake idempotency db not initialised");
  return instance;
}

const ROUTE = "global:127.0.0.1";
const KEY = "checkout_2026-07-30";

function fingerprint(body: unknown): string {
  return computeFingerprint(body);
}

describe("IdempotencyStore", () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    fakeDb().reset();
    store = new IdempotencyStore();
  });

  describe("claim — first request wins", () => {
    it("claims a brand-new key and stores an in_progress record", async () => {
      const result = await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }));

      expect(result).toEqual({ outcome: "claimed" });
      const row = fakeDb().get(ROUTE, KEY);
      expect(row).toBeDefined();
      expect(row!.status).toBe("in_progress");
      expect(row!.statusCode).toBeNull();
      expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(row!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(IDEMPOTENCY_TTL_MS);
    });

    it("recognises a duplicate while the first request is still in flight", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(1000));

      const second = await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(2000));
      expect(second).toEqual({ outcome: "in_progress" });
    });
  });

  describe("replay / conflict after completion", () => {
    it("replays the stored response when the fingerprint matches", async () => {
      const now = new Date(1000);
      await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), now);
      await store.complete(ROUTE, KEY, 201, { id: "order-1", amount: "10" });

      const replay = await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(2000));
      expect(replay).toEqual({
        outcome: "replay",
        statusCode: 201,
        responseBody: { id: "order-1", amount: "10" },
      });
    });

    it("replays with a default 200 status when the stored status code is null", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), new Date(1000));
      await store.complete(ROUTE, KEY, 201, { ok: true });
      // Defensive fallback: a completed row whose status_code is unexpectedly
      // NULL is replayed with a 200 rather than crashing the replay path.
      fakeDb().get(ROUTE, KEY)!.statusCode = null;

      const replay = await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), new Date(2000));
      expect(replay).toEqual({ outcome: "replay", statusCode: 200, responseBody: { ok: true } });
    });

    it("replays rate-limit 429 responses too", async () => {
      await store.claim(ROUTE, KEY, fingerprint({}), new Date(1000));
      await store.complete(ROUTE, KEY, 429, { error: "Too many requests, please try again later." });

      const replay = await store.claim(ROUTE, KEY, fingerprint({}), new Date(2000));
      expect(replay.outcome).toBe("replay");
      expect(replay).toMatchObject({ statusCode: 429 });
    });

    it("returns conflict when the same key is reused with a different body", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(1000));
      await store.complete(ROUTE, KEY, 201, { id: "order-1" });

      const conflict = await store.claim(ROUTE, KEY, fingerprint({ amount: "999" }), new Date(2000));
      expect(conflict).toEqual({ outcome: "conflict" });
    });

    it("ignores object key ordering when comparing fingerprints", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ a: 1, b: 2 }), new Date(1000));
      await store.complete(ROUTE, KEY, 200, { ok: true });

      const replay = await store.claim(ROUTE, KEY, fingerprint({ b: 2, a: 1 }), new Date(2000));
      expect(replay.outcome).toBe("replay");
    });
  });

  describe("failure / retry lifecycle", () => {
    it("re-claims a failed key so a transient failure does not poison retries", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(1000));
      await store.fail(ROUTE, KEY);

      // Same key, same body — retry re-claims and re-executes.
      const retry = await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(2000));
      expect(retry).toEqual({ outcome: "claimed" });
      expect(fakeDb().get(ROUTE, KEY)!.status).toBe("in_progress");
    });

    it("keeps a failed key non-replayable until it is re-claimed", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(1000));
      await store.fail(ROUTE, KEY);

      // A claim that loses the re-claim race must never be treated as replay.
      const second = await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(2000));
      expect(["claimed", "in_progress"]).toContain(second.outcome);
      expect(second.outcome).not.toBe("replay");
    });

    it("reclaims an expired in_progress record (crash recovery)", async () => {
      const claimedAt = new Date(1000);
      await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), claimedAt);

      // No completion ever happened (process crashed). After the TTL the key
      // becomes eligible again.
      const afterExpiry = new Date(claimedAt.getTime() + IDEMPOTENCY_TTL_MS + 1);
      const retry = await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), afterExpiry);
      expect(retry).toEqual({ outcome: "claimed" });
    });

    it("does not reclaim an in_progress record before its expiry", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(1000));

      const beforeExpiry = new Date(1000 + IDEMPOTENCY_TTL_MS - 1);
      const result = await store.claim(ROUTE, KEY, fingerprint({ amount: "10" }), beforeExpiry);
      expect(result).toEqual({ outcome: "in_progress" });
    });
  });

  describe("cleanup / bounded retention", () => {
    it("deletes only expired records", async () => {
      const now = new Date(1_000_000);
      const expiredExpiry = new Date(now.getTime() - 1);
      const liveExpiry = new Date(now.getTime() + 60_000);

      await store.claim("route-a", "key-expired", fingerprint({}), now, expiredExpiry);
      await store.claim("route-b", "key-live", fingerprint({}), now, liveExpiry);
      await store.complete("route-b", "key-live", 200, { ok: true });

      const deleted = await store.cleanupExpired(now);

      expect(deleted).toBe(1);
      expect(fakeDb().get("route-a", "key-expired")).toBeUndefined();
      expect(fakeDb().get("route-b", "key-live")).toBeDefined();
    });

    it("leaves an empty table untouched", async () => {
      expect(await store.cleanupExpired(new Date())).toBe(0);
    });

    it("treats a missing rowCount as zero deletions", async () => {
      await store.claim("cleanup-fallback", KEY, fingerprint({}), new Date(1000));
      fakeDb().nullRowCountNext = true;
      expect(await store.cleanupExpired(new Date(2000))).toBe(0);
    });
  });

  describe("concurrency — exactly one winner", () => {
    it("allows exactly one of ten concurrent claims to proceed", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => store.claim(ROUTE, KEY, fingerprint({ amount: "10" }))),
      );

      const claimed = results.filter((r) => r.outcome === "claimed");
      expect(claimed).toHaveLength(1);
      // Everyone else must be routed to a non-executing outcome.
      expect(results.filter((r) => r.outcome === "in_progress")).toHaveLength(9);
    });

    it("deduplicates across two independent store instances sharing one database", async () => {
      const storeA = new IdempotencyStore();
      const storeB = new IdempotencyStore();

      const first = await storeA.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(1000));
      expect(first).toEqual({ outcome: "claimed" });
      await storeA.complete(ROUTE, KEY, 200, { ok: true });

      // Instance B has no in-memory state; only the shared table knows the key.
      const second = await storeB.claim(ROUTE, KEY, fingerprint({ amount: "10" }), new Date(2000));
      expect(second).toEqual({ outcome: "replay", statusCode: 200, responseBody: { ok: true } });
    });
  });

  describe("database failure — fail closed", () => {
    it("rejects the claim when the database is unreachable", async () => {
      fakeDb().failures.push(new Error("connection refused"));

      await expect(store.claim(ROUTE, KEY, fingerprint({}))).rejects.toThrow("connection refused");
    });

    it("propagates completion-write failures to the caller", async () => {
      await store.claim(ROUTE, KEY, fingerprint({}), new Date(1000));
      fakeDb().failures.push(new Error("connection refused"));

      await expect(store.complete(ROUTE, KEY, 200, { ok: true })).rejects.toThrow(
        "connection refused",
      );
    });
  });

  describe("SQL safety", () => {
    it("never interpolates user-controlled values into SQL text", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ evil: "'; DROP TABLE idempotency_keys; --" }));

      const calls = fakeDb().calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // The SQL text is fixed; user values only appear as bound parameters.
        expect(call.sql).not.toContain("DROP TABLE");
        expect(call.sql).not.toContain("checkout_2026-07-30");
        expect(call.sql).not.toContain("127.0.0.1");
        expect(call.sql).toContain("$");
      }
      const insertCall = calls.find((c) => c.sql.includes("ON CONFLICT"));
      expect(insertCall).toBeDefined();
      expect(insertCall!.params).toEqual(
        expect.arrayContaining([ROUTE, KEY, fingerprint({ evil: "'; DROP TABLE idempotency_keys; --" })]),
      );
    });
  });

  describe("race recovery — defensive branches", () => {
    it("re-inserts when the record vanishes between conflict and read (concurrent cleanup)", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), new Date(1000));
      await store.complete(ROUTE, KEY, 200, { ok: true });

      fakeDb().vanishNextSelect = { deleteRow: true };
      const result = await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), new Date(2000));

      expect(result).toEqual({ outcome: "claimed" });
    });

    it("fails toward in_progress when re-insertion also loses the race", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), new Date(1000));

      fakeDb().vanishNextSelect = { deleteRow: false };
      const result = await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), new Date(2000));

      // The row still exists, so the retry INSERT loses; never execute twice.
      expect(result).toEqual({ outcome: "in_progress" });
    });

    it("recovers when reclaiming an expired completed record loses the race", async () => {
      const claimedAt = new Date(1000);
      const expiredExpiry = new Date(claimedAt.getTime() - 1);
      await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), claimedAt, expiredExpiry);
      await store.complete(ROUTE, KEY, 200, { ok: true });

      fakeDb().blockReclaims = 1;
      const result = await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), new Date(2000));

      // First reclaim lost; the re-read sees the same state and the retry wins.
      expect(result.outcome).toBe("claimed");
    });

    it("recovers when reclaiming an expired in_progress record loses the race", async () => {
      const claimedAt = new Date(1000);
      const expiredExpiry = new Date(claimedAt.getTime() - 1);
      await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), claimedAt, expiredExpiry);

      fakeDb().blockReclaims = 1;
      const result = await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), new Date(2000));

      expect(result.outcome).toBe("claimed");
    });

    it("gives up after repeated reclaim races and fails toward in_progress", async () => {
      await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), new Date(1000));
      await store.fail(ROUTE, KEY);

      // Every reclaim attempt loses (simulating continuous contention); the
      // store must give up and refuse to execute rather than loop forever.
      fakeDb().blockReclaims = 4;
      const result = await store.claim(ROUTE, KEY, fingerprint({ a: 1 }), new Date(2000));

      expect(result).toEqual({ outcome: "in_progress" });
    });
  });

  describe("startCleanup / stopCleanup", () => {
    it("schedules a periodic expired-record sweep and is idempotent", () => {
      vi.useFakeTimers();
      try {
        const timerStore = new IdempotencyStore();
        timerStore.startCleanup();
        timerStore.startCleanup(); // second call is a no-op
        expect(vi.getTimerCount()).toBe(1);
        timerStore.stopCleanup();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("sweeps expired records on the interval and logs sweep failures", async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const sweepStore = new IdempotencyStore();
        await sweepStore.claim("sweep", KEY, fingerprint({ a: 1 }), new Date(1000));
        fakeDb().get("sweep", KEY)!.expiresAt = new Date(0); // expire it

        await vi.advanceTimersByTimeAsync(IDEMPOTENCY_CLEANUP_INTERVAL_MS);
        expect(fakeDb().get("sweep", KEY)).toBeUndefined();

        // A failing sweep logs but does not crash the interval.
        fakeDb().failures.push(new Error("db down"));
        await vi.advanceTimersByTimeAsync(IDEMPOTENCY_CLEANUP_INTERVAL_MS);
        expect(errorSpy).toHaveBeenCalledWith(
          "[idempotency-store] periodic cleanup failed",
          expect.objectContaining({ error: "db down" }),
        );

        // A non-Error rejection is still logged safely.
        fakeDb().failures.push("raw failure string");
        await vi.advanceTimersByTimeAsync(IDEMPOTENCY_CLEANUP_INTERVAL_MS);
        expect(errorSpy).toHaveBeenCalledWith(
          "[idempotency-store] periodic cleanup failed",
          expect.objectContaining({ error: "raw failure string" }),
        );
      } finally {
        vi.useRealTimers();
        errorSpy.mockRestore();
      }
    });
  });
});

describe("stableSerialize / computeFingerprint", () => {
  it("produces deterministic output regardless of object key order", () => {
    expect(stableSerialize({ a: 1, b: 2 })).toBe(stableSerialize({ b: 2, a: 1 }));
    expect(computeFingerprint({ a: 1, b: 2 })).toBe(computeFingerprint({ b: 2, a: 1 }));
  });

  it("produces a stable hex digest of fixed length", () => {
    const digest = computeFingerprint({ amount: "10", currency: "USD" });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes materially different payloads", () => {
    expect(computeFingerprint({ amount: "10" })).not.toBe(computeFingerprint({ amount: "11" }));
  });

  it("serialises primitives, null, undefined, arrays, and nested objects", () => {
    expect(stableSerialize(null)).toBe("null");
    expect(stableSerialize(undefined)).toBe("undefined");
    expect(stableSerialize("a")).toBe('"a"');
    expect(stableSerialize(42)).toBe("42");
    expect(stableSerialize(true)).toBe("true");
    expect(stableSerialize([1, "a", { b: 2 }])).toBe(`[1,"a",{"b":2}]`);
    expect(stableSerialize({ list: [1, 2] })).toBe(`{"list":[1,2]}`);
  });

  it("falls back to String() for non-object, non-primitive values", () => {
    const fn = () => 1;
    expect(stableSerialize(fn)).toBe(String(fn));
    expect(stableSerialize(Symbol("s"))).toBe(String(Symbol("s")));
  });
});

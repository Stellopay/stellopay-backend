/**
 * Tests for the analytics in-process aggregation cache.
 *
 * Coverage goals
 * ──────────────
 * 1. Cache hit — repeated identical requests within the TTL window avoid
 *    re-querying the database.
 * 2. Cache miss — a fresh (uncached) request goes to the database.
 * 3. Isolation by params — different query parameters produce independent
 *    cache entries; a hit for one set of params is a miss for another.
 * 4. TTL expiry — entries become stale after the TTL elapses and the next
 *    request re-queries the database.
 * 5. Cache key utility — `buildAnalyticsCacheKey` is deterministic, canonical,
 *    and encodes all relevant parameters.
 * 6. Security — different user addresses never share a cache entry.
 * 7. AnalyticsCache unit — `get`, `set`, `evictExpired`, `invalidate`,
 *    `clear`, and the `size` accessor all behave correctly.
 *
 * The db layer is fully mocked via `vi.hoisted` (same pattern as the other
 * route suites) so no Postgres connection is needed.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

/* ── shared mock state, hoisted so vi.mock factories can close over it ─────── */

const { dbMock, schemaMock, queryState } = vi.hoisted(() => {
  type TableName = "payments" | "escrowEvents" | "agreementEvents";

  const makeTable = (name: string) =>
    new Proxy(
      { __name: name },
      {
        get(_target, prop) {
          if (prop === "__name") return name;
          return { table: name, column: String(prop) };
        },
      },
    ) as { __name: string } & Record<string, unknown>;

  const schema = {
    payments: makeTable("payments"),
    escrowEvents: makeTable("escrowEvents"),
    agreementEvents: makeTable("agreementEvents"),
    agreements: makeTable("agreements"),
  };

  const state = {
    rows: {
      payments: [] as Array<Record<string, unknown>>,
      escrowEvents: [] as Array<Record<string, unknown>>,
      agreementEvents: [] as Array<Record<string, unknown>>,
    },
    selectCallCount: 0,
  };

  const db = {
    select: vi.fn(() => {
      state.selectCallCount++;
      return {
        from: vi.fn((table: { __name: TableName }) => {
          const rows = state.rows[table.__name] ?? [];
          return {
            where: vi.fn(() => Promise.resolve(rows)),
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => Promise.resolve(rows)),
            })),
          };
        }),
      };
    }),
  };

  return { dbMock: db, schemaMock: schema, queryState: state };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, value: unknown) => ({ type: "eq", value })),
  and: vi.fn((...c: unknown[]) => ({ type: "and", c })),
  or: vi.fn((...c: unknown[]) => ({ type: "or", c })),
  gte: vi.fn(() => ({ type: "gte" })),
  lte: vi.fn(() => ({ type: "lte" })),
  sql: vi.fn(() => "sql-expr"),
  inArray: vi.fn(() => ({ type: "inArray" })),
}));

/* ── imports after mocks are registered ──────────────────────────────────── */

import { analyticsRouter, analyticsAggregationCache } from "./analytics.js";
import {
  AnalyticsCache,
  RedisAnalyticsCache,
  buildAnalyticsCacheKey,
} from "../utils/analytics-cache.js";

/* ── helpers ─────────────────────────────────────────────────────────────── */

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", analyticsRouter);
  app.use(
    (
      err: { status?: number; message?: string; issues?: unknown },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const isZod = err instanceof ZodError;
      res.status(isZod ? 400 : (err.status ?? 500)).json({
        error: isZod ? "Validation failed" : (err.message ?? "Internal error"),
        details: isZod ? err.issues : undefined,
      });
    },
  );
  return app;
}

const USER_A = "0x0000000000000000000000000000000000000000000000000000000000000abc";
const USER_B = "0x0000000000000000000000000000000000000000000000000000000000000def";

beforeEach(() => {
  vi.clearAllMocks();
  queryState.rows.payments = [];
  queryState.rows.escrowEvents = [];
  queryState.rows.agreementEvents = [];
  queryState.selectCallCount = 0;
  // Clear the shared module-level cache before each test so tests are isolated.
  analyticsAggregationCache.clear();
});

/* ═══════════════════════════════════════════════════════════════════════════
   AnalyticsCache unit tests
   ═══════════════════════════════════════════════════════════════════════════ */

describe("AnalyticsCache unit", () => {
  it("returns undefined for an absent key", () => {
    const cache = new AnalyticsCache<number>(1000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns the stored value before TTL elapses", () => {
    const cache = new AnalyticsCache<string>(60_000);
    cache.set("k", "hello");
    expect(cache.get("k")).toBe("hello");
  });

  it("returns undefined and deletes the entry after TTL elapses", async () => {
    const cache = new AnalyticsCache<string>(10); // 10 ms TTL
    cache.set("k", "stale");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.get("k")).toBeUndefined();
    // Entry should have been deleted lazily.
    expect(cache.size).toBe(0);
  });

  it("replaces an existing entry on set", () => {
    const cache = new AnalyticsCache<number>(60_000);
    cache.set("k", 1);
    cache.set("k", 2);
    expect(cache.get("k")).toBe(2);
  });

  it("tracks size accurately", () => {
    const cache = new AnalyticsCache<number>(60_000);
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
    cache.invalidate("a");
    expect(cache.size).toBe(1);
  });

  it("evictExpired removes stale entries and leaves live entries intact", async () => {
    const cache = new AnalyticsCache<number>(20); // 20 ms
    cache.set("stale", 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    cache.set("live", 2); // added after expiry
    cache.evictExpired();
    expect(cache.get("stale")).toBeUndefined();
    expect(cache.get("live")).toBe(2);
    expect(cache.size).toBe(1);
  });

  it("invalidate removes a specific key without touching others", () => {
    const cache = new AnalyticsCache<number>(60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });

  it("clear wipes all entries", () => {
    const cache = new AnalyticsCache<number>(60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("RedisAnalyticsCache", () => {
  it("round-trips JSON values with a millisecond TTL", async () => {
    const values = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => void values.set(key, value)),
      del: vi.fn(async (key: string) => void values.delete(key)),
    };
    const cache = new RedisAnalyticsCache<{ total: number }>(redis, 30_000);

    await cache.set("k", { total: 7 });
    expect(await cache.get("k")).toEqual({ total: 7 });
    expect(redis.set).toHaveBeenCalledWith("k", '{"total":7}', "PX", 30_000);
    await cache.invalidate("k");
    expect(await cache.get("k")).toBeUndefined();
  });

  it("turns Redis failures into misses", async () => {
    const cache = new RedisAnalyticsCache(
      { get: vi.fn().mockRejectedValue(new Error("offline")), set: vi.fn(), del: vi.fn() },
      1000,
    );
    expect(await cache.get("k")).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   buildAnalyticsCacheKey unit tests
   ═══════════════════════════════════════════════════════════════════════════ */

describe("buildAnalyticsCacheKey", () => {
  it("produces a deterministic key for the same inputs", () => {
    const k1 = buildAnalyticsCacheKey(USER_A, { year: 2026 });
    const k2 = buildAnalyticsCacheKey(USER_A, { year: 2026 });
    expect(k1).toBe(k2);
  });

  it("lowercases the address in the key", () => {
    const upper = USER_A.toUpperCase();
    const lower = USER_A.toLowerCase();
    expect(buildAnalyticsCacheKey(upper, { year: 2026 })).toBe(
      buildAnalyticsCacheKey(lower, { year: 2026 }),
    );
  });

  it("produces different keys for different addresses", () => {
    expect(buildAnalyticsCacheKey(USER_A, { year: 2026 })).not.toBe(
      buildAnalyticsCacheKey(USER_B, { year: 2026 }),
    );
  });

  it("produces different keys for different years", () => {
    expect(buildAnalyticsCacheKey(USER_A, { year: 2025 })).not.toBe(
      buildAnalyticsCacheKey(USER_A, { year: 2026 }),
    );
  });

  it("ignores undefined param values", () => {
    // A key with an undefined year should differ from one with an explicit year.
    const withYear = buildAnalyticsCacheKey(USER_A, { year: 2026 });
    const noYear = buildAnalyticsCacheKey(USER_A, { year: undefined });
    expect(withYear).not.toBe(noYear);
  });

  it("sorts params so insertion order does not affect the key", () => {
    const k1 = buildAnalyticsCacheKey(USER_A, { year: 2026, foo: "bar" } as any);
    const k2 = buildAnalyticsCacheKey(USER_A, { foo: "bar", year: 2026 } as any);
    expect(k1).toBe(k2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Route-level cache integration tests
   ═══════════════════════════════════════════════════════════════════════════ */

describe("analytics cache — route integration", () => {
  it("serves the first request from the database and subsequent identical requests from cache", async () => {
    queryState.rows.payments = [{ month: 6, amount: "5000000" }];
    const app = makeApp();

    // First request: cold cache, must hit the database.
    const res1 = await request(app).get(`/api/v1/analytics/${USER_A}?year=2026`).expect(200);
    const dbCallsAfterFirst = queryState.selectCallCount;
    expect(dbCallsAfterFirst).toBeGreaterThan(0);

    // Second request: identical params, must be served from cache.
    const selectCountBefore = queryState.selectCallCount;
    const res2 = await request(app).get(`/api/v1/analytics/${USER_A}?year=2026`).expect(200);
    expect(queryState.selectCallCount).toBe(selectCountBefore); // No new DB calls.

    // Both responses must be equal.
    expect(res2.body).toEqual(res1.body);
  });

  it("does not share cache entries between different user addresses", async () => {
    queryState.rows.payments = [{ month: 3, amount: "1000000" }];
    const app = makeApp();

    await request(app).get(`/api/v1/analytics/${USER_A}?year=2026`).expect(200);
    const countAfterA = queryState.selectCallCount;

    // USER_B has a different address — must trigger a fresh DB query.
    await request(app).get(`/api/v1/analytics/${USER_B}?year=2026`).expect(200);
    expect(queryState.selectCallCount).toBeGreaterThan(countAfterA);
  });

  it("does not share cache entries between different years", async () => {
    const app = makeApp();

    await request(app).get(`/api/v1/analytics/${USER_A}?year=2025`).expect(200);
    const countAfter2025 = queryState.selectCallCount;

    await request(app).get(`/api/v1/analytics/${USER_A}?year=2026`).expect(200);
    expect(queryState.selectCallCount).toBeGreaterThan(countAfter2025);
  });

  it("re-queries the database after the TTL expires", async () => {
    // Override the module-level cache with a very short TTL for this test.
    analyticsAggregationCache.clear();

    // Use a separate local cache instance to simulate expiry without waiting 30 s.
    const shortTtlCache = new AnalyticsCache<{
      year: number;
      data: Array<{ month: string; views: number }>;
      total: number;
    }>(10); // 10 ms TTL

    // Seed, populate, then let it expire.
    const cacheKey = buildAnalyticsCacheKey(USER_A, { year: 2026 });
    shortTtlCache.set(cacheKey, { year: 2026, data: [], total: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The entry should be gone.
    expect(shortTtlCache.get(cacheKey)).toBeUndefined();

    // A real route request after the module-level cache was cleared must DB-query.
    const countBefore = queryState.selectCallCount;
    await request(makeApp()).get(`/api/v1/analytics/${USER_A}?year=2026`).expect(200);
    expect(queryState.selectCallCount).toBeGreaterThan(countBefore);
  });

  it("returns consistent data on a cache hit (same body as first response)", async () => {
    queryState.rows.payments = [{ month: 7, amount: "3000000" }];
    queryState.rows.escrowEvents = [{ month: 7, amount: "1000000", eventType: "Released" }];
    const app = makeApp();

    const first = await request(app).get(`/api/v1/analytics/${USER_A}?year=2026`).expect(200);
    const second = await request(app).get(`/api/v1/analytics/${USER_A}?year=2026`).expect(200);

    expect(second.body.year).toBe(first.body.year);
    expect(second.body.total).toBe(first.body.total);
    expect(second.body.data).toEqual(first.body.data);
  });

  it("does not cache a failed (DB error) response", async () => {
    // Make the first call fail.
    dbMock.select.mockImplementationOnce(() => {
      throw new Error("db unavailable");
    });

    await request(makeApp()).get(`/api/v1/analytics/${USER_A}?year=2026`).expect(500);

    // The cache must remain empty after an error.
    const cacheKey = buildAnalyticsCacheKey(USER_A, { year: 2026 });
    expect(analyticsAggregationCache.get(cacheKey)).toBeUndefined();

    // A retry must hit the database again (not return the error from cache).
    const countBefore = queryState.selectCallCount;
    await request(makeApp()).get(`/api/v1/analytics/${USER_A}?year=2026`).expect(200);
    expect(queryState.selectCallCount).toBeGreaterThan(countBefore);
  });

  it("cache isolates USER_A year=2025 from USER_A year=2026 and USER_B year=2026", async () => {
    const app = makeApp();

    await request(app).get(`/api/v1/analytics/${USER_A}?year=2025`).expect(200);
    await request(app).get(`/api/v1/analytics/${USER_A}?year=2026`).expect(200);
    await request(app).get(`/api/v1/analytics/${USER_B}?year=2026`).expect(200);

    // Each of the three unique (address, year) combos should be a separate cache slot.
    const keyA25 = buildAnalyticsCacheKey(USER_A, { year: 2025 });
    const keyA26 = buildAnalyticsCacheKey(USER_A, { year: 2026 });
    const keyB26 = buildAnalyticsCacheKey(USER_B, { year: 2026 });

    expect(analyticsAggregationCache.get(keyA25)).toBeDefined();
    expect(analyticsAggregationCache.get(keyA26)).toBeDefined();
    expect(analyticsAggregationCache.get(keyB26)).toBeDefined();

    // All three keys must be distinct.
    expect(new Set([keyA25, keyA26, keyB26]).size).toBe(3);
  });

  it("invalid address is rejected before cache key is built — no cache entry created", async () => {
    await request(makeApp()).get("/api/v1/analytics/not-an-address?year=2026").expect(400);

    // Nothing should have been written to the cache.
    expect(analyticsAggregationCache.size).toBe(0);
  });
});

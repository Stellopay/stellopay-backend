import express from "express";
import request from "supertest";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Store, ClientRateLimitInfo } from "express-rate-limit";

import {
  makeLimiter,
  keyByIp,
  retryAfterSeconds,
  getIdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
  X_IDEMPOTENT_REPLAYED_HEADER,
} from "./rate-limit";

/**
 * Minimal in-memory `Store` for asserting distributed wiring. Each instance
 * wraps a *shared* backing `Map` passed into its constructor, so two
 * independent `FakeSharedStore` instances (one per limiter/"replica") pool
 * counts through that shared backend — mirroring how two RedisStore
 * instances in separate processes pool counts through one Redis, without
 * tripping express-rate-limit's "don't reuse a single store instance across
 * limiters" validation (which is about sharing one *object*, not one
 * *backend*).
 */
class FakeSharedStore implements Store {
  constructor(private readonly backing: Map<string, number>) {}

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const totalHits = (this.backing.get(key) ?? 0) + 1;
    this.backing.set(key, totalHits);
    return { totalHits, resetTime: undefined };
  }

  async decrement(key: string): Promise<void> {
    this.backing.set(key, Math.max(0, (this.backing.get(key) ?? 0) - 1));
  }

  async resetKey(key: string): Promise<void> {
    this.backing.delete(key);
  }
}

/** A `Store` whose `increment` always rejects, simulating a backend outage. */
class ThrowingStore implements Store {
  async increment(): Promise<ClientRateLimitInfo> {
    throw new Error("simulated store outage");
  }
  async decrement(): Promise<void> {}
  async resetKey(): Promise<void> {}
}

/**
 * Build a minimal app that mounts the given limiter on `/api` and exposes a
 * route that always succeeds when not throttled.
 */
function makeApp(limiter: express.RequestHandler) {
  const app = express();
  // Mirror production: trust the first proxy so X-Forwarded-For is honoured.
  app.set("trust proxy", 1);
  app.use("/api", limiter);
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeLimiter", () => {
  it("returns a usable Express middleware function", () => {
    const limiter = makeLimiter({ name: "test", windowMs: 1000, max: 5 });
    expect(typeof limiter).toBe("function");
  });

  it("allows requests up to max, then returns the 429 envelope", async () => {
    const max = 3;
    const message = "Too many requests, please try again later.";
    const app = makeApp(makeLimiter({ name: "global", windowMs: 60_000, max, message }));

    // First `max` requests succeed.
    for (let i = 0; i < max; i++) {
      const res = await request(app).get("/api/ping");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }

    // The next request exceeds the limit and is rejected with the envelope.
    const blocked = await request(app).get("/api/ping");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: message });
    expect(blocked.headers["content-type"]).toMatch(/application\/json/);
  });

  it("uses the default message when none is supplied", async () => {
    const app = makeApp(makeLimiter({ name: "default", windowMs: 60_000, max: 1 }));

    await request(app).get("/api/ping").expect(200);
    const blocked = await request(app).get("/api/ping");

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Too many requests, please try again later." });
  });

  it("respects a configured window/max independently per limiter", async () => {
    // Two limiters with different maxes mounted on separate apps must not
    // share state and must each enforce their own configured max.
    const looseApp = makeApp(makeLimiter({ name: "loose", windowMs: 60_000, max: 5 }));
    const tightApp = makeApp(makeLimiter({ name: "tight", windowMs: 60_000, max: 1 }));

    // tight: 1 ok then 429.
    await request(tightApp).get("/api/ping").expect(200);
    await request(tightApp).get("/api/ping").expect(429);

    // loose: still serving after the tight limiter is exhausted.
    for (let i = 0; i < 5; i++) {
      await request(looseApp).get("/api/ping").expect(200);
    }
    await request(looseApp).get("/api/ping").expect(429);
  });

  it("honours a skip predicate (e.g. health checks are never throttled)", async () => {
    const app = express();
    const limiter = makeLimiter({
      name: "skip",
      windowMs: 60_000,
      max: 1,
      skip: (req) => req.path === "/health",
    });
    // Mount globally so /health flows through the limiter but is skipped.
    app.use(limiter);
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    // /health is exempt no matter how many times it is hit.
    for (let i = 0; i < 5; i++) {
      await request(app).get("/health").expect(200);
    }

    // A counted route still throttles after max.
    await request(app).get("/ping").expect(200);
    await request(app).get("/ping").expect(429);
  });

  it("does not emit legacy or standard rate-limit headers", async () => {
    const app = makeApp(makeLimiter({ name: "headers", windowMs: 60_000, max: 5 }));
    const res = await request(app).get("/api/ping");

    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Retry-After header
  // ---------------------------------------------------------------------------

  it("sends a Retry-After header on every 429 response", async () => {
    const windowMs = 60_000;
    const app = makeApp(makeLimiter({ name: "retry-after", windowMs, max: 1 }));

    await request(app).get("/api/ping").expect(200);
    const blocked = await request(app).get("/api/ping");

    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    // Value must be a positive integer string.
    const value = Number(blocked.headers["retry-after"]);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(1);
  });

  it("does not send Retry-After on allowed (non-429) responses", async () => {
    const app = makeApp(makeLimiter({ name: "no-retry-header", windowMs: 60_000, max: 5 }));
    const res = await request(app).get("/api/ping").expect(200);
    expect(res.headers["retry-after"]).toBeUndefined();
  });

  it("sets Retry-After to the ceiling of windowMs / 1000", async () => {
    // windowMs = 90_000 ms → 90 s
    const windowMs = 90_000;
    const app = makeApp(makeLimiter({ name: "retry-after-value", windowMs, max: 1 }));

    await request(app).get("/api/ping").expect(200);
    const blocked = await request(app).get("/api/ping").expect(429);

    expect(Number(blocked.headers["retry-after"])).toBe(90);
  });

  // ---------------------------------------------------------------------------
  // Observability: log on limit reached
  // ---------------------------------------------------------------------------

  it("logs a warning when the limit is reached", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = makeApp(makeLimiter({ name: "observable", windowMs: 60_000, max: 1 }));

    await request(app).get("/api/ping").expect(200);
    await request(app).get("/api/ping").expect(429);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('limiter="observable"'),
    );
  });

  it("does not log a warning on allowed requests", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = makeApp(makeLimiter({ name: "no-warn", windowMs: 60_000, max: 5 }));

    await request(app).get("/api/ping").expect(200);

    // The warn spy may have been called by keyByIp for an unresolved IP,
    // but must NOT have been called with the limit-reached message.
    const limitWarnings = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes("limit reached"),
    );
    expect(limitWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// keyByIp
// ---------------------------------------------------------------------------

describe("keyByIp", () => {
  it("returns req.ip when present", () => {
    expect(keyByIp({ ip: "203.0.113.7" } as express.Request)).toBe("203.0.113.7");
  });

  it("passes keyByIp itself as express-rate-limit's keyGenerator, not a re-implementation", async () => {
    // Regression guard for the historical bug: makeLimiter used to
    // re-implement the "unknown" fallback/warn logic inline instead of
    // reusing keyByIp, so the two could silently drift apart. Intercepting
    // the express-rate-limit call and asserting reference identity proves a
    // single implementation is now in play.
    vi.resetModules();
    let capturedOptions: { keyGenerator?: unknown } | undefined;
    vi.doMock("express-rate-limit", async () => {
      const actual = await vi.importActual<typeof import("express-rate-limit")>(
        "express-rate-limit",
      );
      return {
        ...actual,
        default: (options: { keyGenerator?: unknown }) => {
          capturedOptions = options;
          return actual.default(options);
        },
      };
    });

    try {
      const mod = await import("./rate-limit");
      mod.makeLimiter({ name: "capture", windowMs: 1000, max: 5 });
      expect(capturedOptions?.keyGenerator).toBe(mod.keyByIp);
    } finally {
      vi.doUnmock("express-rate-limit");
      vi.resetModules();
    }
  });

  it("falls back to 'unknown' when the IP cannot be resolved", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const key = keyByIp({ ip: undefined } as unknown as express.Request);
    expect(key).toBe("unknown");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("req.ip is undefined"));
  });

  it("emits a warn when IP is undefined so operators notice misconfigured proxy", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    keyByIp({ ip: undefined } as unknown as express.Request);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("does not warn when IP is present", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    keyByIp({ ip: "1.2.3.4" } as express.Request);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keys distinct client IPs separately (no cross-IP throttling)", async () => {
    const app = makeApp(makeLimiter({ name: "per-ip", windowMs: 60_000, max: 1 }));

    // Client A exhausts its single request.
    await request(app).get("/api/ping").set("X-Forwarded-For", "198.51.100.1").expect(200);
    await request(app).get("/api/ping").set("X-Forwarded-For", "198.51.100.1").expect(429);

    // Client B (different forwarded IP) is unaffected.
    await request(app).get("/api/ping").set("X-Forwarded-For", "198.51.100.2").expect(200);
  });
});

// ---------------------------------------------------------------------------
// store (distributed backend)
// ---------------------------------------------------------------------------

describe("makeLimiter store option", () => {
  it("success path: pools counts across independently-built limiters sharing one backend, like replicas sharing Redis", async () => {
    const backing = new Map<string, number>();
    const appA = makeApp(
      makeLimiter({ name: "replica-a", windowMs: 60_000, max: 2, store: new FakeSharedStore(backing) }),
    );
    const appB = makeApp(
      makeLimiter({ name: "replica-b", windowMs: 60_000, max: 2, store: new FakeSharedStore(backing) }),
    );

    // Two separately-built limiters ("replicas"), each with its own store
    // instance pointed at the same backing map, share the same counter for
    // the same key — exactly like two replicas behind a load balancer, each
    // with its own RedisStore instance, pooling through one Redis.
    await request(appA).get("/api/ping").expect(200); // hit 1 (via replica-a)
    await request(appB).get("/api/ping").expect(200); // hit 2 (via replica-b)
    await request(appA).get("/api/ping").expect(429); // hit 3 exceeds shared max=2
  });

  it("failure/boundary path: fails open (200, not an error) when the store throws, per the documented distributed contract", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = makeApp(
      makeLimiter({ name: "store-outage", windowMs: 60_000, max: 1, store: new ThrowingStore() }),
    );

    // Even though the store always throws, the request must be allowed
    // through (fail open) rather than surfacing a 500 — this is the
    // "passOnStoreError" contract documented for distributed deployments.
    const res = await request(app).get("/api/ping");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(errorSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// retryAfterSeconds
// ---------------------------------------------------------------------------

describe("retryAfterSeconds", () => {
  it("converts milliseconds to whole seconds (ceiling)", () => {
    expect(retryAfterSeconds(60_000)).toBe(60);
    expect(retryAfterSeconds(90_000)).toBe(90);
    expect(retryAfterSeconds(1_500)).toBe(2); // 1.5 s → ceiling → 2
  });

  it("returns at least 1 for very short windows", () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(500)).toBe(1); // 0.5 s → ceiling → 1
    expect(retryAfterSeconds(1)).toBe(1);   // sub-ms → ceiling → 1
  });

  it("handles standard window values correctly", () => {
    expect(retryAfterSeconds(15 * 60 * 1000)).toBe(900);  // 15 min
    expect(retryAfterSeconds(5 * 60 * 1000)).toBe(300);   // 5 min
    expect(retryAfterSeconds(60 * 60 * 1000)).toBe(3600); // 1 hour
  });
});

// ---------------------------------------------------------------------------
// idempotency helpers
// ---------------------------------------------------------------------------

describe("getIdempotencyKey", () => {
  it("returns the value of the Idempotency-Key header", () => {
    const req = { headers: { "idempotency-key": "key-001" } } as express.Request;
    expect(getIdempotencyKey(req)).toBe("key-001");
  });

  it("returns undefined when the header is absent", () => {
    const req = { headers: {} } as express.Request;
    expect(getIdempotencyKey(req)).toBeUndefined();
  });

  it("returns undefined when the header is an empty string", () => {
    const req = { headers: { "idempotency-key": "" } } as express.Request;
    expect(getIdempotencyKey(req)).toBeUndefined();
  });

  it("returns undefined when the header is an array (multiple values)", () => {
    const req = { headers: { "idempotency-key": ["a", "b"] } } as unknown as express.Request;
    expect(getIdempotencyKey(req)).toBeUndefined();
  });

  it("returns undefined when the header exceeds 255 characters", () => {
    const req = { headers: { "idempotency-key": "x".repeat(256) } } as express.Request;
    expect(getIdempotencyKey(req)).toBeUndefined();
  });

  it("accepts a key of exactly 255 characters", () => {
    const req = { headers: { "idempotency-key": "x".repeat(255) } } as express.Request;
    expect(getIdempotencyKey(req)).toBe("x".repeat(255));
  });
});

describe("idempotency constants", () => {
  it("exports the correct header names", () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe("Idempotency-Key");
    expect(X_IDEMPOTENT_REPLAYED_HEADER).toBe("X-Idempotent-Replayed");
  });
});

// ---------------------------------------------------------------------------
// makeLimiter with idempotent: true
// ---------------------------------------------------------------------------

describe("makeLimiter with idempotent option", () => {
  it("deduplicates requests with the same idempotency key (success path)", async () => {
    const app = makeApp(makeLimiter({ name: "idem-success", windowMs: 60_000, max: 2, idempotent: true }));

    // First request with key counts against the limit.
    const r1 = await request(app).get("/api/ping").set("Idempotency-Key", "dup-1");
    expect(r1.status).toBe(200);

    // Second request with the same key does NOT count — still allowed.
    const r2 = await request(app).get("/api/ping").set("Idempotency-Key", "dup-1");
    expect(r2.status).toBe(200);

    // A different key counts as a separate request (now at 2/2).
    const r3 = await request(app).get("/api/ping").set("Idempotency-Key", "other");
    expect(r3.status).toBe(200);

    // Next request with any key is throttled (limit reached).
    const r4 = await request(app).get("/api/ping").set("Idempotency-Key", "new-key");
    expect(r4.status).toBe(429);
  });

  it("replays a throttled outcome for a duplicate idempotency key (boundary path)", async () => {
    const app = makeApp(makeLimiter({ name: "idem-throttle", windowMs: 60_000, max: 1, idempotent: true }));

    // Exhaust the limit with key "first".
    await request(app).get("/api/ping").set("Idempotency-Key", "first").expect(200);

    // A request with a different key gets throttled (limit already exhausted).
    await request(app).get("/api/ping").set("Idempotency-Key", "doomed").expect(429);

    // Retry with the throttled key: outcome is replayed — still 429.
    const r1 = await request(app).get("/api/ping").set("Idempotency-Key", "doomed");
    expect(r1.status).toBe(429);
    expect(r1.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe("true");

    // Second retry with same key: also throttled (replayed again).
    const r2 = await request(app).get("/api/ping").set("Idempotency-Key", "doomed");
    expect(r2.status).toBe(429);
    expect(r2.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe("true");

    // A fresh key is also throttled (limit still exhausted).
    const r3 = await request(app).get("/api/ping").set("Idempotency-Key", "fresh");
    expect(r3.status).toBe(429);
  });

  it("sets X-Idempotent-Replayed on duplicate requests", async () => {
    const app = makeApp(makeLimiter({ name: "idem-header", windowMs: 60_000, max: 5, idempotent: true }));

    // First use: header absent.
    const r1 = await request(app).get("/api/ping").set("Idempotency-Key", "hdr-test");
    expect(r1.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();

    // Duplicate: header present.
    const r2 = await request(app).get("/api/ping").set("Idempotency-Key", "hdr-test");
    expect(r2.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe("true");
  });

  it("does not set X-Idempotent-Replayed when no idempotency key is present", async () => {
    const app = makeApp(makeLimiter({ name: "idem-no-header", windowMs: 60_000, max: 1, idempotent: true }));

    await request(app).get("/api/ping").expect(200);
    const r2 = await request(app).get("/api/ping").expect(429);

    expect(r2.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("preserves normal behavior when idempotent: true but no header is sent", async () => {
    const app = makeApp(makeLimiter({ name: "idem-normal", windowMs: 60_000, max: 2, idempotent: true }));

    await request(app).get("/api/ping").expect(200);
    await request(app).get("/api/ping").expect(200);
    await request(app).get("/api/ping").expect(429);
  });

  it("treats different idempotency keys as separate replay scopes", async () => {
    const app = makeApp(makeLimiter({ name: "idem-scope", windowMs: 60_000, max: 2, idempotent: true }));

    // Two unique keys each count.
    await request(app).get("/api/ping").set("Idempotency-Key", "alpha").expect(200);
    await request(app).get("/api/ping").set("Idempotency-Key", "bravo").expect(200);

    // Limit exhausted: third unique key is throttled.
    await request(app).get("/api/ping").set("Idempotency-Key", "charlie").expect(429);

    // Replay of alpha is allowed (original was allowed, and deduped).
    const replay = await request(app).get("/api/ping").set("Idempotency-Key", "alpha");
    expect(replay.status).toBe(200);
    expect(replay.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe("true");

    // Replay of charlie is throttled (original was throttled).
    const replayThrottled = await request(app).get("/api/ping").set("Idempotency-Key", "charlie");
    expect(replayThrottled.status).toBe(429);
    expect(replayThrottled.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe("true");
  });

  it("works with a shared store (distributed idempotency)", async () => {
    const backing = new Map<string, number>();
    const app = makeApp(
      makeLimiter({
        name: "idem-store",
        windowMs: 60_000,
        max: 2,
        idempotent: true,
        store: new FakeSharedStore(backing),
      }),
    );

    // First request with key "dedup".
    await request(app).get("/api/ping").set("Idempotency-Key", "dedup").expect(200);

    // Duplicate request with same key (allowed, not double-counted).
    const dup = await request(app).get("/api/ping").set("Idempotency-Key", "dedup");
    expect(dup.status).toBe(200);
    expect(dup.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe("true");

    // Another unique key.
    await request(app).get("/api/ping").set("Idempotency-Key", "unique").expect(200);

    // Limit exhausted.
    await request(app).get("/api/ping").expect(429);
  });

  it("respects the skip predicate alongside idempotency", async () => {
    const app = express();
    app.set("trust proxy", 1);
    const limiter = makeLimiter({
      name: "idem-skip",
      windowMs: 60_000,
      max: 1,
      idempotent: true,
      skip: (req) => req.path === "/health",
    });
    app.use(limiter);
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    // Skipped route is never counted.
    await request(app).get("/health").expect(200);
    await request(app).get("/health").expect(200);

    // Counted route exhausts its limit.
    await request(app).get("/ping").set("Idempotency-Key", "key-1").expect(200);

    // Duplicate key replays allowed outcome.
    await request(app).get("/ping").set("Idempotency-Key", "key-1").expect(200);
  });

  it("logs a warning on first throttling with idempotency enabled", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = makeApp(
      makeLimiter({ name: "idem-warn", windowMs: 60_000, max: 1, idempotent: true }),
    );

    await request(app).get("/api/ping").set("Idempotency-Key", "warn-test").expect(200);
    await request(app).get("/api/ping").set("Idempotency-Key", "warn-test").expect(200);

    // A fresh key that exhausts the limit must log the warning.
    await request(app).get("/api/ping").set("Idempotency-Key", "trigger").expect(429);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('limiter="idem-warn"'),
    );
  });

  it("does not log a warning when a throttled outcome is replayed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = makeApp(
      makeLimiter({ name: "idem-no-warn", windowMs: 60_000, max: 1, idempotent: true }),
    );

    // Exhaust.
    await request(app).get("/api/ping").set("Idempotency-Key", "silent").expect(200);
    await request(app).get("/api/ping").set("Idempotency-Key", "silent").expect(200);

    warnSpy.mockClear();

    // Replay of throttled key — must not log a new warning.
    // First, trigger throttling with a fresh key.
    await request(app).get("/api/ping").set("Idempotency-Key", "trigger-throttle").expect(429);

    const throttleWarningCount = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes("limit reached"),
    ).length;
    expect(throttleWarningCount).toBe(1);

    warnSpy.mockClear();

    // Replay the throttled key.
    await request(app).get("/api/ping").set("Idempotency-Key", "trigger-throttle").expect(429);

    const replayWarningCount = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes("limit reached"),
    ).length;
    expect(replayWarningCount).toBe(0);
  });
});

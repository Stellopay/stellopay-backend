// src/middleware/rate-limit.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response } from "express";
import {
  makeLimiter,
  retryAfterSeconds,
  getIdempotencyKey,
  keyByIp,
  IDEMPOTENCY_KEY_HEADER,
  RETRY_AFTER_HEADER,
  X_IDEMPOTENT_REPLAYED_HEADER,
  type RateLimitErrorBody,
  type MakeLimiterOptions,
} from "./rate-limit";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal Express app with the given limiter options. */
function buildApp(limiterOptions: MakeLimiterOptions) {
  const app = express();
  app.use(express.json());
  const limiter = makeLimiter(limiterOptions);
  app.get("/test", limiter, (_req: Request, res: Response) => {
    res.json({ success: true });
  });
  return app;
}

/** Default options reused across tests. */
const defaults: MakeLimiterOptions = {
  name: "compat-test",
  windowMs: 60_000,
  max: 5,
};

// ---------------------------------------------------------------------------
// retryAfterSeconds – pure function
// ---------------------------------------------------------------------------

describe("retryAfterSeconds", () => {
  test("returns whole seconds from milliseconds", () => {
    expect(retryAfterSeconds(60_000)).toBe(60);
  });

  test("rounds up partial seconds", () => {
    expect(retryAfterSeconds(1_500)).toBe(2);
  });

  test("clamps to minimum of 1", () => {
    expect(retryAfterSeconds(500)).toBe(1);
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(-100)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getIdempotencyKey – header extraction
// ---------------------------------------------------------------------------

describe("getIdempotencyKey", () => {
  function fakeReq(headerValue?: string): Request {
    const headers: Record<string, string> = {};
    if (headerValue !== undefined) {
      headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] = headerValue;
    }
    return { headers } as unknown as Request;
  }

  test("returns a valid key", () => {
    expect(getIdempotencyKey(fakeReq("abc-123_XYZ"))).toBe("abc-123_XYZ");
  });

  test("returns undefined when header is absent", () => {
    expect(getIdempotencyKey(fakeReq())).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(getIdempotencyKey(fakeReq(""))).toBeUndefined();
  });

  test("returns undefined for keys with invalid characters", () => {
    expect(getIdempotencyKey(fakeReq("invalid key!"))).toBeUndefined();
    expect(getIdempotencyKey(fakeReq("has space"))).toBeUndefined();
    expect(getIdempotencyKey(fakeReq("semi;colon"))).toBeUndefined();
  });

  test("returns undefined for keys longer than 255 characters", () => {
    expect(getIdempotencyKey(fakeReq("a".repeat(256)))).toBeUndefined();
  });

  test("accepts exactly 255 character key", () => {
    const key = "a".repeat(255);
    expect(getIdempotencyKey(fakeReq(key))).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// keyByIp – IP key generation
// ---------------------------------------------------------------------------

describe("keyByIp", () => {
  test("returns IP when req.ip is defined", () => {
    const req = { ip: "192.168.1.1" } as unknown as Request;
    const result = keyByIp(req);
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  });

  test('falls back to "unknown" when req.ip is undefined', () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = { ip: undefined } as unknown as Request;
    expect(keyByIp(req)).toBe("unknown");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("req.ip is undefined"),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// makeLimiter – input validation
// ---------------------------------------------------------------------------

describe("makeLimiter – input validation", () => {
  test("throws on missing name", () => {
    expect(() =>
      makeLimiter({ name: "", windowMs: 1000, max: 1 }),
    ).toThrow(/"name" is required/);
  });

  test("throws on non-positive windowMs", () => {
    expect(() =>
      makeLimiter({ name: "x", windowMs: 0, max: 1 }),
    ).toThrow(/windowMs must be a positive number/);

    expect(() =>
      makeLimiter({ name: "x", windowMs: -1, max: 1 }),
    ).toThrow(/windowMs must be a positive number/);
  });

  test("throws on non-positive max", () => {
    expect(() =>
      makeLimiter({ name: "x", windowMs: 1000, max: 0 }),
    ).toThrow(/max must be a positive number/);
  });
});

// ---------------------------------------------------------------------------
// Success path – requests under limit
// ---------------------------------------------------------------------------

describe("rate-limit middleware – success path", () => {
  test("allows requests under the limit and returns 200", async () => {
    const app = buildApp({ ...defaults, max: 3 });

    const res1 = await request(app).get("/test");
    expect(res1.status).toBe(200);
    expect(res1.body).toEqual({ success: true });

    const res2 = await request(app).get("/test");
    expect(res2.status).toBe(200);
  });

  test("does not set Retry-After on successful responses", async () => {
    const app = buildApp(defaults);
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.headers[RETRY_AFTER_HEADER.toLowerCase()]).toBeUndefined();
  });

  test("does not set legacy X-RateLimit-* or draft RateLimit-* headers", async () => {
    const app = buildApp(defaults);
    const res = await request(app).get("/test");
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeUndefined();
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
    expect(res.headers["ratelimit-remaining"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Failure path – 429 response contract
// ---------------------------------------------------------------------------

describe("rate-limit middleware – 429 response contract", () => {
  test("returns 429 with correct body shape when limit is exceeded", async () => {
    const app = buildApp({ ...defaults, max: 1 });

    await request(app).get("/test"); // consume the one allowed request
    const res = await request(app).get("/test");

    expect(res.status).toBe(429);
    // Body must conform to RateLimitErrorBody
    const body: RateLimitErrorBody = res.body;
    expect(body).toHaveProperty("error");
    expect(typeof body.error).toBe("string");
  });

  test("sets Retry-After header on 429 responses", async () => {
    const app = buildApp({ ...defaults, max: 1, windowMs: 30_000 });

    await request(app).get("/test");
    const res = await request(app).get("/test");

    expect(res.status).toBe(429);
    const retryAfter = res.headers[RETRY_AFTER_HEADER.toLowerCase()];
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBe(retryAfterSeconds(30_000));
  });

  test("uses custom message in 429 body", async () => {
    const msg = "Slow down, cowboy!";
    const app = buildApp({ ...defaults, max: 1, message: msg });

    await request(app).get("/test");
    const res = await request(app).get("/test");

    expect(res.status).toBe(429);
    expect(res.body.error).toBe(msg);
  });

  test("uses default message when none provided", async () => {
    const app = buildApp({ ...defaults, max: 1 });

    await request(app).get("/test");
    const res = await request(app).get("/test");

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Too many requests, please try again later.");
  });
});

// ---------------------------------------------------------------------------
// Skip predicate
// ---------------------------------------------------------------------------

describe("rate-limit middleware – skip predicate", () => {
  test("skipped requests do not count against the limit", async () => {
    const app = buildApp({
      ...defaults,
      max: 1,
      skip: (req) => req.headers["x-skip"] === "true",
    });

    // Skipped request – does not consume a token
    const skipped = await request(app).get("/test").set("x-skip", "true");
    expect(skipped.status).toBe(200);

    // First real request – should pass
    const real1 = await request(app).get("/test");
    expect(real1.status).toBe(200);

    // Second real request – should be throttled (max=1)
    const real2 = await request(app).get("/test");
    expect(real2.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Environment-variable overrides
// ---------------------------------------------------------------------------

describe("rate-limit middleware – environment-variable overrides", () => {
  const envKey = (suffix: string) => `RATE_LIMIT_ENV_TEST_${suffix}`;

  afterEach(() => {
    delete process.env[envKey("MAX")];
    delete process.env[envKey("WINDOW_MS")];
    delete process.env[envKey("MESSAGE")];
  });

  test("RATE_LIMIT_<NAME>_MAX overrides the max option", async () => {
    process.env[envKey("MAX")] = "1";
    const app = buildApp({ name: "env-test", windowMs: 60_000, max: 100 });

    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
  });

  test("RATE_LIMIT_<NAME>_MESSAGE overrides the message", async () => {
    process.env[envKey("MESSAGE")] = "Custom env message";
    const app = buildApp({ name: "env-test", windowMs: 60_000, max: 1 });

    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("Custom env message");
  });

  test("invalid env MAX is ignored (original value used)", async () => {
    process.env[envKey("MAX")] = "not-a-number";
    const app = buildApp({ name: "env-test", windowMs: 60_000, max: 2 });

    const res1 = await request(app).get("/test");
    expect(res1.status).toBe(200);
    const res2 = await request(app).get("/test");
    expect(res2.status).toBe(200);
    // Would have been throttled if max were 1, but original max=2 stands
  });
});

// ---------------------------------------------------------------------------
// Idempotency-key deduplication
// ---------------------------------------------------------------------------

describe("rate-limit middleware – idempotency deduplication", () => {
  const idempotentDefaults: MakeLimiterOptions = {
    name: "idemp-test",
    windowMs: 60_000,
    max: 2,
    idempotent: true,
  };

  test("allows request with valid idempotency key", async () => {
    const app = buildApp(idempotentDefaults);
    const res = await request(app)
      .get("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "valid-key-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test("replays allowed outcome with X-Idempotent-Replayed header", async () => {
    const app = buildApp(idempotentDefaults);

    // First request: counted, allowed
    const first = await request(app)
      .get("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "replay-key");
    expect(first.status).toBe(200);
    expect(
      first.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()],
    ).toBeUndefined();

    // Second request with same key: replayed, NOT counted
    const second = await request(app)
      .get("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "replay-key");
    expect(second.status).toBe(200);
    expect(
      second.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()],
    ).toBe("true");
  });

  test("replayed request does not consume a rate-limit token", async () => {
    const app = buildApp({ ...idempotentDefaults, max: 1 });

    // First request: allowed, consumes the only token
    await request(app)
      .get("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "dedup-key");

    // Replay: same key, should NOT consume another token
    const replay = await request(app)
      .get("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "dedup-key");
    expect(replay.status).toBe(200);
    expect(
      replay.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()],
    ).toBe("true");
  });

  test("malformed idempotency key is ignored (no deduplication)", async () => {
    const app = buildApp(idempotentDefaults);
    const res = await request(app)
      .get("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "invalid key!");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    // No replay header because the key was discarded
    expect(
      res.headers[X_IDEMPOTENT_REPLAYED_HEADER.toLowerCase()],
    ).toBeUndefined();
  });

  test("key longer than 255 characters is ignored", async () => {
    const app = buildApp(idempotentDefaults);
    const res = await request(app)
      .get("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "a".repeat(256));
    expect(res.status).toBe(200);
  });

  test("rate limit triggers after max requests (idempotent mode)", async () => {
    const app = buildApp({ ...idempotentDefaults, max: 1 });
    await request(app).get("/test").set(IDEMPOTENCY_KEY_HEADER, "key1");
    const res = await request(app)
      .get("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "key2");
    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty("error");
    expect(
      res.headers[RETRY_AFTER_HEADER.toLowerCase()],
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Batching / cost function contract
// ---------------------------------------------------------------------------

describe("rate-limit middleware – cost function", () => {
  test("scales limit inversely to cost (proportional limiting)", async () => {
    const app = buildApp({
      name: "cost-scale",
      windowMs: 60_000,
      max: 10,
      cost: (req: Request) => Number(req.headers["x-cost"] || 1),
    });

    // Cost 5 → effective limit = floor(10/5) = 2
    let res = await request(app).get("/test").set("x-cost", "5");
    expect(res.status).toBe(200);

    res = await request(app).get("/test").set("x-cost", "5");
    expect(res.status).toBe(200);

    res = await request(app).get("/test").set("x-cost", "5");
    expect(res.status).toBe(429);
  });

  test("immediately throttles if cost exceeds max", async () => {
    const app = buildApp({
      name: "cost-exceed",
      windowMs: 60_000,
      max: 10,
      cost: () => 15,
    });

    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
  });

  test("treats zero cost as base max (no scaling)", async () => {
    const app = buildApp({
      name: "cost-zero",
      windowMs: 60_000,
      max: 2,
      cost: () => 0,
    });

    let res = await request(app).get("/test");
    expect(res.status).toBe(200);
    res = await request(app).get("/test");
    expect(res.status).toBe(200);
    res = await request(app).get("/test");
    expect(res.status).toBe(429);
  });

  test("treats negative cost as base max", async () => {
    const app = buildApp({
      name: "cost-neg",
      windowMs: 60_000,
      max: 2,
      cost: () => -1,
    });

    let res = await request(app).get("/test");
    expect(res.status).toBe(200);
    res = await request(app).get("/test");
    expect(res.status).toBe(200);
    res = await request(app).get("/test");
    expect(res.status).toBe(429);
  });

  test("cost function error falls back to base max", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = buildApp({
      name: "cost-err",
      windowMs: 60_000,
      max: 2,
      cost: () => {
        throw new Error("oops");
      },
    });

    let res = await request(app).get("/test");
    expect(res.status).toBe(200);
    res = await request(app).get("/test");
    expect(res.status).toBe(200);
    res = await request(app).get("/test");
    expect(res.status).toBe(429);

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Absurd max warning
// ---------------------------------------------------------------------------

describe("rate-limit middleware – absurd max warning", () => {
  test("warns when max exceeds 1000", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    makeLimiter({ name: "absurd", windowMs: 60_000, max: 1001 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("absurdly high max"),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Public API surface – backward compatibility
// ---------------------------------------------------------------------------

describe("rate-limit – public API surface", () => {
  test("exports expected constants", () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe("Idempotency-Key");
    expect(RETRY_AFTER_HEADER).toBe("Retry-After");
    expect(X_IDEMPOTENT_REPLAYED_HEADER).toBe("X-Idempotent-Replayed");
  });

  test("makeLimiter returns a function (Express middleware)", () => {
    const limiter = makeLimiter(defaults);
    expect(typeof limiter).toBe("function");
  });

  test("RateLimitErrorBody shape is { error: string }", () => {
    // TypeScript compile-time check; runtime assertion for documentation.
    const body: RateLimitErrorBody = { error: "test" };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(typeof body.error).toBe("string");
  });
});

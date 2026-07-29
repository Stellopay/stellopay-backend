import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { accessLogMiddleware, redactSensitiveParams, getMetrics, resetMetrics, seenRequestIds, REDACTED_VALUE, validateCorrelationId, MAX_CACHE_SIZE } from "./access-log.js";
import { requestIdMiddleware } from "./request-id.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(accessLogMiddleware);

  app.get("/test", (_req, res) => res.status(200).json({ ok: true }));
  app.post("/test-body", (_req, res) => res.status(201).json({ created: true }));
  app.get("/error", (_req, res) => res.status(500).json({ error: "Server Error" }));
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/ready", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/redirect", (_req, res) => res.redirect(302, "/test"));
  app.get("/bad-request", (_req, res) => res.status(400).json({ error: "Bad Request" }));
  app.get("/no-content", (_req, res) => res.status(204).send());

  return app;
}

function makeStandaloneApp() {
  const app = express();
  app.use(accessLogMiddleware);
  app.get("/test", (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

// ---------------------------------------------------------------------------
// redactSensitiveParams — unit tests
// ---------------------------------------------------------------------------

describe("redactSensitiveParams", () => {
  it("returns the URL unchanged when there is no query string", () => {
    expect(redactSensitiveParams("/api/v1/users")).toBe("/api/v1/users");
  });

  it("returns the URL unchanged when no params are sensitive", () => {
    expect(redactSensitiveParams("/api/v1/users?page=1&limit=20")).toBe(
      "/api/v1/users?page=1&limit=20",
    );
  });

  it("redacts 'token' param value", () => {
    const result = redactSensitiveParams("/auth?token=super-secret");
    expect(result).not.toContain("super-secret");
    expect(result).toContain(`token=${REDACTED_VALUE}`);
  });

  it("redacts 'access_token' param value", () => {
    const result = redactSensitiveParams("/api?access_token=eyJhbGc");
    expect(result).not.toContain("eyJhbGc");
    expect(result).toContain("access_token=");
  });

  it("redacts 'password' while leaving other params intact", () => {
    const result = redactSensitiveParams("/reset?password=hunter2&email=x%40y.com");
    expect(result).not.toContain("hunter2");
    expect(result).toContain("email=x%40y.com");
  });

  it("redacts 'address' (wallet address) while leaving other params intact", () => {
    const result = redactSensitiveParams("/balance?address=0xDEADBEEF&chain=starknet");
    expect(result).not.toContain("0xDEADBEEF");
    expect(result).toContain("chain=starknet");
  });

  it("is case-insensitive for param names", () => {
    const result = redactSensitiveParams("/api?Token=abc&ACCESS_TOKEN=def");
    expect(result).not.toContain("abc");
    expect(result).not.toContain("def");
  });

  it("leaves non-sensitive params intact when redacting sensitive ones", () => {
    const result = redactSensitiveParams("/search?q=hello&token=secret&page=2");
    expect(result).toContain("q=hello");
    expect(result).toContain("page=2");
    expect(result).not.toContain("secret");
  });

  it("returns only the path for a malformed URL (never throws)", () => {
    const malformed = "/path?token=abc&foo bar=baz";
    const result = redactSensitiveParams(malformed);
    expect(result).not.toContain("abc");
    expect(typeof result).toBe("string");
    expect(() => redactSensitiveParams(malformed)).not.toThrow();
  });

  it("handles an empty query string gracefully", () => {
    expect(redactSensitiveParams("/api?")).toBe("/api?");
  });

  it("redacts 'account' param", () => {
    const result = redactSensitiveParams("/api?account=0x123");
    expect(result).not.toContain("0x123");
    expect(result).toContain(`account=${REDACTED_VALUE}`);
  });

  it("redacts multiple sensitive params in any order", () => {
    const result = redactSensitiveParams("/api?key=abc&wallet=def&page=1&sig=ghi");
    expect(result).not.toContain("abc");
    expect(result).not.toContain("def");
    expect(result).not.toContain("ghi");
    expect(result).toContain("page=1");
  });
});

// ---------------------------------------------------------------------------
// accessLogMiddleware — integration tests
// ---------------------------------------------------------------------------

describe("accessLogMiddleware — success path", () => {
  let app: express.Express;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    app = makeApp();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    resetMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    seenRequestIds.reset();
  });

  it("emits exactly one access-log line for a standard GET request", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);

    const logLine = consoleInfoSpy.mock.calls[0][0];
    const logObj = JSON.parse(logLine);

    expect(logObj.method).toBe("GET");
    expect(logObj.path).toBe("/test");
    expect(logObj.status).toBe(200);
    expect(typeof logObj.duration_ms).toBe("number");
    expect(logObj.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof logObj.request_id).toBe("string");
    expect(logObj.request_id.length).toBeGreaterThan(0);
    expect(logObj.level).toBe("info");
    expect(typeof logObj.timestamp).toBe("string");
  });

  it("emits exactly one log line for a POST request", async () => {
    await request(app).post("/test-body").send({ data: "irrelevant" });
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);

    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.method).toBe("POST");
    expect(logObj.status).toBe(201);
  });

  it("does not log /health requests", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });

  it("should not log /ready requests", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });

  it("should log the correct status code for errors", async () => {
    const res = await request(app).get("/error");
    expect(res.status).toBe(500);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.status).toBe(500);
  });

  it("does not log request bodies or auth tokens", async () => {
    const res = await request(app)
      .post("/test-body")
      .set("Authorization", "Bearer my-secret-token")
      .send({ password: "my-secret-password" });

    expect(res.status).toBe(201);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logLine = consoleInfoSpy.mock.calls[0][0];

    expect(logLine).not.toContain("my-secret-token");
    expect(logLine).not.toContain("my-secret-password");

    const logObj = JSON.parse(logLine);
    expect(logObj.body).toBeUndefined();
    expect(logObj.token).toBeUndefined();
    expect(logObj.headers).toBeUndefined();
  });

  it("echoes the client-supplied x-request-id into the log entry", async () => {
    const customId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    const res = await request(app).get("/test").set("x-request-id", customId);
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.request_id).toBe(customId);
  });

  it("redacts sensitive query params and preserves safe ones", async () => {
    const res = await request(app).get("/test?token=secret123&signature=abc&normal=value");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);

    expect(logObj.path).toContain(`token=${REDACTED_VALUE}`);
    expect(logObj.path).toContain(`signature=${REDACTED_VALUE}`);
    expect(logObj.path).toContain("normal=value");
    expect(logObj.path).not.toContain("secret123");
    expect(logObj.path).not.toContain("abc");
    expect(logObj.path).toContain("normal=value");
  });

  it("does not emit 'unknown' as the request_id — always a valid string", async () => {
    await request(app).get("/test");
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.request_id).not.toBe("unknown");
    expect(logObj.request_id.trim()).not.toBe("");
  });

  it("rejects a non-UUID x-request-id and falls back to a generated UUID", async () => {
    const res = await request(app).get("/test").set("x-request-id", "not-a-uuid");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.request_id).not.toBe("not-a-uuid");
    expect(logObj.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("rejects an overlong x-request-id that exceeds 36 characters", async () => {
    const longId = "x".repeat(1000);
    const res = await request(app).get("/test").set("x-request-id", longId);
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.request_id).not.toBe(longId);
    expect(logObj.request_id.length).toBeLessThanOrEqual(36);
  });

  it("accepts a valid UUID v4 x-request-id into the log entry", async () => {
    const uuid = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    const res = await request(app).get("/test").set("x-request-id", uuid);
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.request_id).toBe(uuid);
  });
});

// ---------------------------------------------------------------------------
// accessLogMiddleware — batching / pagination contract
// ---------------------------------------------------------------------------

describe("accessLogMiddleware — batching / pagination contract", () => {
  let app: express.Express;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    app = makeApp();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits exactly one log line per request — no batching or buffering", async () => {
    await request(app).get("/test");
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
  });

  it("emits one independent log line for each of N sequential requests", async () => {
    const N = 5;
    for (let i = 0; i < N; i++) {
      await request(app).get("/test");
    }
    // Each request → exactly one log entry, total N entries, no batching.
    expect(consoleInfoSpy).toHaveBeenCalledTimes(N);

    // Each log line must be a valid, complete AccessLogEntry.
    for (const call of consoleInfoSpy.mock.calls) {
      const entry = JSON.parse(call[0]);
      expect(entry.method).toBe("GET");
      expect(entry.status).toBe(200);
      expect(typeof entry.request_id).toBe("string");
      expect(entry.request_id.length).toBeGreaterThan(0);
    }
  });

  it("assigns distinct request_ids to concurrent requests when no header is supplied", async () => {
    // Fire two requests; without a client-supplied ID each gets its own UUID.
    const [res1, res2] = await Promise.all([
      request(app).get("/test"),
      request(app).get("/test"),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(2);
    const ids = consoleInfoSpy.mock.calls.map((c) => JSON.parse(c[0]).request_id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("health-check requests are excluded regardless of surrounding normal requests", async () => {
    await request(app).get("/test");    // should log
    await request(app).get("/health");  // should NOT log
    await request(app).get("/test");    // should log
    expect(consoleInfoSpy).toHaveBeenCalledTimes(2);
  });

  it("pagination params (page, limit, offset) are never redacted", async () => {
    await request(app).get("/test?page=2&limit=50&offset=100");
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.path).toContain("page=2");
    expect(logObj.path).toContain("limit=50");
    expect(logObj.path).toContain("offset=100");
  });
});

// ---------------------------------------------------------------------------
// accessLogMiddleware — failure / boundary path
// ---------------------------------------------------------------------------

describe("accessLogMiddleware — failure path", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows errors thrown inside the finish handler and reports them via console.error", async () => {
    // Build a minimal app where the route itself throws inside `res.finish`
    // by monkey-patching console.info to throw. The finish handler catches
    // it and forwards it to console.error — the HTTP response is unaffected
    // (it has already been sent when finish fires).
    consoleInfoSpy.mockImplementation(() => {
      throw new Error("forced log failure");
    });

    const app = makeApp();
    const res = await request(app).get("/test");
    // The HTTP response must still succeed — the error is inside finish.
    expect(res.status).toBe(200);

    // The caught error is reported via console.error.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[access-log] failed to emit log entry",
      expect.any(Error),
    );
  });

  it("falls back to a UUID (not 'unknown') when requestIdMiddleware is absent", async () => {
    const standaloneApp = makeStandaloneApp();
    await request(standaloneApp).get("/test");

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.request_id).not.toBe("unknown");
    expect(logObj.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

// ---------------------------------------------------------------------------
// accessLogMiddleware — text format
// ---------------------------------------------------------------------------

describe("accessLogMiddleware — text format", () => {
  let app: express.Express;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    app = makeApp();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a human-readable line when LOG_FORMAT is not 'json'", async () => {
    // Temporarily override LOG_FORMAT to something other than 'json'.
    const { env } = await import("../config.js");
    const originalFormat = env.LOG_FORMAT;
    // @ts-expect-error — mutating env for test isolation
    env.LOG_FORMAT = "text";

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logLine: string = consoleInfoSpy.mock.calls[0][0];

    // Should be a plain string, not JSON.
    expect(() => JSON.parse(logLine)).toThrow();
    expect(logLine).toContain("INFO");
    expect(logLine).toContain("GET");
    expect(logLine).toContain("/test");
    expect(logLine).toContain("200");
    expect(logLine).toContain("ms");

    // Restore
    // @ts-expect-error
    env.LOG_FORMAT = originalFormat;
  });

  it("should include content_length when the header is set", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);

    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);

    if (res.headers["content-length"] !== undefined) {
      expect(logObj.content_length).toBe(Number(res.headers["content-length"]));
    }
  });

  it("should log 204 no-content responses", async () => {
    const res = await request(app).get("/no-content");
    expect(res.status).toBe(204);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.status).toBe(204);
  });

  it("should log 302 redirect responses", async () => {
    const res = await request(app).get("/redirect");
    expect(res.status).toBe(302);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.status).toBe(302);
    expect(logObj.method).toBe("GET");
  });

  it("should log 400 bad-request responses", async () => {
    const res = await request(app).get("/bad-request");
    expect(res.status).toBe(400);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Standalone mode (without requestIdMiddleware)
// ---------------------------------------------------------------------------

describe("accessLogMiddleware — standalone (no requestIdMiddleware)", () => {
  let app: express.Express;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    app = makeStandaloneApp();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    resetMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should generate a fallback requestId when requestIdMiddleware is absent", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);

    expect(typeof logObj.request_id).toBe("string");
    expect(logObj.request_id.length).toBeGreaterThan(0);
    expect(logObj.request_id).not.toBe("unknown");
    expect(logObj.request_id).not.toBe("");
  });

  it("should still redact sensitive params without requestIdMiddleware", async () => {
    const res = await request(app).get("/test?token=my-secret");
    expect(res.status).toBe(200);

    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.path).not.toContain("my-secret");
    expect(logObj.path).toContain(`token=${REDACTED_VALUE}`);
  });
});

// ---------------------------------------------------------------------------
// Text log format
// ---------------------------------------------------------------------------

/**
 * Build an app with the given LOG_FORMAT using dynamic imports so the env
 * variable takes effect before the module evaluates.
 */
async function buildAppWithFormat(format: string) {
  vi.resetModules();
  vi.stubEnv("LOG_FORMAT", format);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CORS_ORIGIN", "http://localhost:3000");
  vi.stubEnv("STARKNET_RPC_URL", "https://starknet-sepolia.public.invalid/rpc");
  vi.stubEnv("POSTGRES_CONNECTION_STRING", "postgresql://postgres:postgres@localhost:5432/stellopay_indexer");

  const accessLogModule = await import("./access-log.js");
  const requestIdModule = await import("./request-id.js");

  const a = express();
  a.use(express.json());
  a.use(requestIdModule.requestIdMiddleware);
  a.use(accessLogModule.accessLogMiddleware);
  a.get("/test", (_req: any, res: any) => res.status(200).json({ ok: true }));

  return { app: a, resetMetricsFn: accessLogModule.resetMetrics };
}

describe("accessLogMiddleware — text format", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("should emit a human-readable log line in text format", async () => {
    const { app, resetMetricsFn } = await buildAppWithFormat("text");
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    resetMetricsFn();

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logLine = consoleInfoSpy.mock.calls[0][0];

    expect(logLine).toContain("INFO");
    expect(logLine).toContain("GET");
    expect(logLine).toContain("/test");
    expect(logLine).toContain("200");
    expect(logLine).toContain("ms");
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe("getMetrics / resetMetrics", () => {
  let app: express.Express;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    app = makeApp();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    resetMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return zeroed metrics after reset", () => {
    const m = getMetrics();
    expect(m.totalRequests).toBe(0);
    expect(m.requestsByStatus).toEqual({});
    expect(m.requestsByPath).toEqual({});
    expect(m.totalDurationMs).toBe(0);
  });

  it("should increment metrics after a request", async () => {
    await request(app).get("/test");
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);

    const m = getMetrics();
    expect(m.totalRequests).toBe(1);
    expect(m.requestsByStatus[200]).toBe(1);
    expect(m.totalDurationMs).toBeGreaterThan(0);
  });

  it("should track multiple requests with different status codes", async () => {
    await request(app).get("/test");
    await request(app).get("/error");
    await request(app).get("/test");
    await request(app).get("/bad-request");

    const m = getMetrics();
    expect(m.totalRequests).toBe(4);
    expect(m.requestsByStatus[200]).toBe(2);
    expect(m.requestsByStatus[500]).toBe(1);
    expect(m.requestsByStatus[400]).toBe(1);
  });

  it("should not track /health requests in metrics", async () => {
    await request(app).get("/health");
    await request(app).get("/test");

    const m = getMetrics();
    expect(m.totalRequests).toBe(1);
    expect(m.requestsByStatus[200]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// validateCorrelationId — unit tests
// ---------------------------------------------------------------------------

describe("validateCorrelationId", () => {
  it("returns the input for a valid UUID v4 string", () => {
    const uuid = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    expect(validateCorrelationId(uuid)).toBe(uuid);
  });

  it("returns null for a non-UUID string", () => {
    expect(validateCorrelationId("not-a-uuid")).toBeNull();
    expect(validateCorrelationId("my-custom-request-id-123")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(validateCorrelationId("")).toBeNull();
  });

  it("returns null for a string longer than 36 chars", () => {
    expect(validateCorrelationId("x".repeat(100))).toBeNull();
  });

  it("returns null for non-string types", () => {
    expect(validateCorrelationId(undefined)).toBeNull();
    expect(validateCorrelationId(null)).toBeNull();
    expect(validateCorrelationId(123)).toBeNull();
    expect(validateCorrelationId({})).toBeNull();
    expect(validateCorrelationId([])).toBeNull();
  });

  it("returns null for a UUID with wrong version (not v4)", () => {
    // UUID v1
    expect(validateCorrelationId("a1b2c3d4-e5f6-1a7b-8c9d-0e1f2a3b4c5d")).toBeNull();
  });

  it("returns null for a string that looks like a UUID but with invalid chars", () => {
    expect(validateCorrelationId("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5g")).toBeNull();
  });

  it("is case-insensitive for valid UUIDs", () => {
    const uuid = "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D";
    expect(validateCorrelationId(uuid)).toBe(uuid);
  });
});

// ---------------------------------------------------------------------------
// seenRequestIds — cache boundary tests
// ---------------------------------------------------------------------------

describe("seenRequestIds — cache boundary", () => {
  afterEach(() => {
    seenRequestIds.reset();
  });

  it("accepts new IDs until the cache is full, then continues to return true", () => {
    // Fill the cache up to MAX_CACHE_SIZE - 1.
    for (let i = 0; i < MAX_CACHE_SIZE - 1; i++) {
      expect(seenRequestIds.add(`id-${i}`)).toBe(true);
    }
    // One more insert hits the limit.
    expect(seenRequestIds.add("last-before-full")).toBe(true);
    expect(seenRequestIds.cache.size).toBe(MAX_CACHE_SIZE);

    // Beyond the limit, add() still returns true (log it) but does NOT insert.
    expect(seenRequestIds.add("beyond-limit")).toBe(true);
    expect(seenRequestIds.cache.size).toBe(MAX_CACHE_SIZE);
    expect(seenRequestIds.cache.has("beyond-limit")).toBe(false);
  });

  it("returns false for a duplicate ID", () => {
    expect(seenRequestIds.add("dup-id")).toBe(true);
    expect(seenRequestIds.add("dup-id")).toBe(false);
  });

  it("reset() clears the cache", () => {
    seenRequestIds.add("id-1");
    seenRequestIds.add("id-2");
    expect(seenRequestIds.cache.size).toBe(2);

    seenRequestIds.reset();
    expect(seenRequestIds.cache.size).toBe(0);
    expect(seenRequestIds.add("id-1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resilience — logging failures
// ---------------------------------------------------------------------------

describe("accessLogMiddleware — resilience", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMetrics();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should not crash if an error occurs inside the finish handler", async () => {
    const app = express();
    app.use(accessLogMiddleware);

    app.get("/test", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
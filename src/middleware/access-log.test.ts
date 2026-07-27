import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { accessLogMiddleware, redactSensitiveParams, seenRequestIds } from "./access-log.js";
import { requestIdMiddleware } from "./request-id.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Standard app: requestIdMiddleware → accessLogMiddleware → routes. */
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(accessLogMiddleware);

  app.get("/test", (_req, res) => res.status(200).json({ ok: true }));
  app.post("/test-body", (_req, res) => res.status(201).json({ created: true }));
  app.get("/error", (_req, res) => res.status(500).json({ error: "Server Error" }));
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

  return app;
}

/** Standalone app: accessLogMiddleware WITHOUT requestIdMiddleware. */
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
    expect(result).toContain("token=");
  });

  it("redacts 'access_token' param value", () => {
    const result = redactSensitiveParams("/api?access_token=eyJhbGc");
    expect(result).not.toContain("eyJhbGc");
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
    // This URL has un-encoded spaces which prevents parsing
    const malformed = "/path?token=abc&foo bar=baz";
    const result = redactSensitiveParams(malformed);
    expect(result).not.toContain("abc");
    expect(typeof result).toBe("string");
    expect(() => redactSensitiveParams(malformed)).not.toThrow();
  });

  it("handles an empty query string gracefully", () => {
    expect(redactSensitiveParams("/api?")).toBe("/api?");
  });
});

// ---------------------------------------------------------------------------
// SeenRequestIds — idempotency unit tests
// ---------------------------------------------------------------------------

describe("SeenRequestIds", () => {
  beforeEach(() => {
    seenRequestIds.reset();
  });

  afterEach(() => {
    seenRequestIds.reset();
  });

  it("returns true for a new request ID", () => {
    expect(seenRequestIds.isNew("req-001")).toBe(true);
  });

  it("returns false when the same request ID is seen again immediately", () => {
    seenRequestIds.isNew("req-001");
    expect(seenRequestIds.isNew("req-001")).toBe(false);
  });

  it("returns true for different request IDs", () => {
    expect(seenRequestIds.isNew("req-001")).toBe(true);
    expect(seenRequestIds.isNew("req-002")).toBe(true);
    expect(seenRequestIds.isNew("req-003")).toBe(true);
  });

  it("returns true for an expired ID (after TTL)", () => {
    // Mock Date.now to simulate TTL expiry
    const realNow = Date.now;
    try {
      let currentTime = 1_000_000;
      Date.now = () => currentTime;

      seenRequestIds.isNew("req-001"); // inserted at t=1_000_000

      // Advance past TTL (60_000 ms)
      currentTime += 60_001;

      expect(seenRequestIds.isNew("req-001")).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("treats expired entries as new on lookup", () => {
    const realNow = Date.now;
    try {
      let currentTime = 1_000_000;
      Date.now = () => currentTime;

      seenRequestIds.isNew("req-001"); // t=1_000_000
      seenRequestIds.isNew("req-002"); // t=1_000_000

      currentTime += 60_001; // advance past TTL

      // This insertion triggers eviction of expired entries
      seenRequestIds.isNew("req-003");

      // Both original IDs should now be expired, so they should be "new" again
      expect(seenRequestIds.isNew("req-001")).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("tracks the expected number of active entries", () => {
    expect(seenRequestIds.size).toBe(0);
    seenRequestIds.isNew("req-001");
    expect(seenRequestIds.size).toBe(1);
    seenRequestIds.isNew("req-002");
    expect(seenRequestIds.size).toBe(2);
    // Duplicate doesn't increase size
    seenRequestIds.isNew("req-001");
    expect(seenRequestIds.size).toBe(2);
  });

  it("reset clears all tracked IDs", () => {
    seenRequestIds.isNew("req-001");
    seenRequestIds.isNew("req-002");
    expect(seenRequestIds.size).toBe(2);

    seenRequestIds.reset();
    expect(seenRequestIds.size).toBe(0);
    expect(seenRequestIds.isNew("req-001")).toBe(true);
  });

  it("handles empty strings", () => {
    expect(seenRequestIds.isNew("")).toBe(true);
    expect(seenRequestIds.isNew("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// accessLogMiddleware — integration tests
// ---------------------------------------------------------------------------

describe("accessLogMiddleware", () => {
  let app: express.Express;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    app = makeApp();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    seenRequestIds.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    seenRequestIds.reset();
  });

  it("should emit exactly one access log line for a standard request", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);

    const logLine = consoleInfoSpy.mock.calls[0][0];
    const logObj = JSON.parse(logLine);

    expect(logObj.method).toBe("GET");
    expect(logObj.path).toBe("/test");
    expect(logObj.status).toBe(200);
    expect(typeof logObj.duration_ms).toBe("number");
    expect(typeof logObj.request_id).toBe("string");
    expect(logObj.request_id.length).toBeGreaterThan(0);
    expect(logObj.level).toBe("info");
  });

  it("should not log /health requests", async () => {
    const res = await request(app).get("/health");
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

  it("should not log request bodies or auth tokens", async () => {
    const res = await request(app)
      .post("/test-body")
      .set("Authorization", "Bearer my-secret-token")
      .send({ password: "my-secret-password" });

    expect(res.status).toBe(201);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logLine = consoleInfoSpy.mock.calls[0][0];

    // Ensure the sensitive data is not anywhere in the log string
    expect(logLine).not.toContain("my-secret-token");
    expect(logLine).not.toContain("my-secret-password");

    const logObj = JSON.parse(logLine);
    // Explicitly check that there's no body or token property
    expect(logObj.body).toBeUndefined();
    expect(logObj.token).toBeUndefined();
    expect(logObj.headers).toBeUndefined();
  });

  it("should use the x-request-id if provided", async () => {
    const customId = "my-custom-request-id-123";
    const res = await request(app).get("/test").set("x-request-id", customId);
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.request_id).toBe(customId);
  });

  it("should redact sensitive query parameters", async () => {
    const res = await request(app).get("/test?token=secret123&signature=abc&normal=value");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);

    // Redacted sensitive params
    expect(logObj.path).toContain("token=[redacted]");
    expect(logObj.path).toContain("signature=[redacted]");

    // Non-sensitive param should remain unchanged
    expect(logObj.path).toContain("normal=value");

    // The original secret values should not be in the log at all
    expect(logObj.path).not.toContain("secret123");
    expect(logObj.path).not.toContain("abc");
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it("should only log once when the same request ID is reused", async () => {
    const dupId = "duplicate-request-id";

    const res1 = await request(app).get("/test").set("x-request-id", dupId);
    expect(res1.status).toBe(200);

    const res2 = await request(app).get("/test").set("x-request-id", dupId);
    expect(res2.status).toBe(200);

    // Only one log line should be emitted despite two requests
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);

    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.request_id).toBe(dupId);
  });

  it("should log separately for different request IDs", async () => {
    const res1 = await request(app).get("/test").set("x-request-id", "req-a");
    expect(res1.status).toBe(200);

    const res2 = await request(app).get("/test").set("x-request-id", "req-b");
    expect(res2.status).toBe(200);

    const res3 = await request(app).get("/test").set("x-request-id", "req-c");
    expect(res3.status).toBe(200);

    // Three distinct IDs → three log lines
    expect(consoleInfoSpy).toHaveBeenCalledTimes(3);
  });

  it("should still log a second request when no request ID header is sent (UUID fallback is unique)", async () => {
    const app = makeStandaloneApp();
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    const res1 = await request(app).get("/test");
    expect(res1.status).toBe(200);

    const res2 = await request(app).get("/test");
    expect(res2.status).toBe(200);

    // Without requestIdMiddleware, each request gets a unique crypto.randomUUID()
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });

  it("should only log the first occurrence when request ID middleware is not mounted", async () => {
    // This test is important: without requestIdMiddleware, the fallback
    // generates a fresh UUID per request (always unique), so idempotency
    // doesn't suppress logs — but it also doesn't break.
    const app = makeStandaloneApp();
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);

    expect(spy).toHaveBeenCalledTimes(1);

    const logLine = spy.mock.calls[0][0];
    const logObj = JSON.parse(logLine);
    expect(typeof logObj.request_id).toBe("string");
    expect(logObj.request_id.length).toBeGreaterThan(0);

    spy.mockRestore();
  });

  // ── Boundary / error paths ───────────────────────────────────────────────

  it("should still return next() on /health without touching the seen set", async () => {
    // /health is skipped entirely — idempotency set is never consulted.
    expect(seenRequestIds.size).toBe(0);

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);

    expect(seenRequestIds.size).toBe(0);
  });

  it("should handle concurrent requests with different IDs correctly", async () => {
    const [res1, res2, res3] = await Promise.all([
      request(app).get("/test").set("x-request-id", "concurrent-a"),
      request(app).get("/test").set("x-request-id", "concurrent-b"),
      request(app).get("/test").set("x-request-id", "concurrent-c"),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);

    // Each distinct ID should produce exactly one log line
    expect(consoleInfoSpy).toHaveBeenCalledTimes(3);
  });
});

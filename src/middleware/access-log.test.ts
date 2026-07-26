import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { accessLogMiddleware, redactSensitiveParams } from "./access-log.js";
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
// accessLogMiddleware — original tests (preserved)
// ---------------------------------------------------------------------------

describe("accessLogMiddleware", () => {
  let app: express.Express;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    app = makeApp();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  // ── New: correlation ID resilience ────────────────────────────────────────

  it("falls back to a generated UUID (not 'unknown') when mounted without requestIdMiddleware", async () => {
    const standaloneApp = makeStandaloneApp();
    // need a fresh spy for the standalone app
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await request(standaloneApp).get("/test");
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(spy.mock.calls[0][0]);
    // Must be a UUID, not the old "unknown" string
    expect(logObj.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    spy.mockRestore();
  });

  it("generates a UUID request_id when no X-Request-Id header is supplied", async () => {
    await request(app).get("/test");
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  // ── New: PII redaction in logged path ─────────────────────────────────────

  it("redacts sensitive query params from the logged path", async () => {
    // The app needs a route that accepts query strings
    const appWithQuery = express();
    appWithQuery.use(express.json());
    appWithQuery.use(requestIdMiddleware);
    appWithQuery.use(accessLogMiddleware);
    appWithQuery.get("/search", (_req, res) => res.status(200).json({ ok: true }));

    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await request(appWithQuery).get("/search?q=hello&token=super-secret&page=1");
    const logObj = JSON.parse(spy.mock.calls[0][0]);
    expect(logObj.path).not.toContain("super-secret");
    expect(logObj.path).toContain("q=hello");
    expect(logObj.path).toContain("page=1");
    spy.mockRestore();
  });

  it("redacts wallet address from the logged path", async () => {
    const appWithQuery = express();
    appWithQuery.use(requestIdMiddleware);
    appWithQuery.use(accessLogMiddleware);
    appWithQuery.get("/balance", (_req, res) => res.status(200).json({ ok: true }));

    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await request(appWithQuery).get("/balance?address=0xDEADBEEF123&chain=starknet");
    const logObj = JSON.parse(spy.mock.calls[0][0]);
    expect(logObj.path).not.toContain("0xDEADBEEF123");
    expect(logObj.path).toContain("chain=starknet");
    spy.mockRestore();
  });

  // ── New: finish-handler error isolation ───────────────────────────────────

  it("does not propagate an error thrown inside the finish handler", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Make console.info throw once to simulate a serialisation failure
    consoleInfoSpy.mockImplementationOnce(() => {
      throw new Error("simulated write failure");
    });

    // The HTTP response must still complete successfully
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);

    // The error should have been swallowed and reported
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[access-log] failed to emit log entry",
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });

  // ── New: text log format ──────────────────────────────────────────────────

  it("emits a human-readable line when LOG_FORMAT is not 'json'", async () => {
    const { env } = await import("../config.js");
    const original = env.LOG_FORMAT;
    (env as any).LOG_FORMAT = "text";

    try {
      await request(app).get("/test");
      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
      const logLine = consoleInfoSpy.mock.calls[0][0] as string;
      expect(typeof logLine).toBe("string");
      expect(logLine).toContain("INFO");
      expect(logLine).toContain("GET");
      expect(logLine).toContain("/test");
      expect(logLine).toContain("200");
      expect(logLine).toMatch(/\d+(\.\d+)?ms/);
      // Must NOT be valid JSON
      expect(() => JSON.parse(logLine)).toThrow();
    } finally {
      (env as any).LOG_FORMAT = original;
    }
  });

  // ── New: duration is non-negative ─────────────────────────────────────────

  it("records a non-negative duration_ms", async () => {
    await request(app).get("/test");
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

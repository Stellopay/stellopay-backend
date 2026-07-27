import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { accessLogMiddleware, redactSensitiveParams, REDACTED_VALUE } from "./access-log.js";
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
    expect(result).toContain(`token=${encodeURIComponent(REDACTED_VALUE)}`);
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

  it("redacts all known sensitive param names", () => {
    const sensitiveNames = [
      "token",
      "access_token",
      "auth",
      "authorization",
      "secret",
      "password",
      "api_key",
      "apikey",
      "key",
      "signature",
      "sig",
      "private_key",
      "wallet",
      "address",
      "account",
    ];
    for (const name of sensitiveNames) {
      const url = `/api?${name}=SHOULD_BE_GONE&safe=keep`;
      const result = redactSensitiveParams(url);
      expect(result, `expected ${name} to be redacted`).not.toContain("SHOULD_BE_GONE");
      expect(result, `expected safe param to survive when redacting ${name}`).toContain("safe=keep");
    }
  });

  it("replaces redacted value with the exported REDACTED_VALUE constant", () => {
    // Ensures the constant and the runtime behaviour stay in sync.
    const result = redactSensitiveParams("/api?secret=my-secret");
    expect(result).toContain(encodeURIComponent(REDACTED_VALUE));
    expect(result).not.toContain("my-secret");
  });

  it("is pure — calling it multiple times on the same URL produces the same result", () => {
    const url = "/api?token=abc&page=1";
    const first = redactSensitiveParams(url);
    const second = redactSensitiveParams(url);
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// accessLogMiddleware — success path
// ---------------------------------------------------------------------------

describe("accessLogMiddleware — success path", () => {
  let app: express.Express;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    app = makeApp();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(logObj.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

  it("logs the correct status code for 5xx responses", async () => {
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
    const customId = "my-custom-request-id-123";
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
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a human-readable line when LOG_FORMAT is not 'json'", async () => {
    // Temporarily override LOG_FORMAT to something other than 'json'.
    const { env } = await import("../config.js");
    const originalFormat = env.LOG_FORMAT;
    // @ts-expect-error — mutating env for test isolation
    env.LOG_FORMAT = "text";

    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const app = makeApp();
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
});

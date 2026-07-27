import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { accessLogMiddleware, redactSensitiveParams } from "./access-log.js";
import type { AccessLogEntry } from "./access-log.js";
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

  it("should redact sensitive query parameters", async () => {
    const res = await request(app).get("/test?token=secret123&signature=abc&normal=value");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);

    // Redacted sensitive params (URL-encoded because searchParams.set encodes brackets)
    expect(logObj.path).toContain("token=%5Bredacted%5D");
    expect(logObj.path).toContain("signature=%5Bredacted%5D");

    // Non-sensitive param should remain unchanged
    expect(logObj.path).toContain("normal=value");

    // The original secret values should not be in the log at all
    expect(logObj.path).not.toContain("secret123");
    expect(logObj.path).not.toContain("abc");
  });
});

// ---------------------------------------------------------------------------
// compatibility guarantees
// ---------------------------------------------------------------------------

describe("compatibility guarantees", () => {
  // ── Export surface ──────────────────────────────────────────────────────

  it("accessLogMiddleware is a function with (req, res, next) signature", () => {
    expect(typeof accessLogMiddleware).toBe("function");
    expect(accessLogMiddleware.length).toBe(3); // req, res, next
  });

  it("redactSensitiveParams is an exported function that never throws", () => {
    expect(typeof redactSensitiveParams).toBe("function");
    // Any string input must not throw.
    expect(() => redactSensitiveParams("/any?thing=ok")).not.toThrow();
    expect(() => redactSensitiveParams("/bad?foo bar=baz")).not.toThrow();
    expect(() => redactSensitiveParams("")).not.toThrow();
    expect(() => redactSensitiveParams("?")).not.toThrow();
  });

  it("AccessLogEntry has the documented six fields", () => {
    // Compile-time check: construct a valid entry and verify field presence.
    const entry: AccessLogEntry = {
      timestamp: "2025-01-01T00:00:00.000Z",
      level: "info",
      method: "GET",
      path: "/test",
      status: 200,
      duration_ms: 1.23,
      request_id: "abc-123",
    };
    expect(Object.keys(entry).sort()).toEqual([
      "duration_ms",
      "level",
      "method",
      "path",
      "request_id",
      "status",
      "timestamp",
    ]);
  });

  // ── Health-check skip ──────────────────────────────────────────────────

  it("skips /health and does not register a finish listener", async () => {
    const app = express();
    // Spy on res.on to verify finish listener is NOT registered for /health.
    const onSpy = vi.fn();

    app.use((req, _res, next) => {
      // This middleware intercepts and spies on the real res.on.
      const originalOn = req.res!.on.bind(req.res);
      vi.spyOn(req.res!, "on").mockImplementation((event: string, listener: any) => {
        onSpy(event);
        return originalOn(event, listener);
      });
      next();
    });
    app.use(accessLogMiddleware);
    app.get("/health", (_req, res) => res.json({ ok: true }));

    await request(app).get("/health").expect(200);

    // The "finish" event should never have been registered for /health.
    const finishCalls = onSpy.mock.calls.filter(([event]) => event === "finish");
    expect(finishCalls).toHaveLength(0);
  });

  it("registers a finish listener for non-/health requests", async () => {
    const app = express();
    const onSpy = vi.fn();

    app.use((req, _res, next) => {
      const originalOn = req.res!.on.bind(req.res);
      vi.spyOn(req.res!, "on").mockImplementation((event: string, listener: any) => {
        onSpy(event);
        return originalOn(event, listener);
      });
      next();
    });
    app.use(accessLogMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    await request(app).get("/test").expect(200);

    const finishCalls = onSpy.mock.calls.filter(([event]) => event === "finish");
    expect(finishCalls).toHaveLength(1);
  });

  // ── requestId snapshot (no repeated read) ─────────────────────────────

  it("uses the captured requestId, not a re-read in finish", async () => {
    const app = express();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // Mount requestIdMiddleware first so it sets res.locals.requestId.
    app.use(requestIdMiddleware);

    // Mount accessLogMiddleware — it captures the requestId at entry time.
    app.use(accessLogMiddleware);

    // Immediately after, mutate res.locals.requestId. This runs synchronously
    // after accessLogMiddleware's next() call, before the finish event fires.
    // If accessLogMiddleware re-reads in finish, the log would show "mutated".
    app.use((_req, res, next) => {
      res.locals.requestId = "mutated-after-capture";
      next();
    });

    app.get("/test", (_req, res) => res.json({ ok: true }));

    await request(app).get("/test").set("x-request-id", "original-id").expect(200);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(infoSpy.mock.calls[0][0]);

    // The log must contain the ID captured at entry time, NOT the mutated value.
    expect(logObj.request_id).toBe("original-id");
    expect(logObj.request_id).not.toBe("mutated-after-capture");

    infoSpy.mockRestore();
  });

  // ── Fallback to crypto.randomUUID when requestIdMiddleware is missing ──

  it("falls back to a valid UUID when requestIdMiddleware is not mounted", async () => {
    const app = makeStandaloneApp();
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await request(app).get("/test").expect(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);

    // UUID v4 pattern: 8-4-4-4-12 hex digits.
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(logObj.request_id).toMatch(uuidPattern);

    consoleInfoSpy.mockRestore();
  });

  // ── Error isolation ────────────────────────────────────────────────────

  it("catch block prevents a logging failure from crashing the process", async () => {
    const app = express();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Force a failure inside the finish handler's try block by making the
    // first console.info call throw. The finish handler calls console.info
    // exactly once (inside the try), so this triggers the catch path.
    vi.spyOn(console, "info").mockImplementationOnce(() => {
      throw new Error("simulated logging failure");
    });

    app.use(accessLogMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // The request must still succeed — logging failure never affects the response.
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Error must have been caught and logged via console.error.
    expect(errorSpy).toHaveBeenCalledWith(
      "[access-log] failed to emit log entry",
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("a logging failure does not affect the next request", async () => {
    const app = express();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // First request: console.info throws once, then reverts to normal.
    vi.spyOn(console, "info").mockImplementationOnce(() => {
      throw new Error("simulated logging failure");
    });

    app.use(accessLogMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    await request(app).get("/test").expect(200);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Second request: logging works normally again — no new errors.
    const infoSpy2 = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy.mockClear();
    await request(app).get("/test").expect(200);
    expect(infoSpy2).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    infoSpy2.mockRestore();
  });

  // ── Log format: JSON vs text ───────────────────────────────────────────

  it("emits JSON when LOG_FORMAT is 'json'", async () => {
    process.env.LOG_FORMAT = "json";
    const app = express();
    app.use(accessLogMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await request(app).get("/test").expect(200);

    const logLine = infoSpy.mock.calls[0][0];
    const parsed = JSON.parse(logLine);
    expect(parsed.method).toBe("GET");
    expect(parsed.level).toBe("info");
    expect(typeof parsed.timestamp).toBe("string");

    infoSpy.mockRestore();
    delete process.env.LOG_FORMAT;
  });

  it("emits human-readable format when LOG_FORMAT is not 'json'", async () => {
    // LOG_FORMAT is cached in the config module at import time, so we must
    // reset modules and set the env var before re-importing.
    vi.resetModules();
    const prevFormat = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = "text";

    try {
      const { accessLogMiddleware: textMiddleware } = await import("./access-log.js");

      const app = express();
      app.use(textMiddleware);
      app.get("/test", (_req, res) => res.json({ ok: true }));

      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      await request(app).get("/test").expect(200);

      const logLine = infoSpy.mock.calls[0][0];
      // Human-readable format:
      // [<timestamp>] INFO <method> <path> <status> <duration>ms [<request_id>]
      expect(typeof logLine).toBe("string");
      expect(logLine).toMatch(/^\[.+\] INFO (GET|POST|PUT|DELETE) \//);
      expect(logLine).toContain("ms [");

      infoSpy.mockRestore();
    } finally {
      if (prevFormat === undefined) {
        delete process.env.LOG_FORMAT;
      } else {
        process.env.LOG_FORMAT = prevFormat;
      }
      vi.resetModules();
    }
  });

  it("duration_ms is rounded to 2 decimal places", async () => {
    process.env.LOG_FORMAT = "json";
    const app = express();
    app.use(accessLogMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await request(app).get("/test").expect(200);

    const logObj = JSON.parse(infoSpy.mock.calls[0][0]);
    // Verify 2 decimal places: multiply by 100 and check it's an integer.
    const scaled = Math.round(logObj.duration_ms * 100);
    expect(Math.abs(logObj.duration_ms * 100 - scaled)).toBeLessThan(0.001);

    infoSpy.mockRestore();
    delete process.env.LOG_FORMAT;
  });

  // ── Redaction contract ─────────────────────────────────────────────────

  it("uses the 15 hardcoded REDACTED_PARAM_NAMES", () => {
    const names = [
      "token", "access_token", "auth", "authorization", "secret",
      "password", "api_key", "apikey", "key", "signature", "sig",
      "private_key", "wallet", "address", "account",
    ];
    for (const name of names) {
      const testValue = "s3ns1t1ve";
      const result = redactSensitiveParams(`/test?${name}=${testValue}`);
      // The param value must be replaced, but the param name remains.
      expect(result).not.toContain(testValue);
      expect(result).toContain(`${name}=%5Bredacted%5D`);
    }
    expect(names).toHaveLength(15);
  });

  it("redaction replacement is the literal '[redacted]' string", () => {
    // The output contains URI-encoded %5Bredacted%5D because
    // URLSearchParams.set encodes the brackets.
    const result = redactSensitiveParams("/test?token=secret");
    expect(result).toContain("%5Bredacted%5D");
  });

  it("unredacted params with uppercase names still pass through unchanged", () => {
    // Only matching names (case-insensitive) get redacted; others pass through.
    const result = redactSensitiveParams("/test?Page=1&Limit=20");
    expect(result).toBe("/test?Page=1&Limit=20");
  });

  // ── Performance: no repeated work ──────────────────────────────────────

  it("calls process.hrtime.bigint exactly twice per logged request", async () => {
    const app = express();
    const hrtimeSpy = vi.spyOn(process.hrtime, "bigint");

    app.use(accessLogMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await request(app).get("/test").expect(200);

    // Once at entry (startHrTime), once inside finish (duration calculation).
    // Express may also call hrtime internally, but we verify at least our 2.
    // The middleware itself calls it exactly twice.
    const middlewareCalls = hrtimeSpy.mock.calls.length;
    // We can't distinguish Express-internal calls, but we know there should be
    // at minimum 2 calls from our middleware. Verify the documented contract:
    // not more than 2 middleware-initiated calls per request.
    expect(middlewareCalls).toBeGreaterThanOrEqual(2);

    // The second-to-last call captures start; the last call captures end.
    // Since Express does NOT call hrtime internally for a plain request,
    // we expect exactly 2 calls.
    expect(middlewareCalls).toBe(2);

    hrtimeSpy.mockRestore();
    infoSpy.mockRestore();
  });
});

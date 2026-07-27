import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { accessLogMiddleware, sanitiseForLog, redactSensitiveHeaders } from "./access-log.js";
import { requestIdMiddleware } from "./request-id.js";

// ---------------------------------------------------------------------------
// Unit tests for helper functions (Issue 347)
// ---------------------------------------------------------------------------

describe("sanitiseForLog", () => {
  it("strips ASCII control characters", () => {
    expect(sanitiseForLog("normal-path")).toBe("normal-path");
    expect(sanitiseForLog("path\nwith\rnewlines")).toBe("pathwithnewlines");
    expect(sanitiseForLog("path\x00with\x1Fnull")).toBe("pathwithnull");
  });

  it("preserves TAB characters", () => {
    expect(sanitiseForLog("path\twith\ttab")).toBe("path\twith\ttab");
  });

  it("decodes percent-encoded control characters before stripping", () => {
    // %0a = \n, %0d = \r, %00 = null
    expect(sanitiseForLog("/test%0a%0dInjected")).toBe("/testInjected");
    expect(sanitiseForLog("%00leading%1Fnulls")).toBe("leadingnulls");
  });

  it("handles malformed percent-encoding gracefully", () => {
    // decodeURIComponent throws on %ZZ, so the input passes through as-is
    expect(sanitiseForLog("/test%ZZpath")).toBe("/test%ZZpath");
  });

  it("truncates values exceeding MAX_PATH_LENGTH", () => {
    const long = "a".repeat(3000);
    const result = sanitiseForLog(long, 2048);
    expect(result.length).toBeLessThanOrEqual(2052); // 2048 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("replaces Unicode control characters with a placeholder", () => {
    // U+200B is a zero-width space (Cf category)
    const result = sanitiseForLog("before\u200Bafter");
    expect(result).toBe("before<\\x??>after");
  });
});

describe("redactSensitiveHeaders", () => {
  it("redacts known sensitive headers", () => {
    const headers = {
      authorization: "Bearer secret-token",
      "x-api-key": "my-api-key",
      accept: "application/json",
    };
    const result = redactSensitiveHeaders(headers);
    expect(result.authorization).toBe("[REDACTED]");
    expect(result["x-api-key"]).toBe("[REDACTED]");
    expect(result.accept).toBe("application/json");
  });

  it("redacts header values case-insensitively", () => {
    const headers = {
      Authorization: "Bearer secret",
      "X-API-KEY": "key-123",
    };
    const result = redactSensitiveHeaders(headers);
    expect(result.Authorization).toBe("[REDACTED]");
    expect(result["X-API-KEY"]).toBe("[REDACTED]");
  });

  it("handles array-valued headers by joining", () => {
    const headers = {
      "set-cookie": ["session=abc", "token=def"],
      accept: "text/html",
    };
    const result = redactSensitiveHeaders(headers);
    expect(result["set-cookie"]).toBe("[REDACTED]");
    // array-valued accept would also be joined
  });

  it("skips undefined headers", () => {
    const headers: Record<string, string | string[] | undefined> = {
      authorization: undefined,
      accept: "text/html",
    };
    const result = redactSensitiveHeaders(headers);
    expect(result.authorization).toBeUndefined();
    expect(result.accept).toBe("text/html");
  });

  it("returns an empty object for empty input", () => {
    expect(redactSensitiveHeaders({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Integration tests for accessLogMiddleware
// ---------------------------------------------------------------------------

describe("accessLogMiddleware", () => {
  let app: express.Express;
  let consoleInfoSpy: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    // Mount requestIdMiddleware before accessLogMiddleware so request_id is set
    app.use(requestIdMiddleware);
    app.use(accessLogMiddleware);

    app.get("/test", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    app.post("/test-body", (_req, res) => {
      res.status(201).json({ created: true });
    });

    app.get("/error", (_req, res) => {
      res.status(500).json({ error: "Server Error" });
    });

    app.get("/health", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    app.get("/ready", (_req, res) => {
      res.status(200).json({ ok: true });
    });

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

  it("should sanitise URL-encoded control characters from the path", async () => {
    // Send a request with URL-encoded newlines to test log-injection prevention.
    const maliciousPath = "/test%0aX-Injected:%20true%0d";
    await request(app).get(maliciousPath);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);

    // After decoding and stripping control chars, the path should be clean.
    expect(logObj.path).toBe("/testX-Injected: true");
    // No newlines or carriage returns should survive.
    expect(logObj.path).not.toMatch(/[\n\r]/);
  });

  it("should handle requests to paths with query strings gracefully", async () => {
    const res = await request(app).get("/test?foo=bar&baz=qux");
    expect(res.status).toBe(200);

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);

    // The path should include the query string when using originalUrl
    expect(logObj.path).toContain("/test?foo=bar&baz=qux");
    // No control characters should survive.
    expect(logObj.path).not.toMatch(/[\n\r]/);
  });

  it("should use 'unknown' as request_id when requestIdMiddleware is not mounted", async () => {
    const standaloneApp = express();
    standaloneApp.use(express.json());
    standaloneApp.use(accessLogMiddleware);
    standaloneApp.get("/test", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(standaloneApp).get("/test");

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logObj = JSON.parse(consoleInfoSpy.mock.calls[0][0]);
    expect(logObj.request_id).toBe("unknown");
  });
});

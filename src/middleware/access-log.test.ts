import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { accessLogMiddleware, redactSensitiveParams, getMetrics, resetMetrics } from "./access-log.js";
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
    expect(result).toContain("account=%5Bredacted%5D");
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

describe("accessLogMiddleware", () => {
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
    expect(typeof logObj.timestamp).toBe("string");
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

    expect(logLine).not.toContain("my-secret-token");
    expect(logLine).not.toContain("my-secret-password");

    const logObj = JSON.parse(logLine);
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

    expect(logObj.path).toContain("token=%5Bredacted%5D");
    expect(logObj.path).toContain("signature=%5Bredacted%5D");
    expect(logObj.path).toContain("normal=value");
    expect(logObj.path).not.toContain("secret123");
    expect(logObj.path).not.toContain("abc");
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
    expect(logObj.path).toContain("token=%5Bredacted%5D");
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
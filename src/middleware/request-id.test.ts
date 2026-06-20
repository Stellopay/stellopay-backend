import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { requestIdMiddleware } from "./request-id.js";

/** Call the middleware directly with a hand-crafted req so we can test
 *  header values that the HTTP layer (supertest/superagent) would reject. */
function runMiddleware(xRequestId: string | undefined): string {
  const req = { headers: { "x-request-id": xRequestId } } as any;
  const locals: Record<string, unknown> = {};
  const res = {
    locals,
    setHeader: vi.fn(),
  } as any;
  const next = vi.fn();
  requestIdMiddleware(req, res, next);
  expect(next).toHaveBeenCalledOnce();
  return res.locals.requestId as string;
}

function makeApp() {
  const app = express();
  app.use(requestIdMiddleware);

  app.get("/ok", (_req, res) => {
    res.json({ request_id: res.locals.requestId });
  });

  // Simulates the central error handler pattern used in src/index.ts
  app.get("/boom", (_req, _res, next) => {
    const err: any = new Error("test error");
    err.status = 500;
    next(err);
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({
      error: err.message,
      request_id: res.locals.requestId,
    });
  });

  return app;
}

describe("requestIdMiddleware", () => {
  // ── Header round-trip ────────────────────────────────────────────────────

  it("echoes a valid client-supplied X-Request-Id on the response", async () => {
    const id = "my-client-id-abc-123";
    const res = await request(makeApp()).get("/ok").set("X-Request-Id", id);
    expect(res.headers["x-request-id"]).toBe(id);
    expect(res.body.request_id).toBe(id);
  });

  it("generates a UUID when no X-Request-Id header is provided", async () => {
    const res = await request(makeApp()).get("/ok");
    const id = res.headers["x-request-id"];
    expect(typeof id).toBe("string");
    // RFC-4122 UUID v4 pattern
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("generates distinct UUIDs for consecutive requests", async () => {
    const app = makeApp();
    const r1 = await request(app).get("/ok");
    const r2 = await request(app).get("/ok");
    expect(r1.headers["x-request-id"]).not.toBe(r2.headers["x-request-id"]);
  });

  // ── Error responses carry the request ID ────────────────────────────────

  it("includes request_id in error JSON body when a client ID was supplied", async () => {
    const id = "error-correlation-id";
    const res = await request(makeApp()).get("/boom").set("X-Request-Id", id);
    expect(res.status).toBe(500);
    expect(res.body.request_id).toBe(id);
    expect(res.headers["x-request-id"]).toBe(id);
  });

  it("includes a generated request_id in error JSON body when no header supplied", async () => {
    const res = await request(makeApp()).get("/boom");
    expect(res.status).toBe(500);
    expect(typeof res.body.request_id).toBe("string");
    expect(res.body.request_id.length).toBeGreaterThan(0);
    expect(res.headers["x-request-id"]).toBe(res.body.request_id);
  });

  // ── res.locals.requestId is available downstream ─────────────────────────

  it("exposes the request ID on res.locals.requestId for downstream handlers", async () => {
    const id = "downstream-test";
    const res = await request(makeApp()).get("/ok").set("X-Request-Id", id);
    expect(res.body.request_id).toBe(id);
  });

  // ── Client-supplied ID sanitisation ─────────────────────────────────────

  it("rejects an overlong client ID (> 128 chars) and generates a UUID instead", async () => {
    const overlong = "a".repeat(129);
    const res = await request(makeApp()).get("/ok").set("X-Request-Id", overlong);
    const id = res.headers["x-request-id"];
    expect(id).not.toBe(overlong);
    // Must be a server-generated UUID
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("accepts an ID at exactly the 128-char limit", async () => {
    const maxLen = "b".repeat(128);
    const res = await request(makeApp()).get("/ok").set("X-Request-Id", maxLen);
    expect(res.headers["x-request-id"]).toBe(maxLen);
  });

  // These three cases use runMiddleware() directly because supertest/superagent
  // (correctly) refuses to send HTTP headers containing control characters —
  // the same reason the sanitiser rejects them. We verify the sanitisation
  // logic at the unit level instead.
  it("rejects a client ID containing newline characters (log injection attempt)", () => {
    const id = runMiddleware("id-with-\nnewline");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("rejects a client ID containing carriage return characters", () => {
    const id = runMiddleware("id-with-\r-cr");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("rejects a client ID containing control characters", () => {
    const id = runMiddleware("id-\x01-ctrl");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("accepts printable ASCII special characters in client ID", async () => {
    const id = "req-id_abc.123-XYZ";
    const res = await request(makeApp()).get("/ok").set("X-Request-Id", id);
    expect(res.headers["x-request-id"]).toBe(id);
  });
});

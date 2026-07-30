import { describe, expect, it } from "vitest";
import express, { type Request, type Response } from "express";
import request from "supertest";
import {
  IDEMPOTENCY_KEY_HEADER,
  makeLimiter,
  retryAfterSeconds,
  type MakeLimiterOptions,
} from "./rate-limit.js";

function buildApp(options: MakeLimiterOptions) {
  const app = express();
  app.use(express.json());
  app.get("/test", makeLimiter(options), (_req: Request, res: Response) => {
    res.json({ success: true });
  });
  return app;
}

describe("rate-limit middleware", () => {
  it("rounds retry-after values up to whole seconds", () => {
    expect(retryAfterSeconds(1_500)).toBe(2);
    expect(retryAfterSeconds(0)).toBe(1);
  });

  it("enforces the configured limit", async () => {
    const app = buildApp({ name: "test", windowMs: 60_000, max: 1 });

    await request(app).get("/test").set(IDEMPOTENCY_KEY_HEADER, "key-1").expect(200);
    await request(app).get("/test").set(IDEMPOTENCY_KEY_HEADER, "key-2").expect(429);
  });

  it("uses request cost when calculating the effective limit", async () => {
    const app = buildApp({
      name: "weighted-test",
      windowMs: 60_000,
      max: 10,
      cost: (req) => Number(req.headers["x-cost"] ?? 1),
    });

    await request(app).get("/test").set("x-cost", "5").expect(200);
    await request(app).get("/test").set("x-cost", "5").expect(200);
    await request(app).get("/test").set("x-cost", "5").expect(429);
  });
});

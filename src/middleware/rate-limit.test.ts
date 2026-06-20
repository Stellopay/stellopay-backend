import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";

import { makeLimiter, keyByIp } from "./rate-limit";

/**
 * Build a minimal app that mounts the given limiter on `/api` and exposes a
 * route that always succeeds when not throttled.
 */
function makeApp(limiter: express.RequestHandler) {
  const app = express();
  // Mirror production: trust the first proxy so X-Forwarded-For is honoured.
  app.set("trust proxy", 1);
  app.use("/api", limiter);
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("makeLimiter", () => {
  it("returns a usable Express middleware function", () => {
    const limiter = makeLimiter({ name: "test", windowMs: 1000, max: 5 });
    expect(typeof limiter).toBe("function");
  });

  it("allows requests up to max, then returns the 429 envelope", async () => {
    const max = 3;
    const message = "Too many requests, please try again later.";
    const app = makeApp(makeLimiter({ name: "global", windowMs: 60_000, max, message }));

    // First `max` requests succeed.
    for (let i = 0; i < max; i++) {
      const res = await request(app).get("/api/ping");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }

    // The next request exceeds the limit and is rejected with the envelope.
    const blocked = await request(app).get("/api/ping");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: message });
    expect(blocked.headers["content-type"]).toMatch(/application\/json/);
  });

  it("uses the default message when none is supplied", async () => {
    const app = makeApp(makeLimiter({ name: "default", windowMs: 60_000, max: 1 }));

    await request(app).get("/api/ping").expect(200);
    const blocked = await request(app).get("/api/ping");

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Too many requests, please try again later." });
  });

  it("respects a configured window/max independently per limiter", async () => {
    // Two limiters with different maxes mounted on separate apps must not
    // share state and must each enforce their own configured max.
    const looseApp = makeApp(makeLimiter({ name: "loose", windowMs: 60_000, max: 5 }));
    const tightApp = makeApp(makeLimiter({ name: "tight", windowMs: 60_000, max: 1 }));

    // tight: 1 ok then 429.
    await request(tightApp).get("/api/ping").expect(200);
    await request(tightApp).get("/api/ping").expect(429);

    // loose: still serving after the tight limiter is exhausted.
    for (let i = 0; i < 5; i++) {
      await request(looseApp).get("/api/ping").expect(200);
    }
    await request(looseApp).get("/api/ping").expect(429);
  });

  it("honours a skip predicate (e.g. health checks are never throttled)", async () => {
    const app = express();
    const limiter = makeLimiter({
      name: "skip",
      windowMs: 60_000,
      max: 1,
      skip: (req) => req.path === "/health",
    });
    // Mount globally so /health flows through the limiter but is skipped.
    app.use(limiter);
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    // /health is exempt no matter how many times it is hit.
    for (let i = 0; i < 5; i++) {
      await request(app).get("/health").expect(200);
    }

    // A counted route still throttles after max.
    await request(app).get("/ping").expect(200);
    await request(app).get("/ping").expect(429);
  });

  it("does not emit legacy or standard rate-limit headers", async () => {
    const app = makeApp(makeLimiter({ name: "headers", windowMs: 60_000, max: 5 }));
    const res = await request(app).get("/api/ping");

    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
  });
});

describe("keyByIp", () => {
  it("returns req.ip when present", () => {
    expect(keyByIp({ ip: "203.0.113.7" } as express.Request)).toBe("203.0.113.7");
  });

  it("falls back to 'unknown' when the IP cannot be resolved", () => {
    expect(keyByIp({ ip: undefined } as unknown as express.Request)).toBe("unknown");
  });

  it("keys distinct client IPs separately (no cross-IP throttling)", async () => {
    const app = makeApp(makeLimiter({ name: "per-ip", windowMs: 60_000, max: 1 }));

    // Client A exhausts its single request.
    await request(app).get("/api/ping").set("X-Forwarded-For", "198.51.100.1").expect(200);
    await request(app).get("/api/ping").set("X-Forwarded-For", "198.51.100.1").expect(429);

    // Client B (different forwarded IP) is unaffected.
    await request(app).get("/api/ping").set("X-Forwarded-For", "198.51.100.2").expect(200);
  });
});

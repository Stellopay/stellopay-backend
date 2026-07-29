import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// billing.ts imports ../db/index.js which creates a real pg Pool at load time.
// Mock it out before anything else runs so the pool is never constructed.
vi.mock("../db/index.js", () => ({ db: {}, schema: {} }));
vi.mock("../config.js", () => ({ env: { BILLING_ENABLED: true } }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

import {
  clearBillingIdempotencyStore,
  withBillingIdempotency,
  computeBillingSummary,
  buildFullAddress,
} from "./billing";

// ---------------------------------------------------------------------------
// computeBillingSummary — pure billing math, no I/O
// ---------------------------------------------------------------------------

describe("computeBillingSummary", () => {
  it("returns zeros when both inputs are zero", () => {
    expect(computeBillingSummary("0", "0")).toEqual({
      annualRewardLimit: 0, usedAmount: 0, remainingAmount: 0, progressPercentage: 0,
    });
  });

  it("computes remainingAmount as limit minus used", () => {
    expect(computeBillingSummary("1000", "250").remainingAmount).toBe(750);
  });

  it("computes progressPercentage rounded to 2 dp", () => {
    expect(computeBillingSummary("3000", "1000").progressPercentage).toBe(33.33);
  });

  it("clamps remainingAmount to 0 when used exceeds limit", () => {
    expect(computeBillingSummary("100", "200").remainingAmount).toBe(0);
  });

  it("returns progressPercentage=0 when limit=0 (no division by zero)", () => {
    const s = computeBillingSummary("0", "50");
    expect(s.progressPercentage).toBe(0);
    expect(s.remainingAmount).toBe(0);
  });

  it("treats null/undefined as 0", () => {
    expect(computeBillingSummary(null, null).annualRewardLimit).toBe(0);
    expect(computeBillingSummary(undefined, undefined).usedAmount).toBe(0);
  });

  it("parses DB numeric strings with trailing zeros", () => {
    const s = computeBillingSummary("1000.000000", "250.500000");
    expect(s.usedAmount).toBe(250.5);
    expect(s.remainingAmount).toBe(749.5);
  });

  it("rounds progressPercentage to exactly 2 dp (1/3 case)", () => {
    expect(computeBillingSummary("300", "100").progressPercentage).toBe(33.33);
  });

  it("returns 100% when used equals limit", () => {
    const s = computeBillingSummary("500", "500");
    expect(s.remainingAmount).toBe(0);
    expect(s.progressPercentage).toBe(100);
  });

  it("allows progressPercentage > 100 for over-spend", () => {
    expect(computeBillingSummary("100", "200").progressPercentage).toBe(200);
  });

  it("handles fractional values", () => {
    const s = computeBillingSummary("0.5", "0.25");
    expect(s.remainingAmount).toBe(0.25);
    expect(s.progressPercentage).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// buildFullAddress — pure address formatter, no I/O
// ---------------------------------------------------------------------------

describe("buildFullAddress", () => {
  it("joins all five parts with ', '", () => {
    expect(buildFullAddress(["1 Main St", "NYC", "NY", "10001", "USA"])).toBe(
      "1 Main St, NYC, NY, 10001, USA",
    );
  });

  it("returns null when all parts are absent", () => {
    expect(buildFullAddress([null, null, undefined, null, null])).toBeNull();
    expect(buildFullAddress([])).toBeNull();
  });

  it("skips null/undefined and joins the rest", () => {
    expect(buildFullAddress([null, "Berlin", undefined, null, "DE"])).toBe("Berlin, DE");
  });

  it("returns a single part when only one is present", () => {
    expect(buildFullAddress([null, "Paris", null, null, null])).toBe("Paris");
  });

  it("preserves order of present parts", () => {
    expect(buildFullAddress(["10 Downing St", "London", null, null, "UK"])).toBe(
      "10 Downing St, London, UK",
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency middleware
// ---------------------------------------------------------------------------

function makeIdempotencyApp() {
  const app = express();
  app.use(express.json());
  let count = 0;
  app.post("/billing/test", withBillingIdempotency(async (req, res) => {
    count++;
    res.status(201).json({ count, body: req.body });
  }));
  return { app, getCount: () => count };
}

describe("billing idempotency middleware", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    clearBillingIdempotencyStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearBillingIdempotencyStore();
  });

  it("executes normally without an idempotency key", async () => {
    const { app, getCount } = makeIdempotencyApp();
    await request(app).post("/billing/test").send({ amount: 10 }).expect(201);
    await request(app).post("/billing/test").send({ amount: 20 }).expect(201);
    expect(getCount()).toBe(2);
  });

  it("replays cached response for same key and body", async () => {
    const { app, getCount } = makeIdempotencyApp();
    const first = await request(app).post("/billing/test").set("Idempotency-Key", "k1").send({ x: 1 });
    const replay = await request(app).post("/billing/test").set("Idempotency-Key", "k1").send({ x: 1 });
    expect(first.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(getCount()).toBe(1);
  });

  it("returns 409 when key is reused with a different body", async () => {
    const { app } = makeIdempotencyApp();
    await request(app).post("/billing/test").set("Idempotency-Key", "k2").send({ x: 1 });
    const res = await request(app).post("/billing/test").set("Idempotency-Key", "k2").send({ x: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/different request body/);
  });

  it("re-executes after the 24-hour TTL expires", async () => {
    const { app, getCount } = makeIdempotencyApp();
    await request(app).post("/billing/test").set("Idempotency-Key", "k-ttl").send({ x: 1 });
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    await request(app).post("/billing/test").set("Idempotency-Key", "k-ttl").send({ x: 1 });
    expect(getCount()).toBe(2);
  });

  it("does not cache GET requests", async () => {
    const app = express();
    app.use(express.json());
    let n = 0;
    app.get("/billing/t", withBillingIdempotency(async (_req, res) => { n++; res.json({ n }); }));
    await request(app).get("/billing/t").set("Idempotency-Key", "k");
    await request(app).get("/billing/t").set("Idempotency-Key", "k");
    expect(n).toBe(2);
  });

  it("accepts lowercase idempotency-key header", async () => {
    const { app, getCount } = makeIdempotencyApp();
    await request(app).post("/billing/test").set("idempotency-key", "lc").send({ x: 1 });
    await request(app).post("/billing/test").set("idempotency-key", "lc").send({ x: 1 });
    expect(getCount()).toBe(1);
  });

  it("preserves the original status code in the cached replay", async () => {
    const app = express();
    app.use(express.json());
    app.post("/billing/t", withBillingIdempotency(async (_req, res) => { res.status(202).json({ ok: true }); }));
    await request(app).post("/billing/t").set("Idempotency-Key", "k202").send({});
    const replay = await request(app).post("/billing/t").set("Idempotency-Key", "k202").send({});
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ok: true });
  });
});

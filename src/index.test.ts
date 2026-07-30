import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { app } from "./index.js";
import { setApplicationReady } from "./middleware/db-readiness.js";

describe("GET /ready", () => {
  let querySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    querySpy = vi.spyOn(Pool.prototype, "query").mockResolvedValue({
      rows: [{ "?column?": 1 }],
      command: "SELECT",
      rowCount: 1,
    } as never);
  });

  afterEach(() => {
    querySpy.mockRestore();
  });

  it("returns 200 with latency info when the database is reachable", async () => {
    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.healthy).toBe(true);
    expect(response.body).toHaveProperty("latencyMs");
    expect(typeof response.body.latencyMs).toBe("number");
    expect(response.body.degraded).toBe(false);
  });

  it("returns 503 with latency info when the database health check fails", async () => {
    querySpy.mockRejectedValueOnce(new Error("db unavailable"));

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body.ok).toBe(false);
    expect(response.body.healthy).toBe(false);
    expect(response.body).toHaveProperty("latencyMs");
    expect(typeof response.body.latencyMs).toBe("number");
    expect(response.body.degraded).toBe(false);
  });
});

describe("startup DB readiness gating", () => {
  afterEach(() => {
    setApplicationReady(true);
  });

  it("returns 503 for API routes before readiness and serves them after", async () => {
    setApplicationReady(false);

    const blocked = await request(app).get("/api/v1/no-such-route");
    expect(blocked.status).toBe(503);
    expect(blocked.body.message).toBe("Database is not ready");

    setApplicationReady(true);

    const allowed = await request(app).get("/api/v1/no-such-route");
    expect(allowed.status).toBe(404);
    expect(allowed.body.error).toBe("Route not found");
  });

  it("still serves /health while API traffic is gated", async () => {
    setApplicationReady(false);

    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
  });
});

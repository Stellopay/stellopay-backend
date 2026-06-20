import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { apiV1NotFoundHandler } from "./not-found";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/v1/known", (_req, res) =>
    res.json({ success: true, data: { ok: true } }),
  );
  app.use("/api/v1", apiV1NotFoundHandler);
  return app;
}

describe("apiV1NotFoundHandler", () => {
  it("returns the standard JSON envelope for unknown /api/v1 routes", async () => {
    const res = await request(makeApp()).get("/api/v1/missing-route");

    expect(res.status).toBe(404);
    expect(res.type).toMatch(/json/);
    expect(res.body).toEqual({
      success: false,
      error: "Route not found",
      data: {
        method: "GET",
        path: "/api/v1/missing-route",
      },
    });
  });

  it("returns 404 for the wrong method on an existing /api/v1 path", async () => {
    const res = await request(makeApp()).post("/api/v1/known");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: "Route not found",
      data: {
        method: "POST",
        path: "/api/v1/known",
      },
    });
  });

  it("does not intercept health checks or matched routes", async () => {
    const health = await request(makeApp()).get("/health");
    const known = await request(makeApp()).get("/api/v1/known");

    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ success: true, data: { ok: true } });
  });

  it("serializes suspicious paths as JSON instead of HTML", async () => {
    const res = await request(makeApp()).get(
      "/api/v1/%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    );

    expect(res.status).toBe(404);
    expect(res.type).toMatch(/json/);
    expect(res.text).not.toContain("<script>");
    expect(res.body.data.path).toBe("/api/v1/%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  });
});

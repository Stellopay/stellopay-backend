import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { systemRouter } from "./system.js";
import fs from "fs";

vi.mock("../starknet/client.js", () => ({
  provider: {
    getNonceForAddress: vi.fn(),
    getBlockNumber: vi.fn(),
  },
  getCachedNetworkInfo: vi.fn().mockResolvedValue({ chainId: "1", specVersion: "0.1.0" }),
}));

vi.mock("../db/index.js", () => ({
  checkDbHealth: vi.fn(),
}));

import { checkDbHealth } from "../db/index.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", systemRouter);
  // Add a basic error handler so next(e) doesn't hang or crash the test ungracefully
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

describe("systemRouter /system/version", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes the version payload once at startup/first-request and caches it", async () => {
    const fsSpy = vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ version: "0.1.0" }));
    const app = makeApp();

    const res1 = await request(app).get("/api/v1/system/version");
    expect(res1.status).toBe(200);
    expect(res1.body).toEqual({ version: "0.1.0" });
    expect(res1.headers["cache-control"]).toBe("public, max-age=3600");
    
    // It should have read the file once
    expect(fsSpy).toHaveBeenCalledTimes(1);

    const res2 = await request(app).get("/api/v1/system/version");
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({ version: "0.1.0" });
    
    // It should NOT have read the file a second time
    expect(fsSpy).toHaveBeenCalledTimes(1);
  });
});

describe("systemRouter /system/live", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with status ok independent of dependency state", async () => {
    const app = makeApp();

    const res = await request(app).get("/api/v1/system/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("systemRouter /system/ready", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 when all dependencies are reachable", async () => {
    vi.mocked(checkDbHealth).mockResolvedValue({ healthy: true, latencyMs: 1, degraded: false });
    const { provider } = await import("../starknet/client.js");
    vi.mocked(provider.getBlockNumber).mockResolvedValue(12345);
    const app = makeApp();

    const res = await request(app).get("/api/v1/system/ready");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      checks: { database: "reachable", "starknet-rpc": "reachable" },
    });
  });

  it("returns 503 when database is unreachable", async () => {
    vi.mocked(checkDbHealth).mockResolvedValue({ healthy: false, latencyMs: 1, degraded: false });
    const { provider } = await import("../starknet/client.js");
    vi.mocked(provider.getBlockNumber).mockResolvedValue(12345);
    const app = makeApp();

    const res = await request(app).get("/api/v1/system/ready");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "degraded",
      checks: { database: "unreachable", "starknet-rpc": "reachable" },
    });
  });

  it("returns 503 when RPC is unreachable", async () => {
    vi.mocked(checkDbHealth).mockResolvedValue({ healthy: true, latencyMs: 1, degraded: false });
    const { provider } = await import("../starknet/client.js");
    vi.mocked(provider.getBlockNumber).mockRejectedValue(new Error("RPC unreachable"));
    const app = makeApp();

    const res = await request(app).get("/api/v1/system/ready");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "degraded",
      checks: { database: "reachable", "starknet-rpc": "unreachable" },
    });
  });

  it("returns 503 when both dependencies are unreachable", async () => {
    vi.mocked(checkDbHealth).mockResolvedValue({ healthy: false, latencyMs: 1, degraded: false });
    const { provider } = await import("../starknet/client.js");
    vi.mocked(provider.getBlockNumber).mockRejectedValue(new Error("RPC unreachable"));
    const app = makeApp();

    const res = await request(app).get("/api/v1/system/ready");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "degraded",
      checks: { database: "unreachable", "starknet-rpc": "unreachable" },
    });
  });
});

import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { systemRouter } from "./system.js";
import fs from "fs";

vi.mock("../starknet/client.js", () => ({
  provider: {
    getNonceForAddress: vi.fn(),
  },
  getCachedNetworkInfo: vi.fn().mockResolvedValue({ chainId: "1", specVersion: "0.1.0" }),
}));

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

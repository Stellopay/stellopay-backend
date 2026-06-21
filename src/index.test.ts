import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { app } from "./index.js";
import { provider } from "./starknet/client.js";

describe("GET /ready", () => {
  let querySpy: ReturnType<typeof vi.spyOn>;
  let chainIdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    querySpy = vi.spyOn(Pool.prototype, "query").mockResolvedValue({
      rows: [{ "?column?": 1 }],
      command: "SELECT",
      rowCount: 1,
    } as never);
    chainIdSpy = vi.spyOn(provider, "getChainId").mockResolvedValue("SN_SEPOLIA" as never);
  });

  afterEach(() => {
    querySpy.mockRestore();
    chainIdSpy.mockRestore();
  });

  it("returns 200 when the database and Starknet RPC are reachable", async () => {
    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      dependencies: { database: "up", starknetRpc: "up" },
    });
  });

  it("returns 503 when the database health check fails", async () => {
    querySpy.mockRejectedValueOnce(new Error("db unavailable"));

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      ok: false,
      dependencies: { database: "down", starknetRpc: "up" },
    });
  });

  it("returns 503 when the Starknet RPC check fails", async () => {
    chainIdSpy.mockRejectedValueOnce(new Error("rpc unavailable"));

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      ok: false,
      dependencies: { database: "up", starknetRpc: "down" },
    });
  });
});

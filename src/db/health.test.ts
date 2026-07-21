import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { checkDbHealth, getPoolStats, maskConnectionString } from "./index.js";

describe("maskConnectionString", () => {
  it("redacts credentials without exposing the raw DSN", () => {
    const masked = maskConnectionString(
      "postgres://user:super-secret-password@example.com:5432/stellopay_indexer",
    );

    expect(masked).toContain("***");
    expect(masked).not.toContain("super-secret-password");
    expect(masked).toContain("example.com:5432");
  });
});

describe("checkDbHealth", () => {
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

  it("returns true when SELECT 1 succeeds", async () => {
    await expect(checkDbHealth()).resolves.toBe(true);
    expect(querySpy).toHaveBeenCalledWith("SELECT 1");
  });

  it("returns false when the database query fails", async () => {
    querySpy.mockRejectedValueOnce(new Error("db unavailable"));

    await expect(checkDbHealth()).resolves.toBe(false);
  });
});

describe("getPoolStats", () => {
  const poolPrototype = Object.getPrototypeOf(Pool.prototype) as Pool;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the current total, active, idle, and waiting connection counts", () => {
    vi.spyOn(poolPrototype, "totalCount", "get").mockReturnValue(9);
    vi.spyOn(poolPrototype, "idleCount", "get").mockReturnValue(4);
    vi.spyOn(poolPrototype, "waitingCount", "get").mockReturnValue(2);

    expect(getPoolStats()).toEqual({
      total: 9,
      idle: 4,
      active: 5,
      waiting: 2,
    });
  });
});

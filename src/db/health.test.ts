import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { checkDbHealth, maskConnectionString } from "./index.js";

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

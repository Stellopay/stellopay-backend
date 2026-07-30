import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { checkDbHealth, getPoolStats, maskConnectionString, waitForDbReadiness } from "./index.js";
import { env } from "../config.js";

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
    vi.useFakeTimers();
    querySpy = vi.spyOn(Pool.prototype, "query").mockResolvedValue({
      rows: [{ "?column?": 1 }],
      command: "SELECT",
      rowCount: 1,
    } as never);
  });

  afterEach(() => {
    querySpy.mockRestore();
    vi.useRealTimers();
  });

  it("returns healthy=true when SELECT 1 succeeds", async () => {
    const result = await checkDbHealth();
    expect(result.healthy).toBe(true);
    expect(querySpy).toHaveBeenCalledWith("SELECT 1");
  });

  it("returns healthy=false when the database query fails", async () => {
    querySpy.mockRejectedValueOnce(new Error("db unavailable"));

    const result = await checkDbHealth();
    expect(result.healthy).toBe(false);
  });

  it("reports a non-negative latencyMs on success", async () => {
    const result = await checkDbHealth();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a non-negative latencyMs on failure", async () => {
    querySpy.mockRejectedValueOnce(new Error("db unavailable"));

    const result = await checkDbHealth();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("surfaces degraded=true when latency exceeds the configured threshold", async () => {
    const originalThreshold = env.DB_HEALTH_DEGRADED_LATENCY_MS;
    env.DB_HEALTH_DEGRADED_LATENCY_MS = 0; // set to 0 so any positive latency triggers degraded
    try {
      const result = await checkDbHealth();
      expect(result.healthy).toBe(true);
      expect(result.degraded).toBe(true);
    } finally {
      env.DB_HEALTH_DEGRADED_LATENCY_MS = originalThreshold;
    }
  });

  it("reports degraded=false when latency is below the threshold", async () => {
    const originalThreshold = env.DB_HEALTH_DEGRADED_LATENCY_MS;
    env.DB_HEALTH_DEGRADED_LATENCY_MS = 10_000; // large enough so any realistic query is below
    try {
      const result = await checkDbHealth();
      expect(result.healthy).toBe(true);
      expect(result.degraded).toBe(false);
    } finally {
      env.DB_HEALTH_DEGRADED_LATENCY_MS = originalThreshold;
    }
  });

  it("reports degraded=false when the query fails", async () => {
    querySpy.mockRejectedValueOnce(new Error("db unavailable"));

    const result = await checkDbHealth();
    expect(result.healthy).toBe(false);
    expect(result.degraded).toBe(false);
  });
});

describe("waitForDbReadiness", () => {
  let querySpy: ReturnType<typeof vi.spyOn>;
  const origMaxAttempts = env.DB_CONNECTION_RETRY_MAX_ATTEMPTS;
  const origBaseDelay = env.DB_CONNECTION_RETRY_BASE_DELAY_MS;

  beforeEach(() => {
    vi.useFakeTimers();
    querySpy = vi.spyOn(Pool.prototype, "query");
    // Set small retry config so tests complete quickly
    env.DB_CONNECTION_RETRY_MAX_ATTEMPTS = 3;
    env.DB_CONNECTION_RETRY_BASE_DELAY_MS = 10;
  });

  afterEach(() => {
    querySpy.mockRestore();
    vi.useRealTimers();
    env.DB_CONNECTION_RETRY_MAX_ATTEMPTS = origMaxAttempts;
    env.DB_CONNECTION_RETRY_BASE_DELAY_MS = origBaseDelay;
  });

  it("resolves after the database becomes reachable", async () => {
    querySpy
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockResolvedValueOnce({
        rows: [{ "?column?": 1 }],
        command: "SELECT",
        rowCount: 1,
      } as never);

    const ready = waitForDbReadiness();
    await vi.advanceTimersByTimeAsync(500);
    await expect(ready).resolves.toBeUndefined();
    expect(querySpy).toHaveBeenCalledTimes(2);
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

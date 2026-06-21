import { afterEach, describe, expect, it, vi } from "vitest";

const poolInstances = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation((config: Record<string, unknown>) => {
    const instance = {
      config,
      on: vi.fn(),
      query: vi.fn(),
      end: vi.fn(),
    };
    poolInstances.push(instance);
    return instance;
  }),
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn(() => ({})),
}));

vi.mock("./schema.js", () => ({}));

async function importDbWithEnv(extraEnv: Record<string, string> = {}) {
  vi.resetModules();
  poolInstances.length = 0;
  process.env = {
    STARKNET_RPC_URL: "https://rpc.test.invalid",
    POSTGRES_CONNECTION_STRING: "postgresql://postgres:postgres@localhost:5432/stellopay_indexer",
    ...extraEnv,
  };

  await import("./index.js");

  return poolInstances[0]?.config;
}

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.resetModules();
});

describe("database pool configuration", () => {
  it("applies bounded pool and query timeout defaults", async () => {
    const config = await importDbWithEnv();

    expect(config).toMatchObject({
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
    });
  });

  it("uses validated env overrides for all timeout knobs", async () => {
    const config = await importDbWithEnv({
      DB_POOL_MAX: "4",
      DB_POOL_IDLE_TIMEOUT_MS: "11000",
      DB_POOL_CONNECTION_TIMEOUT_MS: "1200",
      DB_POOL_STATEMENT_TIMEOUT_MS: "2500",
      DB_POOL_QUERY_TIMEOUT_MS: "3000",
    });

    expect(config).toMatchObject({
      max: 4,
      idleTimeoutMillis: 11_000,
      connectionTimeoutMillis: 1_200,
      statement_timeout: 2_500,
      query_timeout: 3_000,
    });
  });

  it("rejects non-positive query timeout values", async () => {
    await expect(importDbWithEnv({ DB_POOL_QUERY_TIMEOUT_MS: "0" })).rejects.toThrow();
  });
});

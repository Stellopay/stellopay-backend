import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * config.ts parses process.env once at import time, so each case patches
 * process.env and re-imports a fresh copy with vi.resetModules for a
 * deterministic parse. A valid STARKNET_RPC_URL is always required, so it is
 * part of the base env.
 */
const BASE_ENV: Record<string, string> = {
  STARKNET_RPC_URL: "https://rpc.test.invalid",
  POSTGRES_CONNECTION_STRING:
    "postgresql://postgres:postgres@localhost:5432/stellopay_indexer",
};

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...BASE_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.resetModules();
});

/** Imports a fresh copy of config.ts with the base env plus the given overrides. */
async function loadConfig(extra: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...extra };
  return import("./config");
}

describe("config env parsing", () => {
  it("applies defaults and coercions when only STARKNET_RPC_URL is set", async () => {
    const { env } = await loadConfig();
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGIN).toBe("*");
    expect(env.RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(env.RATE_LIMIT_MAX).toBe(100);
    expect(env.RATE_LIMIT_STRICT_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(env.RATE_LIMIT_STRICT_MAX).toBe(10);
    expect(env.SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(10000);
    expect(env.TRUST_PROXY).toBe("1");
    expect(env.BILLING_ENABLED).toBe(false);
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.DB_POOL_IDLE_TIMEOUT_MS).toBe(30_000);
    expect(env.DB_POOL_CONNECTION_TIMEOUT_MS).toBe(5_000);
    expect(env.DB_STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(env.DB_QUERY_TIMEOUT_MS).toBe(20_000);
  });

  it("coerces numeric env strings to numbers", async () => {
    const { env } = await loadConfig({
      PORT: "5000",
      RATE_LIMIT_MAX: "250",
      DB_POOL_MAX: "20",
      DB_STATEMENT_TIMEOUT_MS: "7500",
      DB_QUERY_TIMEOUT_MS: "8000",
    });
    expect(env.PORT).toBe(5000);
    expect(env.RATE_LIMIT_MAX).toBe(250);
    expect(env.DB_POOL_MAX).toBe(20);
    expect(env.DB_STATEMENT_TIMEOUT_MS).toBe(7500);
    expect(env.DB_QUERY_TIMEOUT_MS).toBe(8000);
  });

  it("rejects unbounded database timeout and pool values", async () => {
    await expect(loadConfig({ DB_STATEMENT_TIMEOUT_MS: "0" })).rejects.toThrow();
    await expect(loadConfig({ DB_QUERY_TIMEOUT_MS: "-1" })).rejects.toThrow();
    await expect(loadConfig({ DB_POOL_MAX: "0" })).rejects.toThrow();
  });

  it("treats BILLING_ENABLED 'true' as true", async () => {
    const { env } = await loadConfig({ BILLING_ENABLED: "true" });
    expect(env.BILLING_ENABLED).toBe(true);
  });

  it("treats any other BILLING_ENABLED value as false", async () => {
    const { env } = await loadConfig({ BILLING_ENABLED: "yes" });
    expect(env.BILLING_ENABLED).toBe(false);
  });

  it("rejects an invalid CONTACT_RECIPIENT_EMAIL", async () => {
    await expect(loadConfig({ CONTACT_RECIPIENT_EMAIL: "not-an-email" })).rejects.toThrow();
  });

  it("throws when the required STARKNET_RPC_URL is missing", async () => {
    vi.resetModules();
    process.env = {}; // no STARKNET_RPC_URL
    await expect(import("./config")).rejects.toThrow();
  });

  it("resolves local ABI fallback paths in development", async () => {
    const { abiPaths } = await loadConfig({ NODE_ENV: "development" });
    expect(abiPaths.escrow).toContain("PayrollEscrow");
    expect(abiPaths.agreement).toContain("WorkAgreement");
  });

  it("uses explicit ABI paths when provided in production", async () => {
    const { abiPaths } = await loadConfig({
      NODE_ENV: "production",
      ESCROW_CONTRACT_CLASS_JSON: "/abi/escrow.json",
      AGREEMENT_CONTRACT_CLASS_JSON: "/abi/agreement.json",
    });
    expect(abiPaths.escrow).toBe("/abi/escrow.json");
    expect(abiPaths.agreement).toBe("/abi/agreement.json");
  });

  it("throws in production when ABI paths are unset, so the guard cannot be bypassed", async () => {
    await expect(loadConfig({ NODE_ENV: "production" })).rejects.toThrow(
      /must be set in production/i,
    );
  });

  it("uses provided escrow and agreement addresses when set", async () => {
    const { defaults } = await loadConfig({
      PAYROLL_ESCROW_ADDRESS: "0xaaa",
      WORK_AGREEMENT_ADDRESS: "0xbbb",
    });
    expect(defaults.payrollEscrowAddress).toBe("0xaaa");
    expect(defaults.workAgreementAddress).toBe("0xbbb");
  });

  it("falls back to built-in escrow and agreement defaults when unset", async () => {
    const { defaults } = await loadConfig();
    expect(defaults.payrollEscrowAddress).toMatch(/^0x06d3599/);
    expect(defaults.workAgreementAddress).toMatch(/^0x067812/);
  });
});

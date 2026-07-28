import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * config.ts parses process.env once at import time, so each case patches
 * process.env and re-imports a fresh copy with vi.resetModules for a
 * deterministic parse. A valid STARKNET_RPC_URL and POSTGRES_CONNECTION_STRING
 * are always required, so they are part of the base env.
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
  it("applies defaults and coercions when only required vars are set", async () => {
    const { env } = await loadConfig();
    expect(env.PORT).toBe(4000);
    // In development (the default NODE_ENV), CORS_ORIGIN falls back to "*".
    expect(env.CORS_ORIGIN).toBe("*");
    expect(env.RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(env.RATE_LIMIT_MAX).toBe(100);
    expect(env.RATE_LIMIT_STRICT_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(env.RATE_LIMIT_STRICT_MAX).toBe(10);
    expect(env.TOKEN_METADATA_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    expect(env.SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(10000);
    expect(env.TRUST_PROXY).toBe("1");
    expect(env.BILLING_ENABLED).toBe(false);
  });

  it("dev default: CORS_ORIGIN resolves to '*' when unset (permissive dev default)", async () => {
    const { env } = await loadConfig({ NODE_ENV: "development" });
    expect(env.CORS_ORIGIN).toBe("*");
  });

  it("dev explicit: CORS_ORIGIN resolves to the provided value in development", async () => {
    const { env } = await loadConfig({
      NODE_ENV: "development",
      CORS_ORIGIN: "http://localhost:3000",
    });
    expect(env.CORS_ORIGIN).toBe("http://localhost:3000");
  });

  it("coerces numeric env strings to numbers", async () => {
    const { env } = await loadConfig({
      PORT: "5000",
      RATE_LIMIT_MAX: "250",
      TOKEN_METADATA_CACHE_TTL_MS: "60000",
    });
    expect(env.PORT).toBe(5000);
    expect(env.RATE_LIMIT_MAX).toBe(250);
    expect(env.TOKEN_METADATA_CACHE_TTL_MS).toBe(60000);
  });

  it("rejects a non-positive token metadata cache TTL", async () => {
    await expect(
      loadConfig({ TOKEN_METADATA_CACHE_TTL_MS: "0" }),
    ).rejects.toThrow();
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
    await expect(
      loadConfig({ CONTACT_RECIPIENT_EMAIL: "not-an-email" }),
    ).rejects.toThrow();
  });

  it("parses comma-separated Starknet RPC URLs into starknetRpcUrls", async () => {
    const { starknetRpcUrls } = await loadConfig({
      STARKNET_RPC_URL:
        "https://primary.example/rpc,https://backup.example/rpc",
    });
    expect(starknetRpcUrls).toEqual([
      "https://primary.example/rpc",
      "https://backup.example/rpc",
    ]);
  });

  it("rejects plaintext Starknet RPC URLs", async () => {
    await expect(
      loadConfig({ STARKNET_RPC_URL: "http://insecure.example/rpc" }),
    ).rejects.toThrow(/HTTPS/);
  });

  it("resolves local ABI fallback paths in development", async () => {
    const { abiPaths } = await loadConfig({ NODE_ENV: "development" });
    expect(abiPaths.escrow).toContain("PayrollEscrow");
    expect(abiPaths.agreement).toContain("WorkAgreement");
  });

  it("uses explicit ABI paths when provided in production", async () => {
    const { abiPaths } = await loadConfig({
      NODE_ENV: "production",
      CORS_ORIGIN: "https://app.example.com",
      ESCROW_CONTRACT_CLASS_JSON: "/abi/escrow.json",
      AGREEMENT_CONTRACT_CLASS_JSON: "/abi/agreement.json",
    });
    expect(abiPaths.escrow).toBe("/abi/escrow.json");
    expect(abiPaths.agreement).toBe("/abi/agreement.json");
  });

  it("throws in production when ABI paths are unset, so the guard cannot be bypassed", async () => {
    await expect(
      loadConfig({
        NODE_ENV: "production",
        CORS_ORIGIN: "https://app.example.com",
      }),
    ).rejects.toThrow(/must be set in production/i);
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

  // ── CORS_ORIGIN non-development validation ────────────────────────────────

  it("non-dev: throws when CORS_ORIGIN is absent (deny by default)", async () => {
    await expect(
      loadConfig({
        NODE_ENV: "production",
        ESCROW_CONTRACT_CLASS_JSON: "/abi/escrow.json",
        AGREEMENT_CONTRACT_CLASS_JSON: "/abi/agreement.json",
      }),
    ).rejects.toThrow(/CORS_ORIGIN/i);
  });

  it("non-dev: throws when CORS_ORIGIN='*' (wildcard rejected in non-dev)", async () => {
    await expect(
      loadConfig({
        NODE_ENV: "production",
        CORS_ORIGIN: "*",
        ESCROW_CONTRACT_CLASS_JSON: "/abi/escrow.json",
        AGREEMENT_CONTRACT_CLASS_JSON: "/abi/agreement.json",
      }),
    ).rejects.toThrow(/CORS_ORIGIN/i);
  });

  it("non-dev: accepts an explicit allowlist for CORS_ORIGIN", async () => {
    const { env } = await loadConfig({
      NODE_ENV: "production",
      CORS_ORIGIN: "https://app.stellopay.com",
      ESCROW_CONTRACT_CLASS_JSON: "/abi/escrow.json",
      AGREEMENT_CONTRACT_CLASS_JSON: "/abi/agreement.json",
    });
    expect(env.CORS_ORIGIN).toBe("https://app.stellopay.com");
  });

  it("non-dev staging: throws when CORS_ORIGIN is absent", async () => {
    await expect(loadConfig({ NODE_ENV: "staging" })).rejects.toThrow(
      /CORS_ORIGIN/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Missing required variable validation
// ═══════════════════════════════════════════════════════════════════════════

describe("missing required variable validation", () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = process.env;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  /**
   * Helper that imports config with the given env, expecting it to throw.
   * Returns the error message for assertion.
   */
  async function importAndCatch(
    env: Record<string, string>,
  ): Promise<string> {
    vi.resetModules();
    process.env = env;
    try {
      await import("./config");
      throw new Error("Expected config import to throw but it did not");
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  it("throws a single error when one required var is missing and names it", async () => {
    const msg = await importAndCatch({
      // POSTGRES_CONNECTION_STRING present, STARKNET_RPC_URL missing
      POSTGRES_CONNECTION_STRING:
        "postgresql://postgres:postgres@localhost:5432/stellopay_indexer",
    });

    expect(msg).toContain("Invalid environment configuration");
    expect(msg).toContain("STARKNET_RPC_URL");
    expect(msg).toContain("missing (required)");
  });

  it("throws a single error listing all missing required vars when multiple are missing", async () => {
    const msg = await importAndCatch({}); // neither required var set

    expect(msg).toContain("Invalid environment configuration");
    expect(msg).toContain("STARKNET_RPC_URL");
    expect(msg).toContain("POSTGRES_CONNECTION_STRING");
    // Both should be listed in one message
    expect(msg).toContain("missing (required)");
    // Verify both appear: count occurrences of "missing (required)"
    const missingCount = (msg.match(/missing \(required\)/g) ?? []).length;
    expect(missingCount).toBe(2);
  });

  it("does NOT log the values of env vars — only names", async () => {
    const msg = await importAndCatch({
      STARKNET_RPC_URL: "", // empty string is invalid (min 1)
      POSTGRES_CONNECTION_STRING: "not-a-url", // invalid URL
    });

    // Should mention the variable names
    expect(msg).toContain("STARKNET_RPC_URL");
    expect(msg).toContain("POSTGRES_CONNECTION_STRING");

    // Should NOT contain the actual values
    expect(msg).not.toContain("not-a-url");
    // Zod's "String must contain at least 1 character(s)" is fine — it doesn't leak the empty string
  });

  it("lists all missing required vars in a single error message", async () => {
    const msg = await importAndCatch({
      NODE_ENV: "production",
      // STARKNET_RPC_URL and POSTGRES_CONNECTION_STRING both missing
    });

    expect(msg).toContain("Invalid environment configuration");
    expect(msg).toContain("STARKNET_RPC_URL");
    expect(msg).toContain("POSTGRES_CONNECTION_STRING");
    // The CORS_ORIGIN superRefine only runs when the base object validation
    // passes, so it won't appear alongside missing required vars. It will be
    // reported separately once the operator fixes STARKNET_RPC_URL and
    // POSTGRES_CONNECTION_STRING.
  });

  it("only the CORS_ORIGIN issue is reported when required vars are set in non-dev", async () => {
    const msg = await importAndCatch({
      NODE_ENV: "production",
      STARKNET_RPC_URL: "https://rpc.test.invalid",
      POSTGRES_CONNECTION_STRING:
        "postgresql://postgres:postgres@localhost:5432/stellopay_indexer",
      // CORS_ORIGIN is missing
    });

    expect(msg).toContain("Invalid environment configuration");
    expect(msg).not.toContain("STARKNET_RPC_URL");
    expect(msg).not.toContain("POSTGRES_CONNECTION_STRING");
    expect(msg).toContain("CORS_ORIGIN");
  });
});

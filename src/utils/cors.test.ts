import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCorsOrigin, buildCorsOriginHandler, resolveCorsConfig } from "./cors.js";

// ---------------------------------------------------------------------------
// parseCorsOrigin (deprecated — kept for backward-compat coverage)
// ---------------------------------------------------------------------------
describe("parseCorsOrigin", () => {
  const cases: {
    label: string;
    input: string;
    expectedOrigin: string | string[] | boolean;
  }[] = [
    {
      label: "single origin returns string",
      input: "http://localhost:3000",
      expectedOrigin: "http://localhost:3000",
    },
    {
      label: "multiple origins returns array",
      input: "http://localhost:3000,https://app.example.com",
      expectedOrigin: ["http://localhost:3000", "https://app.example.com"],
    },
    {
      label: "wildcard returns true (reflect any origin)",
      input: "*",
      expectedOrigin: true,
    },
    {
      label: "handles whitespace around origins",
      input: "http://localhost:3000 , https://app.example.com ",
      expectedOrigin: ["http://localhost:3000", "https://app.example.com"],
    },
    {
      label: "handles trailing comma",
      input: "http://localhost:3000,",
      expectedOrigin: "http://localhost:3000",
    },
    {
      label: "empty string returns empty array",
      input: "",
      expectedOrigin: [],
    },
  ];

  for (const { label, input, expectedOrigin } of cases) {
    it(label, () => {
      expect(parseCorsOrigin(input)).toEqual(expectedOrigin);
    });
  }
});

// ---------------------------------------------------------------------------
// buildCorsOriginHandler — the canonical safe CORS handler
// ---------------------------------------------------------------------------
describe("buildCorsOriginHandler", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // ── Wildcard in development ───────────────────────────────────────────────

  it("wildcard in development: originHandler is true and credentials is false", () => {
    const { originHandler, credentials } = buildCorsOriginHandler("*", "development");
    expect(originHandler).toBe(true);
    expect(credentials).toBe(false);
  });

  it("wildcard in development: logs a startup warning", () => {
    buildCorsOriginHandler("*", "development");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Wildcard origin"));
  });

  it("wildcard in development: warning does NOT contain 'SECURITY WARNING' (that is reserved for non-dev)", () => {
    buildCorsOriginHandler("*", "development");
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("SECURITY WARNING"));
  });

  // ── Wildcard in non-development: must throw ───────────────────────────────

  it("wildcard in production: throws a fatal error (deny by default)", () => {
    expect(() => buildCorsOriginHandler("*", "production")).toThrow(
      /not permitted in non-development/,
    );
  });

  it("wildcard in staging: throws a fatal error (deny by default)", () => {
    expect(() => buildCorsOriginHandler("*", "staging")).toThrow(
      /not permitted in non-development/,
    );
  });

  it("wildcard in non-dev: error message references NODE_ENV", () => {
    expect(() => buildCorsOriginHandler("*", "production")).toThrow(/NODE_ENV=production/);
  });

  it("wildcard in non-dev: does not log a warning before throwing", () => {
    expect(() => buildCorsOriginHandler("*", "production")).toThrow();
    expect(console.warn).not.toHaveBeenCalled();
  });

  // ── Allowlist ─────────────────────────────────────────────────────────────

  it("allowlist: credentials is true", () => {
    const { credentials } = buildCorsOriginHandler("http://localhost:3000");
    expect(credentials).toBe(true);
  });

  it("allowlist: accepts a listed origin", () => {
    const { originHandler } = buildCorsOriginHandler("http://localhost:3000");
    const callback = vi.fn();
    (originHandler as Function)("http://localhost:3000", callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it("allowlist: rejects an unknown origin with an error", () => {
    const { originHandler } = buildCorsOriginHandler("http://localhost:3000");
    const callback = vi.fn();
    (originHandler as Function)("https://evil.example.com", callback);
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
    const [err] = callback.mock.calls[0];
    expect((err as Error).message).toMatch(/not in the allowlist/);
  });

  it("allowlist: allows same-origin requests (no Origin header)", () => {
    const { originHandler } = buildCorsOriginHandler("http://localhost:3000");
    const callback = vi.fn();
    (originHandler as Function)(undefined, callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it("allowlist: handles multiple origins", () => {
    const { originHandler } = buildCorsOriginHandler(
      "http://localhost:3000,https://app.stellopay.com",
    );
    const cbA = vi.fn();
    const cbB = vi.fn();
    const cbC = vi.fn();
    (originHandler as Function)("http://localhost:3000", cbA);
    (originHandler as Function)("https://app.stellopay.com", cbB);
    (originHandler as Function)("https://evil.example.com", cbC);
    expect(cbA).toHaveBeenCalledWith(null, true);
    expect(cbB).toHaveBeenCalledWith(null, true);
    expect(cbC).toHaveBeenCalledWith(expect.any(Error));
  });

  it("allowlist: trims whitespace around origins", () => {
    const { originHandler } = buildCorsOriginHandler(
      " http://localhost:3000 , https://app.stellopay.com ",
    );
    const callback = vi.fn();
    (originHandler as Function)("http://localhost:3000", callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it("allowlist: does not log a CORS warning", () => {
    buildCorsOriginHandler("http://localhost:3000", "production");
    expect(console.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveCorsConfig — env-aware top-level entry-point
// ---------------------------------------------------------------------------
describe("resolveCorsConfig", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // ── Development: permissive wildcard default ──────────────────────────────

  it("dev + unset CORS_ORIGIN: falls back to wildcard (permissive default)", () => {
    const { originHandler, credentials } = resolveCorsConfig(undefined, "development");
    expect(originHandler).toBe(true);
    expect(credentials).toBe(false);
  });

  it("dev + CORS_ORIGIN=undefined: logs a wildcard warning", () => {
    resolveCorsConfig(undefined, "development");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Wildcard origin"));
  });

  it("dev + CORS_ORIGIN='*': falls back to wildcard with a warning", () => {
    const { originHandler, credentials } = resolveCorsConfig("*", "development");
    expect(originHandler).toBe(true);
    expect(credentials).toBe(false);
  });

  it("dev + explicit allowlist: works as a normal allowlist", () => {
    const { originHandler, credentials } = resolveCorsConfig(
      "http://localhost:3000",
      "development",
    );
    expect(credentials).toBe(true);
    const callback = vi.fn();
    (originHandler as Function)("http://localhost:3000", callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it("dev + unknown origin against allowlist: rejected", () => {
    const { originHandler } = resolveCorsConfig("http://localhost:3000", "development");
    const callback = vi.fn();
    (originHandler as Function)("https://evil.example.com", callback);
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── Non-development: deny by default ─────────────────────────────────────

  it("production + unset CORS_ORIGIN: throws (deny by default)", () => {
    expect(() => resolveCorsConfig(undefined, "production")).toThrow(/not set/);
  });

  it("production + empty CORS_ORIGIN: throws (deny by default)", () => {
    expect(() => resolveCorsConfig("", "production")).toThrow();
  });

  it("production + CORS_ORIGIN='*': throws (wildcard rejected in non-dev)", () => {
    expect(() => resolveCorsConfig("*", "production")).toThrow(/wildcard/i);
  });

  it("staging + unset CORS_ORIGIN: throws (deny by default)", () => {
    expect(() => resolveCorsConfig(undefined, "staging")).toThrow();
  });

  it("staging + CORS_ORIGIN='*': throws (wildcard rejected in non-dev)", () => {
    expect(() => resolveCorsConfig("*", "staging")).toThrow();
  });

  it("production + explicit allowlist: credentials true, listed origin accepted", () => {
    const { originHandler, credentials } = resolveCorsConfig(
      "https://app.stellopay.com",
      "production",
    );
    expect(credentials).toBe(true);
    const callback = vi.fn();
    (originHandler as Function)("https://app.stellopay.com", callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it("production + explicit allowlist: unlisted origin rejected", () => {
    const { originHandler } = resolveCorsConfig("https://app.stellopay.com", "production");
    const callback = vi.fn();
    (originHandler as Function)("https://evil.example.com", callback);
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
  });

  it("production + multi-origin allowlist: all listed origins accepted", () => {
    const { originHandler } = resolveCorsConfig(
      "https://app.stellopay.com,https://staging.stellopay.com",
      "production",
    );
    const cbA = vi.fn();
    const cbB = vi.fn();
    (originHandler as Function)("https://app.stellopay.com", cbA);
    (originHandler as Function)("https://staging.stellopay.com", cbB);
    expect(cbA).toHaveBeenCalledWith(null, true);
    expect(cbB).toHaveBeenCalledWith(null, true);
  });

  it("production + explicit allowlist: no warning logged", () => {
    resolveCorsConfig("https://app.stellopay.com", "production");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("non-dev throw error references the NODE_ENV value", () => {
    expect(() => resolveCorsConfig(undefined, "production")).toThrow(/NODE_ENV=production/);
  });
});

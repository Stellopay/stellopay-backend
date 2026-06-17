import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCorsOrigin, buildCorsOriginHandler } from "./cors.js";

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

  // ── Wildcard ──────────────────────────────────────────────────────────────

  it("wildcard: originHandler is true and credentials is false", () => {
    const { originHandler, credentials } = buildCorsOriginHandler("*");
    expect(originHandler).toBe(true);
    expect(credentials).toBe(false);
  });

  it("wildcard: logs a warning in development", () => {
    buildCorsOriginHandler("*", "development");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Wildcard origin"));
  });

  it("wildcard: logs a SECURITY WARNING in production", () => {
    buildCorsOriginHandler("*", "production");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("SECURITY WARNING"));
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


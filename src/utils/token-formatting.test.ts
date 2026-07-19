import { describe, it, expect } from "vitest";
import { formatTokenAmount, getTokenInfo } from "./token-formatting.js";

// Default known-token addresses from token-formatting.ts (TOKEN_* env vars are
// unset in the test env, so the module falls back to these).
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const USDC = "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080";
const USDT = "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb";

describe("formatTokenAmount", () => {
  it("returns '0' for empty-ish inputs", () => {
    expect(formatTokenAmount(null, 18)).toBe("0");
    expect(formatTokenAmount(undefined, 18)).toBe("0");
    expect(formatTokenAmount("", 18)).toBe("0");
    expect(formatTokenAmount("0", 18)).toBe("0");
    expect(formatTokenAmount(0n, 18)).toBe("0");
  });

  it("formats 6-decimal amounts (USDC-style)", () => {
    expect(formatTokenAmount("1500000", 6)).toBe("1.5");
    expect(formatTokenAmount("123456", 6)).toBe("0.123456");
    expect(formatTokenAmount("1000000", 6)).toBe("1");
    expect(formatTokenAmount("1", 6)).toBe("0.000001");
  });

  it("formats 18-decimal amounts (STRK-style)", () => {
    expect(formatTokenAmount("1500000000000000000", 18)).toBe("1.5");
    expect(formatTokenAmount("1", 18)).toBe("0.000000000000000001");
    expect(formatTokenAmount(2000000000000000000n, 18)).toBe("2");
  });

  // Regression for issue #140: decimals above 18 must keep full precision.
  it("formats amounts with more than 18 decimals without loss", () => {
    expect(formatTokenAmount("1500000000000000000000000", 24)).toBe("1.5");
    expect(formatTokenAmount("1", 24)).toBe("0.000000000000000000000001");
    expect(formatTokenAmount("123456789012345678901234567890123456", 24)).toBe(
      "123456789012.345678901234567890123456",
    );
    expect(formatTokenAmount("1" + "0".repeat(30), 30)).toBe("1");
    expect(formatTokenAmount("1500000000000000000000000000001", 30)).toBe(
      "1.500000000000000000000000000001",
    );
  });

  it("handles u256-scale values beyond Number precision", () => {
    // 2^256 - 1
    const maxU256 = (1n << 256n) - 1n;
    expect(formatTokenAmount(maxU256, 18)).toBe(
      "115792089237316195423570985008687907853269984665640564039457.584007913129639935",
    );
  });

  it("formats with 0 decimals as a plain integer", () => {
    expect(formatTokenAmount("42", 0)).toBe("42");
  });

  // Regression: BigInt / and % carry the sign, which previously produced
  // output like "-1.-5" and dropped the sign for values between -1 and 0.
  it("formats negative amounts correctly", () => {
    expect(formatTokenAmount("-1500000", 6)).toBe("-1.5");
    expect(formatTokenAmount("-500000", 6)).toBe("-0.5");
    expect(formatTokenAmount(-1n, 24)).toBe("-0.000000000000000000000001");
    expect(formatTokenAmount("-3000000", 6)).toBe("-3");
  });
});

describe("getTokenInfo", () => {
  it("returns placeholder info for missing addresses", () => {
    expect(getTokenInfo(null)).toEqual({ name: "-", icon: "", decimals: 0, isSTRK: false });
    expect(getTokenInfo(undefined)).toEqual({ name: "-", icon: "", decimals: 0, isSTRK: false });
    expect(getTokenInfo("")).toEqual({ name: "-", icon: "", decimals: 0, isSTRK: false });
  });

  it("resolves known tokens with their decimals", () => {
    expect(getTokenInfo(STRK)).toEqual({ name: "STRK", icon: "/strk-logo.png", decimals: 18, isSTRK: true });
    expect(getTokenInfo(USDC)).toEqual({ name: "USDC", icon: "/usdc-logo.png", decimals: 6, isSTRK: false });
    expect(getTokenInfo(USDT)).toEqual({ name: "USDT", icon: "/usdt-logo.png", decimals: 6, isSTRK: false });
  });

  it("normalizes address casing/padding before matching", () => {
    expect(getTokenInfo(STRK.toUpperCase().replace("0X", "0x")).name).toBe("STRK");
    expect(getTokenInfo("0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d").name).toBe("STRK");
  });

  it("defaults unknown addresses to USDC-style 6 decimals", () => {
    expect(getTokenInfo("0x0000000000000000000000000000000000000000000000000000000000000123")).toEqual({
      name: "USDC",
      icon: "/usdc-logo.png",
      decimals: 6,
      isSTRK: false,
    });
  });
});

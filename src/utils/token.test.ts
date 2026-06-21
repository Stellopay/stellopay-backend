import { describe, it, expect } from "vitest";
import { tokenDecimals } from "./token";

const STRK =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const USDC =
  "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080";

describe("tokenDecimals", () => {
  it("returns 18 for STRK", () => {
    expect(tokenDecimals(STRK)).toBe(18);
  });

  it("matches STRK regardless of case or a stripped leading zero", () => {
    expect(tokenDecimals(STRK.toUpperCase().replace("0X", "0x"))).toBe(18);
    expect(tokenDecimals(STRK.replace("0x04", "0x4"))).toBe(18);
  });

  it("returns 6 for USDC and other 6-decimal tokens", () => {
    expect(tokenDecimals(USDC)).toBe(6);
  });

  it("returns 6 for an unknown token", () => {
    expect(tokenDecimals("0x123")).toBe(6);
  });

  it("returns 6 for null or undefined", () => {
    expect(tokenDecimals(null)).toBe(6);
    expect(tokenDecimals(undefined)).toBe(6);
  });

  it("returns 6 for a malformed address instead of throwing", () => {
    expect(tokenDecimals("not-hex-zzz")).toBe(6);
    expect(tokenDecimals("")).toBe(6);
  });
});

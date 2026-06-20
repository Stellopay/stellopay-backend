import { describe, it, expect } from "vitest";
import {
  parseU256,
  u256ToString,
  toHexString,
  formatTokenAmount,
  DEFAULT_TOKEN_DECIMALS,
} from "./codec";

describe("parseU256", () => {
  it("splits a small value into low/high (high = 0)", () => {
    const r = parseU256("5") as { low: unknown; high: unknown };
    expect(BigInt(r.low as never)).toBe(5n);
    expect(BigInt(r.high as never)).toBe(0n);
  });

  it("splits a value above 2^128 across low and high", () => {
    const value = (1n << 128n) + 7n;
    const r = parseU256(value.toString()) as { low: unknown; high: unknown };
    expect(BigInt(r.low as never)).toBe(7n);
    expect(BigInt(r.high as never)).toBe(1n);
  });
});

describe("u256ToString", () => {
  it("passes through bigint, number and string inputs", () => {
    expect(u256ToString(42n)).toBe("42");
    expect(u256ToString(42)).toBe("42");
    expect(u256ToString("42")).toBe("42");
  });

  it("recombines a { low, high } object", () => {
    expect(u256ToString({ low: "7", high: "1" })).toBe(((1n << 128n) + 7n).toString());
    expect(u256ToString({ low: 5n, high: 0n })).toBe("5");
  });

  it("falls back to JSON for unknown shapes", () => {
    expect(u256ToString({ foo: "bar" })).toBe(JSON.stringify({ foo: "bar" }));
  });
});

describe("toHexString", () => {
  it("prefixes a bare hex string with 0x", () => {
    expect(toHexString("abc")).toBe("0xabc");
  });

  it("leaves an existing 0x string unchanged", () => {
    expect(toHexString("0xabc")).toBe("0xabc");
  });

  it("converts bigint and number values to hex", () => {
    expect(toHexString(255n)).toBe("0xff");
    expect(toHexString(16)).toBe("0x10");
  });
});

describe("formatTokenAmount", () => {
  it("defaults to 6 decimals (USDC/USDT) and trims trailing zeros", () => {
    expect(DEFAULT_TOKEN_DECIMALS).toBe(6);
    expect(formatTokenAmount("1500000")).toBe("1.5");
    expect(formatTokenAmount("1234560")).toBe("1.23456");
  });

  it("returns whole amounts without a fractional part", () => {
    expect(formatTokenAmount("1000000")).toBe("1");
    expect(formatTokenAmount("5000000")).toBe("5");
  });

  it("returns 0 for a zero amount", () => {
    expect(formatTokenAmount("0")).toBe("0");
    expect(formatTokenAmount(0n)).toBe("0");
  });

  it("accepts a bigint and preserves leading fractional zeros", () => {
    expect(formatTokenAmount(1000001n)).toBe("1.000001");
    expect(formatTokenAmount(7n)).toBe("0.000007");
  });

  it("supports an 18-decimal token (STRK)", () => {
    expect(formatTokenAmount("1000000000000000000", 18)).toBe("1");
    expect(formatTokenAmount("1234000000000000000", 18)).toBe("1.234");
  });

  it("treats 0 decimals as a plain integer", () => {
    expect(formatTokenAmount("42", 0)).toBe("42");
    expect(formatTokenAmount(-42n, 0)).toBe("-42");
  });

  it("formats negative amounts", () => {
    expect(formatTokenAmount(-1500000n)).toBe("-1.5");
    expect(formatTokenAmount("-1000000")).toBe("-1");
  });

  it("stays precise for amounts above Number.MAX_SAFE_INTEGER", () => {
    const raw = "12345678901234567890";
    // formatTokenAmount keeps every digit.
    expect(formatTokenAmount(raw)).toBe("12345678901234.56789");
    // The legacy Number(raw) / 1e6 conversion silently loses the trailing digits.
    const legacy = (Number(raw) / 1_000_000).toString();
    expect(legacy).not.toBe("12345678901234.56789");
  });

  it("formats the full u256 max without precision loss", () => {
    const u256Max = (1n << 256n) - 1n;
    expect(formatTokenAmount(u256Max)).toBe(
      "115792089237316195423570985008687907853269984665640564039457584007913129.639935"
    );
  });

  it("rejects a non-integer or negative decimals argument", () => {
    expect(() => formatTokenAmount("1000000", 1.5)).toThrow(RangeError);
    expect(() => formatTokenAmount("1000000", -1)).toThrow(RangeError);
  });

  it("rejects malformed amount strings before reaching BigInt", () => {
    expect(() => formatTokenAmount("1.5")).toThrow(TypeError);
    expect(() => formatTokenAmount("not-a-number")).toThrow(TypeError);
    expect(() => formatTokenAmount("")).toThrow(TypeError);
  });
});

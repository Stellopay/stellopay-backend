import { describe, it, expect } from "vitest";
import { parseU256, u256ToString, toHexString } from "./codec";

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

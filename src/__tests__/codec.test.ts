import { describe, it, expect } from "vitest";
import {
  u256ToString,
  toHexString,
  normalizeStarknetAddress,
  normalizeTransactionHash,
} from "../utils/codec.js";

describe("u256ToString", () => {
  it("passes through a string", () => {
    expect(u256ToString("12345")).toBe("12345");
  });

  it("converts a bigint", () => {
    expect(u256ToString(42n)).toBe("42");
  });

  it("converts a number", () => {
    expect(u256ToString(100)).toBe("100");
  });

  it("decodes { low, high } uint256 representation", () => {
    expect(u256ToString({ low: 1n, high: 0n })).toBe("1");
    expect(u256ToString({ low: 0n, high: 1n })).toBe((1n << 128n).toString());
  });

  it("falls back to JSON for unknown shapes", () => {
    expect(u256ToString(null)).toBe("null");
  });
});

describe("toHexString", () => {
  it("converts bigint to 0x-prefixed hex", () => {
    expect(toHexString(255n)).toBe("0x" + "ff");
    expect(toHexString(0n)).toBe("0x0");
  });

  it("converts number to hex", () => {
    expect(toHexString(16)).toBe("0x10");
  });

  it("leaves already-prefixed string unchanged", () => {
    expect(toHexString("0xdeadbeef")).toBe("0xdeadbeef");
  });

  it("adds 0x prefix to bare hex string", () => {
    expect(toHexString("deadbeef")).toBe("0xdeadbeef");
  });
});

describe("normalizeStarknetAddress", () => {
  const full = "0x" + "0".repeat(63) + "1";

  it("lowercases mixed-case input", () => {
    expect(normalizeStarknetAddress("0xABCDEF")).toBe("0x" + "0".repeat(58) + "abcdef");
  });

  it("pads a short address to 66 chars total", () => {
    const result = normalizeStarknetAddress("0x1");
    expect(result).toBe(full);
    expect(result).toHaveLength(66);
  });

  it("adds 0x prefix when missing", () => {
    expect(normalizeStarknetAddress("1")).toBe(full);
  });

  it("preserves a leading-zero address that is already full length", () => {
    const addr = "0x" + "0".repeat(63) + "a";
    expect(normalizeStarknetAddress(addr)).toBe(addr);
    expect(normalizeStarknetAddress(addr)).toHaveLength(66);
  });

  it("returns the input unchanged if already canonical", () => {
    const canonical = "0x0" + "0".repeat(62) + "a";
    expect(normalizeStarknetAddress(canonical)).toBe(canonical);
  });
});

describe("normalizeTransactionHash", () => {
  it("pads to 66 chars", () => {
    const result = normalizeTransactionHash("0x1");
    expect(result).toHaveLength(66);
    expect(result).toBe("0x" + "0".repeat(63) + "1");
  });

  it("does not re-pad a 66-char hash (preserves leading zeros)", () => {
    const hash = "0x" + "0".repeat(10) + "a".repeat(54);
    expect(normalizeTransactionHash(hash)).toBe(hash);
  });

  it("lowercases input", () => {
    const result = normalizeTransactionHash("0xDEADBEEF");
    expect(result).toBe("0x" + "0".repeat(56) + "deadbeef");
  });
});

import { getChecksumAddress } from "starknet";
import { describe, expect, it } from "vitest";
import { normalizeStarknetAddress } from "./address.js";

const zeroAddress = `0x${"0".repeat(64)}`;
const oneAddress = `0x${"0".repeat(63)}1`;
const fullAddress = `0x${"a".repeat(64)}`;

describe("normalizeStarknetAddress", () => {
  it("normalizes missing prefixes, mixed case, whitespace, and short values", () => {
    expect(normalizeStarknetAddress("1")).toBe(oneAddress);
    expect(normalizeStarknetAddress("  0XABC  ")).toBe(`0x${"0".repeat(61)}abc`);
    expect(normalizeStarknetAddress(fullAddress.toUpperCase())).toBe(fullAddress);
  });
  it("strips redundant leading zeros before padding to the canonical form", () => {
    expect(normalizeStarknetAddress("0x0001")).toBe(oneAddress);
    expect(normalizeStarknetAddress(`0x${"0".repeat(70)}1`)).toBe(oneAddress);
  });
  it("keeps the all-zero address canonical and collision-free", () => {
    expect(normalizeStarknetAddress("0x0")).toBe(zeroAddress);
    expect(normalizeStarknetAddress(`0x${"0".repeat(64)}`)).toBe(zeroAddress);
  });
  it("matches the previous route variants after choosing the canonical trimmed form", () => {
    const routeVariant = (addr: string) => {
      let normalized = addr.toLowerCase();
      if (!normalized.startsWith("0x")) {
        normalized = `0x${normalized}`;
      }
      const hex = normalized.replace(/^0x/, "");
      return `0x${hex.padStart(64, "0")}`;
    };
    const transactionsVariant = (addr: string) => {
      let normalized = addr.toLowerCase().trim();
      if (!normalized.startsWith("0x")) {
        normalized = `0x${normalized}`;
      }
      const hex = normalized.replace(/^0x/, "");
      const trimmedHex = hex.replace(/^0+/, "") || "0";
      return `0x${trimmedHex.padStart(64, "0")}`;
    };
    const alreadyCanonical = oneAddress;
    expect(normalizeStarknetAddress(alreadyCanonical)).toBe(routeVariant(alreadyCanonical));
    expect(normalizeStarknetAddress("0x0001")).toBe(transactionsVariant("0x0001"));
    expect(normalizeStarknetAddress("0x0001")).toBe(normalizeStarknetAddress("0x1"));
  });
  it("rejects empty, non-hex, and wider-than-felt values", () => {
    expect(() => normalizeStarknetAddress("")).toThrow(/required/);
    expect(() => normalizeStarknetAddress("0xgg")).toThrow(/hex/);
    expect(() => normalizeStarknetAddress(`0x1${"0".repeat(64)}`)).toThrow(/exceeds/);
  });

  describe("checksum validation", () => {
    const sampleAddress = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
    const checksummed = getChecksumAddress(sampleAddress);

    it("computes a checksum that mixes upper and lower case", () => {
      expect(checksummed).not.toBe(sampleAddress);
      expect(checksummed).not.toBe(sampleAddress.toUpperCase());
    });

    it("accepts a valid checksummed address and returns its canonical lowercase form", () => {
      expect(normalizeStarknetAddress(checksummed)).toBe(sampleAddress);
    });

    it("rejects a checksummed address with a single flipped character case", () => {
      const hexBody = checksummed.slice(2);
      const letterIndex = [...hexBody].findIndex((char) => /[a-fA-F]/.test(char));
      const char = hexBody[letterIndex];
      const flippedChar = char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
      const flippedHexBody =
        hexBody.slice(0, letterIndex) + flippedChar + hexBody.slice(letterIndex + 1);
      const bitFlipped = `0x${flippedHexBody}`;

      expect(() => normalizeStarknetAddress(bitFlipped)).toThrow(/checksum/);
    });

    it("still accepts an all-lowercase or all-uppercase address with no checksum info", () => {
      expect(normalizeStarknetAddress(sampleAddress)).toBe(sampleAddress);
      expect(normalizeStarknetAddress(sampleAddress.toUpperCase())).toBe(sampleAddress);
    });
  });
});

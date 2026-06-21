import { describe, it, expect } from "vitest";
import {
  StarknetAddress,
  AgreementId,
  parsePagination,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
} from "./validation";

describe("StarknetAddress", () => {
  it("accepts a 0x-prefixed hex address and returns the normalized form", () => {
    const out = StarknetAddress.parse(
      "0x4718F5a0FC34Cc1AF16A1cdee98ffB20C31f5cd61d6ab07201858f4287c938d"
    );
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("accepts a bare hex address without the 0x prefix and normalizes it", () => {
    expect(StarknetAddress.parse("abc")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects a non-hex address", () => {
    expect(() => StarknetAddress.parse("0xnothexvalue")).toThrow();
    expect(() => StarknetAddress.parse("not-an-address")).toThrow();
  });

  it("rejects an address longer than 64 hex characters", () => {
    expect(() => StarknetAddress.parse(`0x${"a".repeat(65)}`)).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => StarknetAddress.parse("")).toThrow();
  });
});

describe("AgreementId", () => {
  it("accepts a numeric string", () => {
    expect(AgreementId.parse("42")).toBe("42");
  });

  it("rejects a non-numeric id", () => {
    expect(() => AgreementId.parse("12ab")).toThrow();
    expect(() => AgreementId.parse("")).toThrow();
  });
});

describe("parsePagination", () => {
  it("uses defaults when params are missing", () => {
    expect(parsePagination({})).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
    expect(parsePagination(undefined)).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("clamps an oversized limit down to the max", () => {
    expect(parsePagination({ limit: "5000" })).toEqual({
      limit: MAX_PAGE_LIMIT,
      offset: 0,
    });
  });

  it("clamps a zero or negative limit up to 1", () => {
    expect(parsePagination({ limit: "0" }).limit).toBe(1);
    expect(parsePagination({ limit: "-9" }).limit).toBe(1);
  });

  it("floors a negative offset to 0 and passes valid values through", () => {
    expect(parsePagination({ offset: "-3" }).offset).toBe(0);
    expect(parsePagination({ limit: "10", offset: "20" })).toEqual({
      limit: 10,
      offset: 20,
    });
  });

  it("falls back to defaults for non-numeric values", () => {
    expect(parsePagination({ limit: "abc", offset: "xyz" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });
});

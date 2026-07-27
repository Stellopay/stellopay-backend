import { describe, it, expect, vi, beforeEach } from "vitest";
import { tokenDecimals, erc20Decimals, erc20Symbol, clearTokenMetadataCaches } from "./token";

const STRK =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const USDC =
  "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080";

const mockCallContract = vi.fn();

vi.mock("../starknet/client.js", () => ({
  provider: { callContract: mockCallContract },
}));

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

describe("erc20Decimals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenMetadataCaches();
  });

  it("calls RPC on first invocation and caches result", async () => {
    mockCallContract.mockResolvedValue(["0x12"]);

    const result1 = await erc20Decimals("0xabc123");
    const result2 = await erc20Decimals("0xabc123");

    expect(result1).toBe(18);
    expect(result2).toBe(18);
    expect(mockCallContract).toHaveBeenCalledTimes(1);
  });

  it("normalizes address before caching to prevent duplicate entries", async () => {
    mockCallContract.mockResolvedValue(["0x6"]);

    await erc20Decimals("0xabc123");
    await erc20Decimals("0xABC123"); // Different case

    expect(mockCallContract).toHaveBeenCalledTimes(1);
  });

  it("strips leading zeros before caching to prevent duplicate entries", async () => {
    mockCallContract.mockResolvedValue(["0x6"]);

    await erc20Decimals("0x000abc");
    await erc20Decimals("0xabc");

    expect(mockCallContract).toHaveBeenCalledTimes(1);
  });

  it("throws on invalid RPC result", async () => {
    mockCallContract.mockResolvedValue([]);

    await expect(erc20Decimals("0xabc")).rejects.toThrow("Unexpected decimals result");
  });

  it("throws on undefined RPC result", async () => {
    mockCallContract.mockResolvedValue(undefined);

    await expect(erc20Decimals("0xabc")).rejects.toThrow("Unexpected decimals result");
  });

  it("clearTokenMetadataCaches clears the cache", async () => {
    mockCallContract.mockResolvedValue(["0x6"]);

    await erc20Decimals("0xabc");
    clearTokenMetadataCaches();
    await erc20Decimals("0xabc");

    expect(mockCallContract).toHaveBeenCalledTimes(2);
  });

  it("cache size stays bounded under many distinct addresses", async () => {
    mockCallContract.mockResolvedValue(["0x6"]);

    // Fill cache beyond max size (100)
    for (let i = 0; i < 150; i++) {
      await erc20Decimals(`0x${i.toString(16).padStart(64, "0")}`);
    }

    // Access the first address again - should trigger RPC call due to eviction
    mockCallContract.mockClear();
    await erc20Decimals(`0x${"0".repeat(64)}`);

    expect(mockCallContract).toHaveBeenCalledTimes(1);
  });
});

describe("erc20Symbol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenMetadataCaches();
  });

  it("calls RPC on first invocation and caches result", async () => {
    mockCallContract.mockResolvedValue(["0x55534443"]);

    const result1 = await erc20Symbol("0xabc123");
    const result2 = await erc20Symbol("0xabc123");

    expect(result1).toBe("USDC");
    expect(result2).toBe("USDC");
    expect(mockCallContract).toHaveBeenCalledTimes(1);
  });

  it("decodes short-string symbol", async () => {
    mockCallContract.mockResolvedValue(["0x55534443"]);

    const result = await erc20Symbol("0xabc");

    expect(result).toBe("USDC");
  });

  it("falls back to raw value when decode fails", async () => {
    mockCallContract.mockResolvedValue(["raw-symbol"]);

    const result = await erc20Symbol("0xabc");

    expect(result).toBe("raw-symbol");
  });

  it("normalizes address before caching to prevent duplicate entries", async () => {
    mockCallContract.mockResolvedValue(["0x55534443"]);

    await erc20Symbol("0xabc123");
    await erc20Symbol("0xABC123"); // Different case

    expect(mockCallContract).toHaveBeenCalledTimes(1);
  });

  it("throws on invalid RPC result", async () => {
    mockCallContract.mockResolvedValue([]);

    await expect(erc20Symbol("0xabc")).rejects.toThrow("Unexpected symbol result");
  });

  it("throws on undefined RPC result", async () => {
    mockCallContract.mockResolvedValue(undefined);

    await expect(erc20Symbol("0xabc")).rejects.toThrow("Unexpected symbol result");
  });

  it("clearTokenMetadataCaches clears the cache", async () => {
    mockCallContract.mockResolvedValue(["0x55534443"]);

    await erc20Symbol("0xabc");
    clearTokenMetadataCaches();
    await erc20Symbol("0xabc");

    expect(mockCallContract).toHaveBeenCalledTimes(2);
  });

  it("cache size stays bounded under many distinct addresses", async () => {
    mockCallContract.mockResolvedValue(["0x55534443"]);

    // Fill cache beyond max size (100)
    for (let i = 0; i < 150; i++) {
      await erc20Symbol(`0x${i.toString(16).padStart(64, "0")}`);
    }

    // Access the first address again - should trigger RPC call due to eviction
    mockCallContract.mockClear();
    await erc20Symbol(`0x${"0".repeat(64)}`);

    expect(mockCallContract).toHaveBeenCalledTimes(1);
  });
});

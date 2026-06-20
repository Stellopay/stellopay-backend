import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { provider, getCachedNetworkInfo, clearNetworkCache } from "./client.js";

describe("Starknet Client Cache", () => {
  let getChainIdSpy: any;
  let getSpecVersionSpy: any;

  beforeEach(() => {
    // Clear cache before each test
    clearNetworkCache();

    // Mock the provider methods
    getChainIdSpy = vi.spyOn(provider, "getChainId").mockResolvedValue("0x534e5f4d41494e"); // SN_MAIN
    getSpecVersionSpy = vi.spyOn(provider, "getSpecVersion").mockResolvedValue("0.6.0");

    // Mock Date.now to control time
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should fetch from RPC on first call", async () => {
    const info = await getCachedNetworkInfo();

    expect(info.chainId).toBe("0x534e5f4d41494e");
    expect(info.specVersion).toBe("0.6.0");
    expect(getChainIdSpy).toHaveBeenCalledTimes(1);
    expect(getSpecVersionSpy).toHaveBeenCalledTimes(1);
  });

  it("should serve from cache on subsequent calls within TTL", async () => {
    await getCachedNetworkInfo();
    const info2 = await getCachedNetworkInfo();

    expect(info2.chainId).toBe("0x534e5f4d41494e");
    expect(getChainIdSpy).toHaveBeenCalledTimes(1); // Still 1, not 2
    expect(getSpecVersionSpy).toHaveBeenCalledTimes(1);
  });

  it("should fetch from RPC again after TTL expires", async () => {
    const TTL = 300000; // 5 mins
    await getCachedNetworkInfo(TTL);

    // Advance time past TTL
    vi.advanceTimersByTime(TTL + 1000);

    const info2 = await getCachedNetworkInfo(TTL);

    expect(info2.chainId).toBe("0x534e5f4d41494e");
    expect(getChainIdSpy).toHaveBeenCalledTimes(2); // Called again
    expect(getSpecVersionSpy).toHaveBeenCalledTimes(2);
  });

  it("should not poison cache on RPC failure", async () => {
    // Make RPC fail
    getChainIdSpy.mockRejectedValueOnce(new Error("RPC Error"));

    await expect(getCachedNetworkInfo()).rejects.toThrow("RPC Error");

    // Fix RPC
    getChainIdSpy.mockResolvedValueOnce("0x534e5f4d41494e");

    // Second call should succeed because cache was not set
    const info = await getCachedNetworkInfo();
    expect(info.chainId).toBe("0x534e5f4d41494e");
    expect(getChainIdSpy).toHaveBeenCalledTimes(2); // 1 failed, 1 succeeded
  });
});

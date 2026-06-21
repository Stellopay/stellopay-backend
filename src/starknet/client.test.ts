import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import {
  provider,
  getCachedNetworkInfo,
  clearNetworkCache,
  escrowContract,
  agreementContract,
  clearContractCache,
} from "./client.js";

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

describe("ABI memoization and contract caching", () => {
  // Both are valid Starknet felts (the configured contract defaults), used here
  // only as two distinct addresses for the cache.
  const ADDR_A = "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4";
  const ADDR_B = "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd";

  let readSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearContractCache();
    // Spy without stubbing: real fixture reads still happen, we only count them.
    readSpy = vi.spyOn(fs, "readFileSync");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Counts how many times a given contract-class file was read from disk. */
  function diskReads(fragment: string): number {
    return readSpy.mock.calls.filter((c) => String(c[0]).includes(fragment)).length;
  }

  it("reads each ABI file from disk at most once across many calls", () => {
    escrowContract(ADDR_A);
    escrowContract(ADDR_A);
    agreementContract(ADDR_A);
    agreementContract(ADDR_A);

    expect(diskReads("PayrollEscrow.contract_class.json")).toBe(1);
    expect(diskReads("WorkAgreement.contract_class.json")).toBe(1);
  });

  it("reuses one Contract instance for repeated calls with the same address", () => {
    const first = escrowContract(ADDR_A);
    const second = escrowContract(ADDR_A);
    expect(second).toBe(first);
  });

  it("returns distinct instances per address without re-reading the ABI", () => {
    const a = escrowContract(ADDR_A);
    const b = escrowContract(ADDR_B);

    expect(b).not.toBe(a);
    // The ABI is memoized, so a second address does not trigger another read.
    expect(diskReads("PayrollEscrow.contract_class.json")).toBe(1);
  });

  it("never reuses an escrow instance for an agreement at the same address", () => {
    const escrow = escrowContract(ADDR_A);
    const agreement = agreementContract(ADDR_A);
    expect(agreement).not.toBe(escrow);
  });

  it("re-reads the ABI from disk after clearContractCache", () => {
    const before = escrowContract(ADDR_A);
    clearContractCache();
    const after = escrowContract(ADDR_A);

    expect(after).not.toBe(before);
    expect(diskReads("PayrollEscrow.contract_class.json")).toBe(2);
  });
});

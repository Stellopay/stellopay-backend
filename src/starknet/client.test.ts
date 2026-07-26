import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

const mockRpcProviders = vi.hoisted(() =>
  [] as Array<{
    nodeUrl: string;
    getChainId: ReturnType<typeof vi.fn>;
    getSpecVersion: ReturnType<typeof vi.fn>;
    getBlock: ReturnType<typeof vi.fn>;
  }>,
);

vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  class MockRpcProvider {
    nodeUrl: string;
    getChainId: ReturnType<typeof vi.fn>;
    getSpecVersion: ReturnType<typeof vi.fn>;
    getBlock: ReturnType<typeof vi.fn>;

    constructor({ nodeUrl }: { nodeUrl: string }) {
      this.nodeUrl = nodeUrl;
      this.getChainId = vi.fn();
      this.getSpecVersion = vi.fn().mockResolvedValue("0.6.0");
      this.getBlock = vi.fn();
      mockRpcProviders.push(this);
    }
  }
  return {
    ...actual,
    RpcProvider: MockRpcProvider as unknown as typeof actual.RpcProvider,
  };
});

import {
  provider,
  getCachedNetworkInfo,
  clearNetworkCache,
  escrowContract,
  agreementContract,
  clearContractCache,
  resetRpcFailoverForTests,
} from "./client.js";

const VITEST_POSTGRES =
  process.env.POSTGRES_CONNECTION_STRING ??
  "postgresql://postgres:postgres@localhost:5432/stellopay_indexer";

describe("Starknet Client Cache", () => {
  let getChainIdSpy: ReturnType<typeof vi.fn>;
  let getSpecVersionSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetRpcFailoverForTests();
    clearNetworkCache();

    getChainIdSpy = vi.spyOn(provider, "getChainId").mockResolvedValue("0x534e5f4d41494e");
    getSpecVersionSpy = vi.spyOn(provider, "getSpecVersion").mockResolvedValue("0.6.0");

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
    expect(getChainIdSpy).toHaveBeenCalledTimes(1);
    expect(getSpecVersionSpy).toHaveBeenCalledTimes(1);
  });

  it("should fetch from RPC again after TTL expires", async () => {
    const TTL = 300000;
    await getCachedNetworkInfo(TTL);

    vi.advanceTimersByTime(TTL + 1000);

    const info2 = await getCachedNetworkInfo(TTL);

    expect(info2.chainId).toBe("0x534e5f4d41494e");
    expect(getChainIdSpy).toHaveBeenCalledTimes(2);
    expect(getSpecVersionSpy).toHaveBeenCalledTimes(2);
  });

  it("should not poison cache on RPC failure", async () => {
    getChainIdSpy.mockRejectedValueOnce(new Error("RPC Error"));

    await expect(getCachedNetworkInfo()).rejects.toThrow("RPC Error");

    getChainIdSpy.mockResolvedValueOnce("0x534e5f4d41494e");

    const info = await getCachedNetworkInfo();
    expect(info.chainId).toBe("0x534e5f4d41494e");
    expect(getChainIdSpy).toHaveBeenCalledTimes(2);
  });
});

describe("ABI memoization and contract caching", () => {
  const ADDR_A = "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4";
  const ADDR_B = "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd";

  let readSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearContractCache();
    readSpy = vi.spyOn(fs, "readFileSync");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

describe("RPC endpoint failover", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadClientWithRpcUrls(rpcEnv: string) {
    vi.resetModules();
    mockRpcProviders.length = 0;
    process.env.STARKNET_RPC_URL = rpcEnv;
    process.env.POSTGRES_CONNECTION_STRING = VITEST_POSTGRES;
    return import("./client.js");
  }

  it("uses a single configured endpoint when only one URL is set", async () => {
    const client = await loadClientWithRpcUrls("https://only.example/rpc");
    client.resetRpcFailoverForTests();

    const primary = mockRpcProviders[0]!;
    primary.getChainId.mockResolvedValue("0x1");
    primary.getSpecVersion.mockResolvedValue("0.6.0");

    await client.getCachedNetworkInfo();
    await client.getCachedNetworkInfo();

    expect(mockRpcProviders).toHaveLength(1);
    expect(primary.getChainId).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to the next URL when the primary RPC call fails", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.clearNetworkCache();

    const [primary, secondary] = mockRpcProviders;
    primary!.getChainId.mockRejectedValue(new Error("primary down"));
    primary!.getSpecVersion.mockRejectedValue(new Error("primary down"));
    secondary!.getChainId.mockResolvedValue("0x534e5f4d41494e");
    secondary!.getSpecVersion.mockResolvedValue("0.6.0");

    const info = await client.getCachedNetworkInfo();
    expect(info.chainId).toBe("0x534e5f4d41494e");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://primary.example/rpc"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://secondary.example/rpc"),
    );
  });

  it("reuses the healthy endpoint on later calls without retrying the dead primary", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.clearNetworkCache();

    const [primary, secondary] = mockRpcProviders;
    primary!.getChainId.mockRejectedValue(new Error("primary down"));
    primary!.getSpecVersion.mockRejectedValue(new Error("primary down"));
    secondary!.getChainId.mockResolvedValue("0x534e5f4d41494e");
    secondary!.getSpecVersion.mockResolvedValue("0.6.0");

    await client.getCachedNetworkInfo();
    client.clearNetworkCache();
    primary!.getChainId.mockClear();
    primary!.getSpecVersion.mockClear();
    secondary!.getChainId.mockClear();
    secondary!.getSpecVersion.mockClear();

    await client.getCachedNetworkInfo();

    expect(primary!.getChainId).not.toHaveBeenCalled();
    expect(primary!.getSpecVersion).not.toHaveBeenCalled();
    expect(secondary!.getChainId).toHaveBeenCalledTimes(1);
    expect(secondary!.getSpecVersion).toHaveBeenCalledTimes(1);
  });

  it("retries with a fresh copy of the request arguments", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    const request = {
      blockIdentifier: "latest",
      pagination: { offset: 0, limit: 10 },
    };

    primary!.getBlock.mockImplementationOnce((payload: typeof request) => {
      payload.pagination.limit = 99;
      throw new Error("primary down");
    });
    secondary!.getBlock.mockImplementationOnce((payload: typeof request) => {
      return Promise.resolve({ blockNumber: 1, pagination: payload.pagination });
    });

    const result = await client.provider.getBlock(request);

    expect(result).toEqual({ blockNumber: 1, pagination: { offset: 0, limit: 10 } });
    expect(request.pagination.limit).toBe(10);
    expect(secondary!.getBlock).toHaveBeenCalledTimes(1);
    expect(secondary!.getBlock.mock.calls[0]?.[0]).toEqual(request);
  });
});

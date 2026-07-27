import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

/**
 * COMPATIBILITY TESTS: src/starknet/client.ts
 *
 * These tests verify the compatibility contract defined in client.ts.
 * They cover both success paths and failure/boundary paths to ensure
 * the module behaves as documented and maintains backward compatibility.
 */

const mockRpcProviders = vi.hoisted(() =>
  [] as Array<{
    nodeUrl: string;
    getChainId: ReturnType<typeof vi.fn>;
    getSpecVersion: ReturnType<typeof vi.fn>;
    getBlock: ReturnType<typeof vi.fn>;
    addTransaction: ReturnType<typeof vi.fn>;
    getNonceForAddress: ReturnType<typeof vi.fn>;
    estimateFee: ReturnType<typeof vi.fn>;
    callContract: ReturnType<typeof vi.fn>;
    verifyMessageInStarknet: ReturnType<typeof vi.fn>;
  }>,
);

vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  class MockRpcProvider {
    nodeUrl: string;
    getChainId: ReturnType<typeof vi.fn>;
    getSpecVersion: ReturnType<typeof vi.fn>;
    getBlock: ReturnType<typeof vi.fn>;
    addTransaction: ReturnType<typeof vi.fn>;
    getNonceForAddress: ReturnType<typeof vi.fn>;
    estimateFee: ReturnType<typeof vi.fn>;
    callContract: ReturnType<typeof vi.fn>;
    verifyMessageInStarknet: ReturnType<typeof vi.fn>;

    constructor({ nodeUrl }: { nodeUrl: string }) {
      this.nodeUrl = nodeUrl;
      this.getChainId = vi.fn();
      this.getSpecVersion = vi.fn().mockResolvedValue("0.6.0");
      this.getBlock = vi.fn();
      this.addTransaction = vi.fn();
      this.getNonceForAddress = vi.fn();
      this.estimateFee = vi.fn();
      this.callContract = vi.fn();
      this.verifyMessageInStarknet = vi.fn();
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
  ChainIdMismatchError,
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

  it("throws the last error when all endpoints fail", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.clearNetworkCache();

    const [primary, secondary] = mockRpcProviders;
    primary!.getChainId.mockRejectedValue(new Error("primary down"));
    primary!.getSpecVersion.mockRejectedValue(new Error("primary down"));
    secondary!.getChainId.mockRejectedValue(new Error("secondary down"));
    secondary!.getSpecVersion.mockRejectedValue(new Error("secondary down"));

    await expect(client.getCachedNetworkInfo()).rejects.toThrow("secondary down");
  });

  it("clones complex nested objects during failover", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    primary!.getChainId.mockResolvedValue("0x534e5f4d41494e");
    secondary!.getChainId.mockResolvedValue("0x534e5f4d41494e");
    const complexRequest = {
      nested: {
        array: [1, 2, 3],
        object: { key: "value" },
      },
      date: new Date("2024-01-01"),
    };

    primary!.getBlock.mockImplementationOnce((payload: typeof complexRequest) => {
      payload.nested.array.push(999);
      payload.nested.object.key = "mutated";
      throw new Error("primary down");
    });
    secondary!.getBlock.mockImplementationOnce((payload: typeof complexRequest) => {
      return Promise.resolve({ received: payload });
    });

    const result = await client.provider.getBlock(complexRequest);

    expect(complexRequest.nested.array).toEqual([1, 2, 3]);
    expect(complexRequest.nested.object.key).toBe("value");
    expect(result.received.nested.array).toEqual([1, 2, 3]);
    expect(result.received.nested.object.key).toBe("value");
    expect(secondary!.getBlock).toHaveBeenCalledTimes(1);
  });
});

describe("Method classification — security boundary", () => {
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

  it("does NOT failover for non-retryable (write) methods", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    primary!.addTransaction.mockRejectedValue(new Error("primary down"));
    secondary!.addTransaction.mockResolvedValue({ transaction_hash: "0xabc" });

    await expect(client.provider.addTransaction({})).rejects.toThrow("primary down");

    expect(secondary!.addTransaction).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does failover for retryable (read) methods", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    primary!.getBlock.mockRejectedValue(new Error("primary down"));
    secondary!.getBlock.mockResolvedValue({ block_number: 1 });

    const result = await client.provider.getBlock({ block_identifier: "latest" });

    expect(result).toEqual({ block_number: 1 });
    expect(secondary!.getBlock).toHaveBeenCalledTimes(1);
  });

  it("does failover for getNonceForAddress (read-only)", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    primary!.getNonceForAddress.mockRejectedValue(new Error("primary down"));
    secondary!.getNonceForAddress.mockResolvedValue("0x1");

    const result = await client.provider.getNonceForAddress("0x123", "pending");

    expect(result).toBe("0x1");
    expect(secondary!.getNonceForAddress).toHaveBeenCalledTimes(1);
  });

  it("does failover for estimateFee (read-only fee quote)", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    primary!.estimateFee.mockRejectedValue(new Error("primary down"));
    secondary!.estimateFee.mockResolvedValue({ gas_consumed: 100 });

    const result = await client.provider.estimateFee([]);

    expect(result).toEqual({ gas_consumed: 100 });
    expect(secondary!.estimateFee).toHaveBeenCalledTimes(1);
  });

  it("does failover for callContract (read-only)", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    primary!.callContract.mockRejectedValue(new Error("primary down"));
    secondary!.callContract.mockResolvedValue({ result: ["0x1"] });

    const result = await client.provider.callContract({ contract_address: "0x1", entry_point: "0x2" });

    expect(result).toEqual({ result: ["0x1"] });
    expect(secondary!.callContract).toHaveBeenCalledTimes(1);
  });

  it("does failover for verifyMessageInStarknet (read-only)", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    primary!.verifyMessageInStarknet.mockRejectedValue(new Error("primary down"));
    secondary!.verifyMessageInStarknet.mockResolvedValue(true);

    const result = await client.provider.verifyMessageInStarknet({}, ["0x1"], "0x123");

    expect(result).toBe(true);
    expect(secondary!.verifyMessageInStarknet).toHaveBeenCalledTimes(1);
  });
});

describe("Chain ID validation during failover", () => {
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

  it("succeeds when both endpoints return the same chain ID", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    primary!.getChainId.mockRejectedValueOnce(new Error("primary down"));
    primary!.getChainId.mockResolvedValue("0x534e5f4d41494e");
    secondary!.getChainId.mockResolvedValue("0x534e5f4d41494e");

    const info = await client.getCachedNetworkInfo();

    expect(info.chainId).toBe("0x534e5f4d41494e");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("RPC endpoint failover"),
    );
  });

  it("throws ChainIdMismatchError when endpoints return different chain IDs", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    primary!.getChainId.mockRejectedValueOnce(new Error("primary down"));
    primary!.getChainId.mockResolvedValue("0x534e5f4d41494e");
    secondary!.getChainId.mockResolvedValue("0x534e5f534e5f534e");

    await expect(client.getCachedNetworkInfo()).rejects.toThrow(client.ChainIdMismatchError);
  });

  it("ChainIdMismatchError contains both chain IDs and URLs", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary, secondary] = mockRpcProviders;
    primary!.getChainId.mockRejectedValueOnce(new Error("primary down"));
    primary!.getChainId.mockResolvedValue("0x534e5f4d41494e");
    secondary!.getChainId.mockResolvedValue("0x534e5f534e5f534e");

    try {
      await client.getCachedNetworkInfo();
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(client.ChainIdMismatchError);
      const mismatch = err as InstanceType<typeof client.ChainIdMismatchError>;
      expect(mismatch.primaryChainId).toBe("0x534e5f4d41494e");
      expect(mismatch.secondaryChainId).toBe("0x534e5f534e5f534e");
      expect(mismatch.primaryUrl).toBe("https://primary.example/rpc");
      expect(mismatch.secondaryUrl).toBe("https://secondary.example/rpc");
      expect(mismatch.name).toBe("ChainIdMismatchError");
    }
  });

  it("allows failover to proceed when chain ID validation RPC fails", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.clearNetworkCache();

    const [primary, secondary] = mockRpcProviders;
    primary!.getChainId.mockRejectedValue(new Error("primary down"));
    secondary!.getChainId.mockResolvedValue("0x534e5f4d41494e");

    const info = await client.getCachedNetworkInfo();

    expect(info.chainId).toBe("0x534e5f4d41494e");
  });

  it("is NOT triggered for non-retryable methods (single attempt)", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();

    const [primary] = mockRpcProviders;
    primary!.addTransaction.mockRejectedValue(new Error("primary down"));

    await expect(client.provider.addTransaction({})).rejects.toThrow("primary down");
  });
});

describe("ABI error handling", () => {
  beforeEach(() => {
    clearContractCache();
  });

  it("throws error when ESCROW_CONTRACT_CLASS_JSON is not configured", () => {
    vi.resetModules();
    mockRpcProviders.length = 0;
    process.env.STARKNET_RPC_URL = "https://example.com/rpc";
    process.env.POSTGRES_CONNECTION_STRING = VITEST_POSTGRES;
    process.env.ESCROW_CONTRACT_CLASS_JSON = "";
    process.env.AGREEMENT_CONTRACT_CLASS_JSON = "/fake/path.json";

    return import("./client.js").then((client) => {
      expect(() => client.getEscrowAbi()).toThrow(
        "ESCROW_CONTRACT_CLASS_JSON path is not configured",
      );
    });
  });

  it("throws error when AGREEMENT_CONTRACT_CLASS_JSON is not configured", () => {
    vi.resetModules();
    mockRpcProviders.length = 0;
    process.env.STARKNET_RPC_URL = "https://example.com/rpc";
    process.env.POSTGRES_CONNECTION_STRING = VITEST_POSTGRES;
    process.env.ESCROW_CONTRACT_CLASS_JSON = "/fake/path.json";
    process.env.AGREEMENT_CONTRACT_CLASS_JSON = "";

    return import("./client.js").then((client) => {
      expect(() => client.getAgreementAbi()).toThrow(
        "AGREEMENT_CONTRACT_CLASS_JSON path is not configured",
      );
    });
  });
});

describe("ChainIdMismatchError", () => {
  it("is an instance of Error", () => {
    const err = new ChainIdMismatchError("0x1", "0x2", "https://a", "https://b");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ChainIdMismatchError);
  });

  it("has name set to ChainIdMismatchError", () => {
    const err = new ChainIdMismatchError("0x1", "0x2", "https://a", "https://b");
    expect(err.name).toBe("ChainIdMismatchError");
  });

  it("message includes both chain IDs and URLs", () => {
    const err = new ChainIdMismatchError("0x1", "0x2", "https://a", "https://b");
    expect(err.message).toContain("0x1");
    expect(err.message).toContain("0x2");
    expect(err.message).toContain("https://a");
    expect(err.message).toContain("https://b");
  });

  it("exposes readonly properties", () => {
    const err = new ChainIdMismatchError("0x1", "0x2", "https://a", "https://b");
    expect(err.primaryChainId).toBe("0x1");
    expect(err.secondaryChainId).toBe("0x2");
    expect(err.primaryUrl).toBe("https://a");
    expect(err.secondaryUrl).toBe("https://b");
  });
});

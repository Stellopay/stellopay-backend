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
    estimateFee: ReturnType<typeof vi.fn>;
  }>,
);

vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  class MockRpcProvider {
    nodeUrl: string;
    getChainId: ReturnType<typeof vi.fn>;
    getSpecVersion: ReturnType<typeof vi.fn>;
    getBlock: ReturnType<typeof vi.fn>;
    estimateFee: ReturnType<typeof vi.fn>;

    constructor({ nodeUrl }: { nodeUrl: string }) {
      this.nodeUrl = nodeUrl;
      this.getChainId = vi.fn();
      this.getSpecVersion = vi.fn().mockResolvedValue("0.6.0");
      this.getBlock = vi.fn();
      this.estimateFee = vi.fn();
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
  resetCircuitBreakersForTests,
  getStarknetMetricsSnapshot,
  getCircuitBreakerSnapshots,
  resetStarknetMetrics,
  incStarknetMetric,
  STARKNET_METRICS,
  ChainIdMismatchError,
} from "./client.js";
import { CircuitOpenError } from "./circuit-breaker.js";

const VITEST_POSTGRES =
  process.env.POSTGRES_CONNECTION_STRING ??
  "postgresql://postgres:postgres@localhost:5432/stellopay_indexer";

async function loadClientWithRpcUrls(rpcEnv: string) {
  vi.resetModules();
  mockRpcProviders.length = 0;
  process.env.STARKNET_RPC_URL = rpcEnv;
  process.env.POSTGRES_CONNECTION_STRING = VITEST_POSTGRES;
  return import("./client.js");
}

describe("Starknet Client Cache", () => {
  let getChainIdSpy: ReturnType<typeof vi.fn>;
  let getSpecVersionSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetRpcFailoverForTests();
    resetCircuitBreakersForTests();
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

  it("should deduplicate concurrent requests on cache miss", async () => {
    const [info1, info2, info3] = await Promise.all([
      getCachedNetworkInfo(),
      getCachedNetworkInfo(),
      getCachedNetworkInfo(),
    ]);

    expect(info1).toEqual(info2);
    expect(info2).toEqual(info3);
    expect(getChainIdSpy).toHaveBeenCalledTimes(1);
    expect(getSpecVersionSpy).toHaveBeenCalledTimes(1);
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

describe("Starknet Client Telemetry & Metrics", () => {
  beforeEach(() => {
    resetStarknetMetrics();
    clearNetworkCache();
    resetRpcFailoverForTests();
  });

  it("tracks metrics for RPC calls and failovers", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.resetStarknetMetrics();

    const [primary, secondary] = mockRpcProviders;
    primary!.getBlock.mockRejectedValueOnce(new Error("RPC failed"));
    secondary!.getBlock.mockResolvedValueOnce({ block_number: 100 });

    const result = await client.provider.getBlock("latest");
    expect(result).toEqual({ block_number: 100 });

    const metrics = client.getStarknetMetricsSnapshot().counters;
    expect(metrics[client.STARKNET_METRICS.RPC_REQUESTS]).toBe(1);
    expect(metrics[client.STARKNET_METRICS.RPC_FAILOVERS]).toBe(1);
    expect(metrics[client.STARKNET_METRICS.RPC_ERRORS]).toBe(1);
  });

  it("tracks fee quote metrics on estimateFee success and failure", async () => {
    const client = await loadClientWithRpcUrls("https://rpc.example/rpc");
    client.resetRpcFailoverForTests();
    client.resetStarknetMetrics();

    const [primary] = mockRpcProviders;
    primary!.estimateFee.mockResolvedValueOnce({ overall_fee: "1000" });

    await client.provider.estimateFee([]);

    let snapshot = client.getStarknetMetricsSnapshot().counters;
    expect(snapshot[client.STARKNET_METRICS.FEE_QUOTE_REQUESTS]).toBe(1);
    expect(snapshot[client.STARKNET_METRICS.FEE_QUOTE_SUCCESS]).toBe(1);

    primary!.estimateFee.mockRejectedValueOnce(new Error("Fee estimation failed"));
    await expect(client.provider.estimateFee([])).rejects.toThrow("Fee estimation failed");

    snapshot = client.getStarknetMetricsSnapshot().counters;
    expect(snapshot[client.STARKNET_METRICS.FEE_QUOTE_REQUESTS]).toBe(2);
    expect(snapshot[client.STARKNET_METRICS.FEE_QUOTE_ERRORS]).toBe(1);
  });

  it("tracks network info cache hits, fetches, and deduplication metrics", async () => {
    vi.spyOn(provider, "getChainId").mockResolvedValue("0x534e5f4d41494e");
    vi.spyOn(provider, "getSpecVersion").mockResolvedValue("0.7.1");

    const [info1, info2] = await Promise.all([
      getCachedNetworkInfo(),
      getCachedNetworkInfo(),
    ]);

    expect(info1).toEqual(info2);

    let snapshot = getStarknetMetricsSnapshot().counters;
    expect(snapshot[STARKNET_METRICS.NETWORK_INFO_FETCHES]).toBe(1);
    expect(snapshot[STARKNET_METRICS.NETWORK_INFO_DEDUPED]).toBe(1);

    await getCachedNetworkInfo();
    snapshot = getStarknetMetricsSnapshot().counters;
    expect(snapshot[STARKNET_METRICS.NETWORK_INFO_CACHE_HITS]).toBe(1);
  });

  it("resets metrics via resetStarknetMetrics", () => {
    incStarknetMetric(STARKNET_METRICS.RPC_REQUESTS, 5);
    expect(getStarknetMetricsSnapshot().counters[STARKNET_METRICS.RPC_REQUESTS]).toBe(5);

    resetStarknetMetrics();
    expect(getStarknetMetricsSnapshot().counters[STARKNET_METRICS.RPC_REQUESTS]).toBeUndefined();
  });
});

describe("Performance Optimizations", () => {
  beforeEach(() => {
    clearContractCache();
    resetRpcFailoverForTests();
  });

  it("normalizes contract addresses to prevent duplicate instance creation", () => {
    const address1 = " 0x0123AbCd456 ";
    const address2 = "0x0123abcd456";

    const escrow1 = escrowContract(address1);
    const escrow2 = escrowContract(address2);
    expect(escrow1).toBe(escrow2);

    const agreement1 = agreementContract(address1);
    const agreement2 = agreementContract(address2);
    expect(agreement1).toBe(agreement2);
  });

  it("caches proxy method bindings across accesses", () => {
    const fn1 = provider.getChainId;
    const fn2 = provider.getChainId;
    expect(fn1).toBe(fn2);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker integration
// ---------------------------------------------------------------------------
describe("Circuit breaker integration", () => {
  const CB_FAIL_THRESHOLD = "2";
  const CB_SUCCESS_THRESHOLD = "1";
  const CB_COOLDOWN_MS = "5000";
  const CB_WINDOW_MS = "30000";

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = CB_FAIL_THRESHOLD;
    process.env.CIRCUIT_BREAKER_SUCCESS_THRESHOLD = CB_SUCCESS_THRESHOLD;
    process.env.CIRCUIT_BREAKER_COOLDOWN_MS = CB_COOLDOWN_MS;
    process.env.CIRCUIT_BREAKER_WINDOW_MS = CB_WINDOW_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("records failure on RPC error and stays CLOSED below threshold", async () => {
    const client = await loadClientWithRpcUrls("https://primary.example/rpc");
    client.resetRpcFailoverForTests();
    client.resetCircuitBreakersForTests();

    const [primary] = mockRpcProviders;
    primary!.getBlock.mockRejectedValue(new Error("RPC fail"));

    await expect(client.provider.getBlock("latest")).rejects.toThrow("RPC fail");

    const snap = client.getCircuitBreakerSnapshots();
    // 1 failure < threshold=2 → still CLOSED
    expect(snap[0].state).toBe("CLOSED");
    expect(snap[0].recentFailureCount).toBe(1);
  });

  it("opens circuit after reaching failure threshold and skips the endpoint", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.resetCircuitBreakersForTests();

    const [primary, secondary] = mockRpcProviders;

    // Call 1: both endpoints fail → each breaker records 1 failure
    primary!.getBlock.mockImplementationOnce(() => Promise.reject(new Error("fail1")));
    secondary!.getBlock.mockImplementationOnce(() => Promise.reject(new Error("fail1s")));
    await expect(client.provider.getBlock("latest")).rejects.toThrow("fail1s");

    // Call 2: primary fails → reaches threshold=2 → OPEN; secondary succeeds
    primary!.getBlock.mockImplementationOnce(() => Promise.reject(new Error("fail2")));
    secondary!.getBlock.mockImplementationOnce(() => Promise.resolve({ block_number: 42 }));

    const result = await client.provider.getBlock("latest");
    expect(result).toEqual({ block_number: 42 });

    const snap = client.getCircuitBreakerSnapshots();
    expect(snap[0].state).toBe("OPEN");
    expect(snap[0].recentFailureCount).toBe(2);
  });

  it("probe call succeeds and closes the circuit after cooldown", async () => {
    const client = await loadClientWithRpcUrls("https://primary.example/rpc");
    client.resetRpcFailoverForTests();
    client.resetCircuitBreakersForTests();

    const [primary] = mockRpcProviders;

    // 2 failures → circuit opens (single endpoint, both fail same endpoint)
    primary!.getBlock.mockImplementationOnce(() => Promise.reject(new Error("f1")));
    await expect(client.provider.getBlock("latest")).rejects.toThrow("f1");

    primary!.getBlock.mockImplementationOnce(() => Promise.reject(new Error("f2")));
    await expect(client.provider.getBlock("latest")).rejects.toThrow("f2");

    expect(client.getCircuitBreakerSnapshots()[0].state).toBe("OPEN");

    // Advance past cooldown → next isCallPermitted() transitions to HALF_OPEN
    vi.advanceTimersByTime(5001);

    // Probe succeeds → successThreshold=1 → CLOSED
    primary!.getBlock.mockImplementationOnce(() => Promise.resolve({ block_number: 100 }));

    await client.provider.getBlock("latest");
    expect(client.getCircuitBreakerSnapshots()[0].state).toBe("CLOSED");
  });

  it("records success on successful RPC call", async () => {
    vi.useRealTimers();
    const client = await loadClientWithRpcUrls("https://primary.example/rpc");
    client.resetRpcFailoverForTests();
    client.resetCircuitBreakersForTests();

    const [primary] = mockRpcProviders;
    primary!.getBlock.mockResolvedValue({ block_number: 1 });

    await client.provider.getBlock("latest");

    // Breaker should be CLOSED with no failures (success zeroes the counter)
    const snap = client.getCircuitBreakerSnapshots();
    expect(snap[0].state).toBe("CLOSED");
    expect(snap[0].recentFailureCount).toBe(0);
  });

  it("getCircuitBreakerSnapshots returns accurate snapshot data", async () => {
    const client = await loadClientWithRpcUrls("https://primary.example/rpc,https://secondary.example/rpc");
    client.resetRpcFailoverForTests();
    client.resetCircuitBreakersForTests();

    const snapshots = client.getCircuitBreakerSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].endpointUrl).toBe("https://primary.example/rpc");
    expect(snapshots[1].endpointUrl).toBe("https://secondary.example/rpc");
    expect(snapshots[0].state).toBe("CLOSED");
    expect(snapshots[1].state).toBe("CLOSED");
    expect(snapshots[0].openedAt).toBeNull();
    expect(snapshots[1].openedAt).toBeNull();
  });

  it("resetCircuitBreakersForTests resets all breakers", async () => {
    const client = await loadClientWithRpcUrls("https://primary.example/rpc");
    client.resetRpcFailoverForTests();
    client.resetCircuitBreakersForTests();

    const [primary] = mockRpcProviders;
    primary!.getBlock.mockRejectedValue(new Error("fail"));
    await expect(client.provider.getBlock("latest")).rejects.toThrow("fail");

    // Should have 1 failure
    expect(client.getCircuitBreakerSnapshots()[0].recentFailureCount).toBe(1);

    client.resetCircuitBreakersForTests();
    const snap = client.getCircuitBreakerSnapshots();
    expect(snap[0].state).toBe("CLOSED");
    expect(snap[0].recentFailureCount).toBe(0);
    expect(snap[0].openedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fee quote failover paths
// ---------------------------------------------------------------------------
describe("Fee quote RPC failover", () => {
  const CB_FAIL_THRESHOLD = "3";
  const CB_SUCCESS_THRESHOLD = "1";
  const CB_COOLDOWN_MS = "10000";
  const CB_WINDOW_MS = "60000";

  beforeEach(() => {
    process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = CB_FAIL_THRESHOLD;
    process.env.CIRCUIT_BREAKER_SUCCESS_THRESHOLD = CB_SUCCESS_THRESHOLD;
    process.env.CIRCUIT_BREAKER_COOLDOWN_MS = CB_COOLDOWN_MS;
    process.env.CIRCUIT_BREAKER_WINDOW_MS = CB_WINDOW_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to secondary endpoint on fee quote failure", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.resetStarknetMetrics();

    const [primary, secondary] = mockRpcProviders;

    primary!.estimateFee.mockRejectedValue(new Error("fee estimation down"));
    secondary!.estimateFee.mockResolvedValue({ overall_fee: "2500" });

    const result = await client.provider.estimateFee([]);
    expect(result).toEqual({ overall_fee: "2500" });
  });

  it("increments fee quote error metrics when all endpoints fail on fee quote", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.resetStarknetMetrics();

    const [primary, secondary] = mockRpcProviders;
    primary!.estimateFee.mockRejectedValue(new Error("primary fee down"));
    secondary!.estimateFee.mockRejectedValue(new Error("secondary fee down"));

    await expect(client.provider.estimateFee([])).rejects.toThrow("secondary fee down");

    const snap = client.getStarknetMetricsSnapshot().counters;
    expect(snap[client.STARKNET_METRICS.FEE_QUOTE_REQUESTS]).toBe(1);
    expect(snap[client.STARKNET_METRICS.FEE_QUOTE_ERRORS]).toBe(1);
    expect(snap[client.STARKNET_METRICS.RPC_ERRORS]).toBe(2);
    expect(snap[client.STARKNET_METRICS.RPC_FAILOVERS]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ChainIdMismatchError
// ---------------------------------------------------------------------------
describe("ChainIdMismatchError", () => {
  it("creates an error with the correct name and message", () => {
    const err = new ChainIdMismatchError(
      "0x1",
      "0x2",
      "https://primary.example/rpc",
      "https://secondary.example/rpc",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ChainIdMismatchError");
    expect(err.message).toContain("0x1");
    expect(err.message).toContain("0x2");
    expect(err.message).toContain("https://primary.example/rpc");
    expect(err.message).toContain("https://secondary.example/rpc");
  });

  it("exposes all constructor properties", () => {
    const err = new ChainIdMismatchError(
      "0x534e5f4d41494e",
      "0x534e5f5345504f4c4941",
      "https://rpc1.example/rpc",
      "https://rpc2.example/rpc",
    );
    expect(err.primaryChainId).toBe("0x534e5f4d41494e");
    expect(err.secondaryChainId).toBe("0x534e5f5345504f4c4941");
    expect(err.primaryUrl).toBe("https://rpc1.example/rpc");
    expect(err.secondaryUrl).toBe("https://rpc2.example/rpc");
  });
});

// ---------------------------------------------------------------------------
// RPC argument cloning edge cases (Map, Set, custom instances)
// ---------------------------------------------------------------------------
describe("RPC argument cloning edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("clones Map arguments during failover — original is not mutated", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.resetCircuitBreakersForTests();

    const [primary, secondary] = mockRpcProviders;
    const original = new Map([["key", "value"]]);
    const payload = { map: original };

    primary!.getBlock.mockImplementationOnce((p: typeof payload) => {
      p.map.set("mutated", true);
      throw new Error("primary down");
    });
    secondary!.getBlock.mockImplementationOnce((p: typeof payload) => {
      return Promise.resolve({ received: p });
    });

    const result = await client.provider.getBlock(payload);

    // Original must not reflect the mutation made on the primary attempt
    expect(original.has("mutated")).toBe(false);
    // Secondary receives a fresh clone (not the mutated version)
    expect(result.received.map.has("mutated")).toBe(false);
    expect(result.received.map.get("key")).toBe("value");
  });

  it("clones Set arguments during failover — original is not mutated", async () => {
    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.resetCircuitBreakersForTests();

    const [primary, secondary] = mockRpcProviders;
    const original = new Set([1, 2, 3]);
    const payload = { set: original };

    primary!.getBlock.mockImplementationOnce((p: typeof payload) => {
      p.set.add(999);
      throw new Error("primary down");
    });
    secondary!.getBlock.mockImplementationOnce((p: typeof payload) => {
      return Promise.resolve({ received: p });
    });

    const result = await client.provider.getBlock(payload);

    // Original must not reflect the mutation made on the primary attempt
    expect(original.has(999)).toBe(false);
    // Secondary receives a fresh clone (not the mutated version)
    expect(result.received.set.has(999)).toBe(false);
    expect(result.received.set.has(1)).toBe(true);
  });

  it("passes custom class instances through unchanged during failover", async () => {
    class CustomType {
      constructor(readonly value: number) {}
    }

    const client = await loadClientWithRpcUrls(
      "https://primary.example/rpc,https://secondary.example/rpc",
    );
    client.resetRpcFailoverForTests();
    client.resetCircuitBreakersForTests();

    const [primary, secondary] = mockRpcProviders;
    const original = new CustomType(42);
    const payload = { custom: original };

    primary!.getBlock.mockImplementationOnce((p: typeof payload) => {
      throw new Error("primary down");
    });
    secondary!.getBlock.mockImplementationOnce((p: typeof payload) => {
      return Promise.resolve({ received: p.custom.value });
    });

    const result = await client.provider.getBlock(payload);

    // Custom class instances are NOT deep-cloned (only plain objects, Map, Set, Date)
    // They are passed through by reference to the secondary attempt
    expect(result).toEqual({ received: 42 });
  });
});

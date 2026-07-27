import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// This file has ONE static import (vitest above) plus one vi.mock call.
// That is the only combination that avoids the Vitest 3 TDZ hoisting bug
// present in this project's transform setup.  All other imports are lazy
// (loaded inside beforeAll) so they don't become static import bindings that
// Vitest's transform could reference prematurely.
//
// The mock factory captures the last constructed MockRpcProvider in a closure
// variable and exposes it via a bonus __getMockInstance export so tests can
// set return values without a shared hoisted array.
vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  let _inst: any = null;
  class MockRpcProvider {
    nodeUrl: string;
    getChainId: any;
    getSpecVersion: any;
    getNonceForAddress: any;
    getInvokeEstimateFee: any;
    constructor({ nodeUrl }: { nodeUrl: string }) {
      this.nodeUrl = nodeUrl;
      this.getChainId = vi.fn().mockResolvedValue("0x534e5f4d41494e");
      this.getSpecVersion = vi.fn().mockResolvedValue("0.6.0");
      this.getNonceForAddress = vi.fn().mockResolvedValue("0x1");
      this.getInvokeEstimateFee = vi.fn();
      _inst = this;
    }
  }
  return {
    ...actual,
    RpcProvider: MockRpcProvider as unknown as typeof actual.RpcProvider,
    __getMockInstance: (): any => _inst,
  };
});

// Lazily loaded bindings — populated in the top-level beforeAll below.
let client: any = null;
let starknetMock: any = null;

function m(): any {
  return starknetMock.__getMockInstance();
}

beforeAll(async () => {
  client = await import("./client.js");
  starknetMock = await import("starknet");
});

// ---------------------------------------------------------------------------
// validateContractAddress
// ---------------------------------------------------------------------------
describe("validateContractAddress", () => {
  it("accepts a canonical 0x-prefixed lowercase address", () => {
    expect(() =>
      client.validateContractAddress(
        "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
      ),
    ).not.toThrow();
  });

  it("accepts an address without 0x prefix", () => {
    expect(() =>
      client.validateContractAddress(
        "06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
      ),
    ).not.toThrow();
  });

  it("accepts a minimal single-character address", () => {
    expect(() => client.validateContractAddress("0x1")).not.toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => client.validateContractAddress("")).toThrow(
      "Contract address must be a non-empty string",
    );
  });

  it("rejects a whitespace-only string", () => {
    expect(() => client.validateContractAddress("   ")).toThrow(
      "Contract address must be a non-empty string",
    );
  });

  it("rejects a non-hex string after stripping prefix", () => {
    expect(() => client.validateContractAddress("0xGGGGGG")).toThrow(
      /must be a hex string/i,
    );
  });

  it("rejects a string containing spaces mid-value", () => {
    expect(() => client.validateContractAddress("0x123 456")).toThrow(
      /must be a hex string/i,
    );
  });

  it("rejects a bare 0x prefix with no hex digits", () => {
    expect(() => client.validateContractAddress("0x")).toThrow(/must be a hex string/i);
  });
});

// ---------------------------------------------------------------------------
// validateStarknetAddress
// ---------------------------------------------------------------------------
describe("validateStarknetAddress", () => {
  it("accepts a canonical 0x-prefixed address", () => {
    expect(() =>
      client.validateStarknetAddress(
        "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
      ),
    ).not.toThrow();
  });

  it("accepts a minimal single-hex-digit address", () => {
    expect(() => client.validateStarknetAddress("0xa")).not.toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => client.validateStarknetAddress("")).toThrow(
      "Starknet address must be a non-empty string",
    );
  });

  it("rejects a whitespace-only string", () => {
    expect(() => client.validateStarknetAddress("   ")).toThrow(
      "Starknet address must be a non-empty string",
    );
  });

  it("rejects a non-hex string", () => {
    expect(() => client.validateStarknetAddress("not-hex")).toThrow(
      /must be a hex string/i,
    );
  });

  it("rejects a bare 0x prefix", () => {
    expect(() => client.validateStarknetAddress("0x")).toThrow(/must be a hex string/i);
  });

  it("rejects embedded spaces", () => {
    expect(() => client.validateStarknetAddress("0x123 abc")).toThrow(
      /must be a hex string/i,
    );
  });
});

// ---------------------------------------------------------------------------
// getCachedNetworkInfo - ttlMs boundary validation
// ---------------------------------------------------------------------------
describe("getCachedNetworkInfo - ttlMs boundary validation", () => {
  beforeEach(() => {
    client.clearNetworkCache();
    client.resetRpcFailoverForTests();
  });

  it("rejects zero as ttlMs", async () => {
    await expect(client.getCachedNetworkInfo(0)).rejects.toThrow(RangeError);
    await expect(client.getCachedNetworkInfo(0)).rejects.toThrow(/positive finite/i);
  });

  it("rejects a negative ttlMs", async () => {
    await expect(client.getCachedNetworkInfo(-1)).rejects.toThrow(RangeError);
  });

  it("rejects Infinity as ttlMs", async () => {
    await expect(client.getCachedNetworkInfo(Infinity)).rejects.toThrow(RangeError);
  });

  it("rejects NaN as ttlMs", async () => {
    await expect(client.getCachedNetworkInfo(NaN)).rejects.toThrow(RangeError);
  });

  it("accepts a positive finite ttlMs and returns network info", async () => {
    const info = await client.getCachedNetworkInfo(1);
    expect(info.chainId).toBe("0x534e5f4d41494e");
    expect(info.specVersion).toBe("0.6.0");
  });
});

// ---------------------------------------------------------------------------
// getCachedChainId
// ---------------------------------------------------------------------------
describe("getCachedChainId", () => {
  beforeEach(() => {
    client.clearNetworkCache();
    client.resetRpcFailoverForTests();
    m()?.getChainId?.mockClear();
    m()?.getSpecVersion?.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the chain ID string on success", async () => {
    expect(await client.getCachedChainId()).toBe("0x534e5f4d41494e");
  });

  it("does not issue a second RPC call when the cache is warm", async () => {
    await client.getCachedChainId();
    await client.getCachedChainId();
    expect(m().getChainId).toHaveBeenCalledTimes(1);
  });

  it("shares the cache with getCachedNetworkInfo", async () => {
    await client.getCachedNetworkInfo();
    await client.getCachedChainId();
    expect(m().getChainId).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid ttlMs", async () => {
    await expect(client.getCachedChainId(0)).rejects.toThrow(RangeError);
    await expect(client.getCachedChainId(-5)).rejects.toThrow(RangeError);
    await expect(client.getCachedChainId(NaN)).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// getNonceForAddress - address validation
// ---------------------------------------------------------------------------
describe("getNonceForAddress - address validation", () => {
  it("rejects an empty address", async () => {
    await expect(client.getNonceForAddress("")).rejects.toThrow(
      "Starknet address must be a non-empty string",
    );
  });

  it("rejects a whitespace-only address", async () => {
    await expect(client.getNonceForAddress("   ")).rejects.toThrow(
      "Starknet address must be a non-empty string",
    );
  });

  it("rejects a non-hex address", async () => {
    await expect(client.getNonceForAddress("not-valid")).rejects.toThrow(
      /must be a hex string/i,
    );
  });

  it("rejects a bare 0x prefix", async () => {
    await expect(client.getNonceForAddress("0x")).rejects.toThrow(/must be a hex string/i);
  });
});

// ---------------------------------------------------------------------------
// getNonceForAddress - RPC delegation
// ---------------------------------------------------------------------------
describe("getNonceForAddress - RPC delegation", () => {
  const ADDR = "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4";

  beforeEach(() => {
    client.resetRpcFailoverForTests();
    m()?.getNonceForAddress?.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the address to the provider with the pending block tag", async () => {
    m().getNonceForAddress.mockResolvedValue("0xb");
    const nonce = await client.getNonceForAddress(ADDR);
    expect(nonce).toBe("0xb");
    expect(m().getNonceForAddress).toHaveBeenCalledWith(ADDR, "pending");
  });

  it("propagates RPC errors to the caller", async () => {
    m().getNonceForAddress.mockRejectedValueOnce(new Error("nonce RPC failure"));
    await expect(client.getNonceForAddress(ADDR)).rejects.toThrow("nonce RPC failure");
  });
});

// ---------------------------------------------------------------------------
// validateCallArray
// ---------------------------------------------------------------------------
describe("validateCallArray", () => {
  const VALID_CALL = {
    contractAddress: "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
    entrypoint: "transfer",
  };

  it("accepts a single valid call", () => {
    expect(() => client.validateCallArray([VALID_CALL])).not.toThrow();
  });

  it("accepts multiple valid calls", () => {
    expect(() =>
      client.validateCallArray([VALID_CALL, { ...VALID_CALL, entrypoint: "approve" }]),
    ).not.toThrow();
  });

  it("accepts calls that omit the optional calldata field", () => {
    expect(() =>
      client.validateCallArray([{ contractAddress: "0xabc", entrypoint: "foo" }]),
    ).not.toThrow();
  });

  it("throws TypeError when calls is not an array", () => {
    expect(() => client.validateCallArray(null)).toThrow(TypeError);
    expect(() => client.validateCallArray(null)).toThrow("calls must be an array");
    expect(() => client.validateCallArray({})).toThrow(TypeError);
    expect(() => client.validateCallArray("0xabc")).toThrow(TypeError);
  });

  it("throws RangeError when calls is an empty array", () => {
    expect(() => client.validateCallArray([])).toThrow(RangeError);
    expect(() => client.validateCallArray([])).toThrow("calls array must not be empty");
  });

  it("throws when a call element is null", () => {
    expect(() => client.validateCallArray([null])).toThrow("calls[0] must be an object");
  });

  it("throws when contractAddress is missing", () => {
    expect(() => client.validateCallArray([{ entrypoint: "foo" }])).toThrow(
      "calls[0].contractAddress must be a non-empty string",
    );
  });

  it("throws when contractAddress is an empty string", () => {
    expect(() =>
      client.validateCallArray([{ contractAddress: "", entrypoint: "foo" }]),
    ).toThrow("calls[0].contractAddress must be a non-empty string");
  });

  it("throws when contractAddress is not a hex string", () => {
    expect(() =>
      client.validateCallArray([{ contractAddress: "not-hex", entrypoint: "foo" }]),
    ).toThrow(/contractAddress must be a hex string/i);
  });

  it("throws when contractAddress is a bare 0x prefix", () => {
    expect(() =>
      client.validateCallArray([{ contractAddress: "0x", entrypoint: "foo" }]),
    ).toThrow(/contractAddress must be a hex string/i);
  });

  it("throws when entrypoint is missing", () => {
    expect(() => client.validateCallArray([{ contractAddress: "0xabc" }])).toThrow(
      "calls[0].entrypoint must be a non-empty string",
    );
  });

  it("throws when entrypoint is empty", () => {
    expect(() =>
      client.validateCallArray([{ contractAddress: "0xabc", entrypoint: "" }]),
    ).toThrow("calls[0].entrypoint must be a non-empty string");
  });

  it("throws when entrypoint is whitespace only", () => {
    expect(() =>
      client.validateCallArray([{ contractAddress: "0xabc", entrypoint: "   " }]),
    ).toThrow("calls[0].entrypoint must be a non-empty string");
  });

  it("reports the correct index for the second invalid element", () => {
    expect(() =>
      client.validateCallArray([VALID_CALL, { contractAddress: "0xabc", entrypoint: "" }]),
    ).toThrow("calls[1].entrypoint must be a non-empty string");
  });
});

// ---------------------------------------------------------------------------
// getInvokeEstimateFee - input validation (guard fires before any RPC call)
// ---------------------------------------------------------------------------
describe("getInvokeEstimateFee - input validation", () => {
  const VALID_CALL = {
    contractAddress: "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
    entrypoint: "transfer",
  };
  const VALID_ADDR = "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd";

  it("rejects an empty caller address", async () => {
    await expect(client.getInvokeEstimateFee("", VALID_CALL)).rejects.toThrow(
      "Starknet address must be a non-empty string",
    );
  });

  it("rejects a non-hex caller address", async () => {
    await expect(client.getInvokeEstimateFee("not-hex", VALID_CALL)).rejects.toThrow(
      /must be a hex string/i,
    );
  });

  it("rejects a call with an invalid contractAddress", async () => {
    await expect(
      client.getInvokeEstimateFee(VALID_ADDR, {
        contractAddress: "0x",
        entrypoint: "foo",
      }),
    ).rejects.toThrow(/contractAddress must be a hex string/i);
  });

  it("rejects a call with an empty entrypoint", async () => {
    await expect(
      client.getInvokeEstimateFee(VALID_ADDR, {
        contractAddress: "0xabc",
        entrypoint: "",
      }),
    ).rejects.toThrow("calls[0].entrypoint must be a non-empty string");
  });
});

// ---------------------------------------------------------------------------
// getInvokeEstimateFee - RPC delegation (success + error paths)
// ---------------------------------------------------------------------------
describe("getInvokeEstimateFee - RPC delegation", () => {
  const CALLER = "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4";
  const CALL = {
    contractAddress: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
    entrypoint: "transfer",
    calldata: ["0x1", "0x64", "0x0"],
  };
  const FEE_RESPONSE = {
    overall_fee: BigInt("1000000000000000"),
    gas_consumed: BigInt("1000"),
    gas_price: BigInt("1000000000000"),
    unit: "WEI",
  };

  beforeEach(() => {
    client.resetRpcFailoverForTests();
    m()?.getNonceForAddress?.mockClear();
    m()?.getInvokeEstimateFee?.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the fee estimate and fetches the caller nonce on success", async () => {
    m().getNonceForAddress.mockResolvedValue("0x5");
    m().getInvokeEstimateFee.mockResolvedValue(FEE_RESPONSE);

    const result = await client.getInvokeEstimateFee(CALLER, CALL);

    expect(result).toEqual(FEE_RESPONSE);
    expect(m().getNonceForAddress).toHaveBeenCalledWith(CALLER, "pending");
    expect(m().getInvokeEstimateFee).toHaveBeenCalledWith(
      CALL,
      expect.objectContaining({ nonce: "0x5" }),
    );
  });

  it("propagates nonce-fetch errors and does not attempt fee estimation", async () => {
    m().getNonceForAddress.mockRejectedValueOnce(new Error("nonce fetch failed"));
    await expect(client.getInvokeEstimateFee(CALLER, CALL)).rejects.toThrow(
      "nonce fetch failed",
    );
    expect(m().getInvokeEstimateFee).not.toHaveBeenCalled();
  });

  it("propagates fee-estimation errors to the caller", async () => {
    m().getNonceForAddress.mockResolvedValue("0x3");
    m().getInvokeEstimateFee.mockRejectedValueOnce(new Error("fee estimation failed"));
    await expect(client.getInvokeEstimateFee(CALLER, CALL)).rejects.toThrow(
      "fee estimation failed",
    );
  });
});

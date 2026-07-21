import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  callContract,
  contractCall,
  contractPopulate,
  envMock,
  getChainId,
  getNonceForAddress,
  requireSession,
  tokenContract,
} = vi.hoisted(() => {
  const contractCall = vi.fn();
  const contractPopulate = vi.fn();
  return {
    callContract: vi.fn(),
    contractCall,
    contractPopulate,
    envMock: { TOKEN_METADATA_CACHE_TTL_MS: 1_000 },
    getChainId: vi.fn(),
    getNonceForAddress: vi.fn(),
    requireSession: vi.fn(),
    tokenContract: { call: contractCall, populate: contractPopulate },
  };
});

vi.mock("../starknet/client.js", () => ({
  provider: {
    callContract,
    getNonceForAddress,
    getChainId,
  },
}));
vi.mock("../config.js", () => ({ env: envMock }));
vi.mock("../auth/session.js", () => ({ requireSession }));
vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  return {
    ...actual,
    Contract: vi.fn().mockImplementation(function () {
      return tokenContract;
    }),
  };
});

import { clearTokenMetadataCache, getTokenMetadata, tokenRouter } from "./token.js";

const CANONICAL_TOKEN = `0x${"0".repeat(61)}abc`;

function mockMetadataCalls() {
  callContract.mockImplementation(({ entrypoint }: { entrypoint: string }) => {
    const values: Record<string, string[]> = {
      name: ["0x55534420436f696e"],
      symbol: ["0x55534443"],
      decimals: ["0x6"],
    };
    return Promise.resolve(values[entrypoint]);
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", tokenRouter);
  app.use(
    (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: error.message });
    },
  );
  return app;
}

beforeEach(() => {
  clearTokenMetadataCache();
  callContract.mockReset();
  contractCall.mockReset();
  contractPopulate.mockReset();
  getChainId.mockReset();
  getNonceForAddress.mockReset();
  requireSession.mockReset();
  mockMetadataCalls();
});

afterEach(() => {
  clearTokenMetadataCache();
  vi.useRealTimers();
});

describe("token metadata TTL cache", () => {
  it("fetches metadata on a cache miss", async () => {
    const response = await request(makeApp()).get("/api/v1/token/0xabc/metadata");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      token: CANONICAL_TOKEN,
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
    });
    expect(callContract).toHaveBeenCalledTimes(3);
    expect(callContract).toHaveBeenCalledWith({
      contractAddress: CANONICAL_TOKEN,
      entrypoint: "name",
      calldata: [],
    });
  });

  it("serves equivalent address variants from one cache entry within the TTL", async () => {
    const first = await getTokenMetadata("0xabc");
    const second = await getTokenMetadata("0X000ABC");

    expect(second).toBe(first);
    expect(callContract).toHaveBeenCalledTimes(3);
  });

  it("refetches expired metadata transparently", async () => {
    vi.useFakeTimers();
    await getTokenMetadata("0xabc");
    vi.advanceTimersByTime(envMock.TOKEN_METADATA_CACHE_TTL_MS + 1);

    const refreshed = await getTokenMetadata("0xabc");

    expect(refreshed.symbol).toBe("USDC");
    expect(callContract).toHaveBeenCalledTimes(6);
  });

  it("coalesces concurrent misses for the same token", async () => {
    const [first, second] = await Promise.all([
      getTokenMetadata("0xabc"),
      getTokenMetadata("0x0abc"),
    ]);

    expect(second).toBe(first);
    expect(callContract).toHaveBeenCalledTimes(3);
  });

  it("does not cache a failed metadata lookup", async () => {
    callContract.mockRejectedValueOnce(new Error("RPC unavailable"));

    await expect(getTokenMetadata("0xabc")).rejects.toThrow("RPC unavailable");
    await expect(getTokenMetadata("0xabc")).resolves.toMatchObject({ symbol: "USDC" });
    expect(callContract).toHaveBeenCalledTimes(6);
  });

  it("accepts wrapped RPC results and preserves text that is not a short string", async () => {
    callContract.mockImplementation(({ entrypoint }: { entrypoint: string }) => {
      if (entrypoint === "name") return Promise.resolve({ result: ["plain-name"] });
      if (entrypoint === "symbol") return Promise.resolve(["0x55534443"]);
      return Promise.resolve(["0x6"]);
    });

    await expect(getTokenMetadata("0xabc")).resolves.toMatchObject({
      name: "plain-name",
      symbol: "USDC",
    });
  });

  it("rejects an unexpected RPC result without caching it", async () => {
    callContract.mockResolvedValue(undefined);

    await expect(getTokenMetadata("0xabc")).rejects.toThrow("Unexpected name result");
    expect(callContract).toHaveBeenCalledTimes(3);
  });

  it("passes invalid metadata addresses to the route error handler", async () => {
    const response = await request(makeApp()).get("/api/v1/token/not-hex/metadata");

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/hex string/);
    expect(callContract).not.toHaveBeenCalled();
  });
});

describe("existing token routes", () => {
  it("returns a bigint allowance", async () => {
    contractCall.mockResolvedValue(15n);

    const response = await request(makeApp()).get("/api/v1/token/0xabc/allowance/0x1/0x2");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      token: "0xabc",
      owner: "0x1",
      spender: "0x2",
      allowance: "0xf",
    });
    expect(contractCall).toHaveBeenCalledWith("allowance", ["0x1", "0x2"]);
  });

  it("unwraps an allowance result object", async () => {
    contractCall.mockResolvedValue({ allowance: 16n });

    const response = await request(makeApp()).get("/api/v1/token/0xabc/allowance/0x1/0x2");

    expect(response.status).toBe(200);
    expect(response.body.allowance).toBe("0x10");
  });

  it("rejects approve preparation without a valid session", async () => {
    requireSession.mockResolvedValue(false);

    const response = await request(makeApp()).post("/api/v1/prepare/token/0xabc/approve").send({
      wallet_address: "0x123",
      session_token: "session-token",
      spender: "0x456",
      amount: "5",
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Invalid session" });
    expect(contractPopulate).not.toHaveBeenCalled();
  });

  it("prepares an approve call for an authenticated wallet", async () => {
    requireSession.mockResolvedValue(true);
    contractPopulate.mockReturnValue({ entrypoint: "approve" });
    getNonceForAddress.mockResolvedValue("0x1");
    getChainId.mockResolvedValue("0x534e5f5345504f4c4941");

    const response = await request(makeApp()).post("/api/v1/prepare/token/0xabc/approve").send({
      wallet_address: "0x123",
      session_token: "session-token",
      spender: "0x456",
      amount: "5",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      call: { entrypoint: "approve" },
      wallet_address: "0x123",
      nonce: "0x1",
      chain_id: "0x534e5f5345504f4c4941",
    });
    expect(contractPopulate).toHaveBeenCalledWith("approve", ["0x456", { low: "5", high: "0" }]);
  });
});

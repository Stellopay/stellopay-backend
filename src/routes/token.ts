import { Router } from "express";
import { z } from "zod";
import { shortString } from "starknet";
import { provider } from "../starknet/client.js";
import { parseU256, toHexString } from "../utils/codec.js";
import { requireSession } from "../auth/session.js";
import { env } from "../config.js";
import { normalizeStarknetAddress } from "../utils/address.js";

const AddressParam = z.string().min(3);

const WalletSession = z.object({
  wallet_address: z.string().min(3),
  session_token: z.string().min(10),
});

const ApproveBody = WalletSession.extend({
  spender: z.string().min(3),
  amount: z.string().min(1),
});

export interface TokenMetadata {
  token: string;
  name: string;
  symbol: string;
  decimals: number;
}

interface TokenMetadataCacheEntry {
  metadata: TokenMetadata;
  expiresAt: number;
}

const tokenMetadataCache = new Map<string, TokenMetadataCacheEntry>();
const tokenMetadataRequests = new Map<string, Promise<TokenMetadata>>();

function firstCallResult(output: unknown, entrypoint: string): string {
  const result = Array.isArray(output)
    ? output
    : output && typeof output === "object" && "result" in output
      ? (output as { result: unknown }).result
      : undefined;

  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`Unexpected ${entrypoint} result: ${JSON.stringify(output)}`);
  }

  return String(result[0]);
}

async function callTokenField(token: string, entrypoint: string): Promise<string> {
  const output = await provider.callContract({
    contractAddress: token,
    entrypoint,
    calldata: [],
  });
  return firstCallResult(output, entrypoint);
}

function decodeTokenText(value: string): string {
  try {
    return shortString.decodeShortString(value);
  } catch {
    return value;
  }
}

async function fetchTokenMetadata(token: string): Promise<TokenMetadata> {
  const [name, symbol, decimals] = await Promise.all([
    callTokenField(token, "name"),
    callTokenField(token, "symbol"),
    callTokenField(token, "decimals"),
  ]);

  return {
    token,
    name: decodeTokenText(name),
    symbol: decodeTokenText(symbol),
    decimals: Number(BigInt(decimals)),
  };
}

/**
 * Resolves ERC-20 metadata and caches it by canonical Starknet address.
 * Concurrent cache misses share one RPC request, and failed requests are not cached.
 */
export async function getTokenMetadata(address: string): Promise<TokenMetadata> {
  const token = normalizeStarknetAddress(address);
  const cached = tokenMetadataCache.get(token);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }

  const pending = tokenMetadataRequests.get(token);
  if (pending) {
    return pending;
  }

  const request = fetchTokenMetadata(token)
    .then((metadata) => {
      tokenMetadataCache.set(token, {
        metadata,
        expiresAt: Date.now() + env.TOKEN_METADATA_CACHE_TTL_MS,
      });
      return metadata;
    })
    .finally(() => {
      tokenMetadataRequests.delete(token);
    });

  tokenMetadataRequests.set(token, request);
  return request;
}

/** Clears token metadata state. Intended for deterministic tests. */
export function clearTokenMetadataCache(): void {
  tokenMetadataCache.clear();
  tokenMetadataRequests.clear();
}

// Minimal ERC20 ABI for approve and allowance
const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "core::starknet::contract_address::ContractAddress" },
      { name: "amount", type: "core::integer::u256" },
    ],
    outputs: [{ type: "core::bool" }],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "core::starknet::contract_address::ContractAddress" },
      { name: "spender", type: "core::starknet::contract_address::ContractAddress" },
    ],
    outputs: [{ type: "core::integer::u256" }],
    state_mutability: "view",
  },
];

export const tokenRouter = Router();

// Get ERC-20 metadata, backed by the configured in-memory TTL cache.
tokenRouter.get("/token/:address/metadata", async (req, res, next) => {
  try {
    const tokenAddress = AddressParam.parse(req.params.address);
    res.json(await getTokenMetadata(tokenAddress));
  } catch (e) {
    next(e);
  }
});

// Get current allowance
tokenRouter.get("/token/:address/allowance/:owner/:spender", async (req, res, next) => {
  try {
    const tokenAddress = AddressParam.parse(req.params.address);
    const owner = AddressParam.parse(req.params.owner);
    const spender = AddressParam.parse(req.params.spender);

    const { Contract } = await import("starknet");
    const tokenContract = new Contract(ERC20_ABI, tokenAddress, provider);
    const result = await tokenContract.call("allowance", [owner, spender]);
    // Handle the result - it might be a bigint or wrapped in a result object
    const allowance = typeof result === "bigint" ? result : (result as any).allowance || result;
    res.json({
      token: tokenAddress,
      owner,
      spender,
      allowance: toHexString(allowance),
    });
  } catch (e) {
    next(e);
  }
});

// Prepare approve transaction
tokenRouter.post("/prepare/token/:address/approve", async (req, res, next) => {
  try {
    const tokenAddress = AddressParam.parse(req.params.address);
    const body = ApproveBody.parse(req.body);

    if (!(await requireSession(body.wallet_address, body.session_token))) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const tokenContract = new (await import("starknet")).Contract(
      ERC20_ABI,
      tokenAddress,
      provider,
    );
    const call = tokenContract.populate("approve", [body.spender, parseU256(body.amount)]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

import { Contract, RpcProvider } from "starknet";
import { abiPaths, starknetRpcUrls } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "./abi.js";

/**
 * COMPATIBILITY CONTRACT: src/starknet/client.ts
 *
 * This module provides a Starknet RPC client with automatic failover, contract caching,
 * and network info caching. The following contract guarantees backward compatibility
 * for existing callers and defines the expected behavior for future changes.
 *
 * Public API Surface:
 * - provider: RpcProvider proxy with automatic failover across configured endpoints
 * - getEscrowAbi(): Returns memoized escrow contract ABI
 * - getAgreementAbi(): Returns memoized agreement contract ABI
 * - escrowContract(address): Returns cached escrow Contract instance
 * - agreementContract(address): Returns cached agreement Contract instance
 * - getCachedNetworkInfo(ttlMs?): Returns cached chainId and specVersion
 * - clearContractCache(): Clears memoized ABIs and cached Contract instances (test-only)
 * - clearNetworkCache(): Clears network info cache (test-only)
 * - resetRpcFailoverForTests(): Resets RPC failover state to primary endpoint (test-only)
 *
 * Behavior Guarantees:
 * 1. RPC Failover:
 *    - Tries endpoints in failover order (healthy endpoint first, then others)
 *    - On success, updates healthyRpcIndex to the successful endpoint
 *    - Logs console.warn on failover with old and new URLs
 *    - Clones RPC arguments before each retry to prevent mutation
 *    - Throws the last error if all endpoints fail
 *    - Argument cloning supports: primitives, arrays, plain objects, Date, Map, Set
 *    - Argument cloning does NOT support: custom class instances, cyclic structures
 *
 * 2. Contract Caching:
 *    - Contracts are cached by "<kind>:<address>" key (kind = "escrow" or "agreement")
 *    - ABI is parsed from disk once and memoized per contract type
 *    - Same address returns the same Contract instance (reference equality)
 *    - Different addresses return distinct instances even for same contract type
 *    - escrow and agreement contracts never share instances even at same address
 *    - clearContractCache() resets all caches and forces reload from disk
 *
 * 3. Network Info Caching:
 *    - getCachedNetworkInfo() caches chainId and specVersion for default 5-minute TTL
 *    - TTL is configurable via ttlMs parameter (milliseconds)
 *    - Cache is not poisoned on RPC failure - subsequent calls retry RPC
 *    - clearNetworkCache() resets the cache
 *
 * 4. Error Handling:
 *    - getEscrowAbi() throws Error if ESCROW_CONTRACT_CLASS_JSON is not configured
 *    - getAgreementAbi() throws Error if AGREEMENT_CONTRACT_CLASS_JSON is not configured
 *    - RPC methods propagate errors from the underlying RpcProvider
 *    - All errors are thrown synchronously or as rejected promises
 *
 * 5. Test-Only Functions:
 *    - clearContractCache(), clearNetworkCache(), resetRpcFailoverForTests()
 *    - These are exported for testing and should not be used in production code
 *    - They reset module-level state to ensure test isolation
 *
 * Backward Compatibility:
 * - All existing exports maintain their current signatures and behavior
 * - No breaking changes to the public API surface
 * - Existing callers in routes/agreement.ts, routes/escrow.ts, routes/auth.ts, etc.
 *   will continue to work without modification
 */

const rpcProviders = starknetRpcUrls.map((nodeUrl) => new RpcProvider({ nodeUrl }));

/** Index into rpcProviders for the last known healthy endpoint. */
let healthyRpcIndex = 0;

function rpcFailoverOrder(): number[] {
  const order = [healthyRpcIndex];
  for (let i = 0; i < rpcProviders.length; i++) {
    if (i !== healthyRpcIndex) {
      order.push(i);
    }
  }
  return order;
}

function cloneRpcArgs(args: unknown[]): unknown[] {
  return args.map((argument) => cloneRpcValue(argument));
}

function cloneRpcValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneRpcValue(item));
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof Map) {
    return new Map(Array.from(value.entries(), ([key, entryValue]) => [cloneRpcValue(key), cloneRpcValue(entryValue)]));
  }

  if (value instanceof Set) {
    return new Set(Array.from(value.values(), (entryValue) => cloneRpcValue(entryValue)));
  }

  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const clone: Record<string, unknown> = {};
      for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
        clone[key] = cloneRpcValue(entryValue);
      }
      return clone;
    }
  }

  return value;
}

async function invokeWithFailover(
  method: string | symbol,
  args: unknown[],
): Promise<unknown> {
  let lastError: unknown;
  for (const index of rpcFailoverOrder()) {
    const candidate = rpcProviders[index]!;
    try {
      const fn = Reflect.get(candidate, method) as (...a: unknown[]) => unknown;
      if (typeof fn !== "function") {
        throw new TypeError(`RpcProvider.${String(method)} is not a function`);
      }
      const attemptArgs = cloneRpcArgs(args);
      const result = await fn.apply(candidate, attemptArgs);
      if (index !== healthyRpcIndex) {
        console.warn(
          `[starknet] RPC endpoint failover: ${starknetRpcUrls[healthyRpcIndex]} -> ${starknetRpcUrls[index]}`,
        );
        healthyRpcIndex = index;
      }
      return result;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Starknet RPC client with automatic failover across configured endpoints.
 * Subsequent calls reuse the last healthy endpoint until it fails again.
 */
export const provider = new Proxy(rpcProviders[0]!, {
  get(_target, prop, _receiver) {
    if (prop === "then") {
      return undefined;
    }
    const active = rpcProviders[healthyRpcIndex]!;
    const value = Reflect.get(active, prop, active);
    if (typeof value === "function") {
      return (...args: unknown[]) => invokeWithFailover(prop, args);
    }
    return value;
  },
}) as RpcProvider;

// The contract-class JSON paths are fixed at startup, so each ABI is parsed
// from disk once and the result is memoized for every later call.
let escrowAbiCache: unknown[] | undefined;
let agreementAbiCache: unknown[] | undefined;

// Cached Contract instances keyed by "<kind>:<address>". The provider is a
// module-level singleton, so the kind and address fully identify an instance.
// The kind prefix keeps escrow and agreement ABIs from cross-contaminating, and
// the address in the key guarantees a cached instance is never reused for a
// different address.
const contractCache = new Map<string, Contract>();

/**
 * Returns the escrow contract ABI, parsing the contract-class JSON from disk on
 * the first call and serving the memoized array on every later call.
 *
 * @throws Error when ESCROW_CONTRACT_CLASS_JSON is not configured.
 */
export function getEscrowAbi(): unknown[] {
  if (!abiPaths.escrow) {
    throw new Error("ESCROW_CONTRACT_CLASS_JSON path is not configured");
  }
  if (!escrowAbiCache) {
    escrowAbiCache = loadAbiFromContractClassJsonPath(abiPaths.escrow);
  }
  return escrowAbiCache;
}

/**
 * Returns the agreement contract ABI, parsing the contract-class JSON from disk
 * on the first call and serving the memoized array on every later call.
 *
 * @throws Error when AGREEMENT_CONTRACT_CLASS_JSON is not configured.
 */
export function getAgreementAbi(): unknown[] {
  if (!abiPaths.agreement) {
    throw new Error("AGREEMENT_CONTRACT_CLASS_JSON path is not configured");
  }
  if (!agreementAbiCache) {
    agreementAbiCache = loadAbiFromContractClassJsonPath(abiPaths.agreement);
  }
  return agreementAbiCache;
}

/**
 * Returns a cached escrow Contract for the given address, constructing it once
 * and reusing the same instance on later calls with the same address.
 */
export function escrowContract(address: string): Contract {
  const key = `escrow:${address}`;
  let contract = contractCache.get(key);
  if (!contract) {
    contract = new Contract(getEscrowAbi(), address, provider);
    contractCache.set(key, contract);
  }
  return contract;
}

/**
 * Returns a cached agreement Contract for the given address, constructing it
 * once and reusing the same instance on later calls with the same address.
 */
export function agreementContract(address: string): Contract {
  const key = `agreement:${address}`;
  let contract = contractCache.get(key);
  if (!contract) {
    contract = new Contract(getAgreementAbi(), address, provider);
    contractCache.set(key, contract);
  }
  return contract;
}

/**
 * Clears the memoized ABIs and cached Contract instances. Primarily used by
 * tests that swap ABI paths so the next call reloads from disk.
 */
export function clearContractCache(): void {
  escrowAbiCache = undefined;
  agreementAbiCache = undefined;
  contractCache.clear();
}

let cachedChainId: string | undefined;
let cachedSpecVersion: string | undefined;
let cacheExpiryTime = 0;

/**
 * Gets the chain ID and spec version from the Starknet RPC,
 * caching the result in memory for the specified TTL.
 *
 * @param ttlMs - Time-to-live in milliseconds (default: 5 minutes)
 * @returns An object containing the stringified chainId and specVersion
 */
export async function getCachedNetworkInfo(
  ttlMs = 300000,
): Promise<{ chainId: string; specVersion: string }> {
  const now = Date.now();
  if (cachedChainId && cachedSpecVersion && now < cacheExpiryTime) {
    return { chainId: cachedChainId, specVersion: cachedSpecVersion };
  }

  const [rawChainId, rawSpecVersion] = await Promise.all([
    provider.getChainId(),
    provider.getSpecVersion(),
  ]);

  const chainId = String(rawChainId);
  const specVersion = String(rawSpecVersion);
  cachedChainId = chainId;
  cachedSpecVersion = specVersion;
  cacheExpiryTime = now + ttlMs;

  return { chainId, specVersion };
}

/**
 * Clears the network info cache. Primarily used for testing.
 */
export function clearNetworkCache(): void {
  cachedChainId = undefined;
  cachedSpecVersion = undefined;
  cacheExpiryTime = 0;
}

/**
 * Resets RPC failover state to the primary endpoint. For tests only.
 */
export function resetRpcFailoverForTests(): void {
  healthyRpcIndex = 0;
}

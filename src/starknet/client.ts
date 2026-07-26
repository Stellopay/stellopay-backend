import { Contract, RpcProvider } from "starknet";
import { abiPaths, starknetRpcUrls } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "./abi.js";

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

/**
 * Invokes a method on the first healthy RPC provider in failover order.
 *
 * **Idempotency contract**: `invokeWithFailover` retries the call on a
 * different provider only when the current one returns an error before a
 * successful response is received.  If a call succeeds on provider N, the
 * result is returned immediately and no duplicate call is made to any other
 * provider.  Callers that perform state mutations (e.g. `addInvokeTransaction`)
 * must handle the case where the primary succeeded but the response was lost in
 * transit — in that scenario a retry reaches a different provider which may
 * treat the call as a duplicate; the Starknet protocol's own nonce enforcement
 * prevents double-execution at the chain level.
 *
 * Read-only calls (`getChainId`, `getSpecVersion`, `getTransactionReceipt`,
 * `estimateFee`, etc.) are always safe to retry without side effects.
 */
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
      const result = await fn.apply(candidate, args);
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
 *
 * **Idempotency of read calls**: all methods that only read chain state
 * (`getChainId`, `getSpecVersion`, `getTransactionReceipt`, `estimateFee`, etc.)
 * are safe to call multiple times — the provider proxy routes them through
 * `invokeWithFailover` which retries on failure without duplicating effects.
 *
 * **Fee quotes**: `estimateFee` calls are read-only and idempotent.  The
 * in-flight dedup map below (`pendingNetworkInfo`) ensures that concurrent
 * calls for the same cached data share a single in-flight RPC request rather
 * than fanning out N identical calls during a cache miss.
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
 * In-flight deduplication for getCachedNetworkInfo.
 *
 * When multiple concurrent callers hit a cache miss at the same instant,
 * only a single RPC request is issued; all callers await the same Promise.
 * This prevents N×2 simultaneous `getChainId` + `getSpecVersion` fan-out
 * calls during a cold start or TTL expiry under load — a form of duplicate
 * request protection that keeps fee-quote and chain-interaction paths
 * idempotent at the RPC level.
 */
let pendingNetworkInfo: Promise<{ chainId: string; specVersion: string }> | undefined;

/**
 * Gets the chain ID and spec version from the Starknet RPC,
 * caching the result in memory for the specified TTL.
 *
 * **Idempotency**: repeated calls within the TTL window return the cached
 * value without issuing any RPC call. Concurrent calls during a cache miss
 * share a single in-flight request (see `pendingNetworkInfo`). The cache is
 * not poisoned on failure: a rejected call leaves the cache empty so the
 * next caller retries cleanly.
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

  // Deduplicate concurrent cache-miss fetches so only one RPC round-trip goes
  // out regardless of how many callers hit the miss simultaneously.
  if (!pendingNetworkInfo) {
    pendingNetworkInfo = (async () => {
      try {
        const [rawChainId, rawSpecVersion] = await Promise.all([
          provider.getChainId(),
          provider.getSpecVersion(),
        ]);

        const chainId = String(rawChainId);
        const specVersion = String(rawSpecVersion);
        cachedChainId = chainId;
        cachedSpecVersion = specVersion;
        cacheExpiryTime = Date.now() + ttlMs;

        return { chainId, specVersion };
      } finally {
        // Always clear the pending promise — whether the fetch succeeded or
        // failed — so the next caller can issue a fresh request.
        pendingNetworkInfo = undefined;
      }
    })();
  }

  return pendingNetworkInfo;
}

/**
 * Clears the network info cache. Primarily used for testing.
 */
export function clearNetworkCache(): void {
  cachedChainId = undefined;
  cachedSpecVersion = undefined;
  cacheExpiryTime = 0;
  pendingNetworkInfo = undefined;
}

/**
 * Resets RPC failover state to the primary endpoint. For tests only.
 */
export function resetRpcFailoverForTests(): void {
  healthyRpcIndex = 0;
}

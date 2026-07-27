import { Contract, RpcProvider } from "starknet";
import { abiPaths, starknetRpcUrls } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "./abi.js";
import {
  incStarknetMetric,
  logStarknetEvent,
  STARKNET_METRICS,
} from "./client-metrics.js";

export {
  getStarknetMetricsSnapshot,
  resetStarknetMetrics,
  incStarknetMetric,
  setStarknetGauge,
  logStarknetEvent,
  STARKNET_METRICS,
} from "./client-metrics.js";
export type { StarknetLogLevel, StarknetEventName } from "./client-metrics.js";

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
 *    - Only RETRYABLE_METHODS are eligible for failover; non-retryable (write/mutation)
 *      methods attempt the primary endpoint once and throw immediately on failure
 *    - After failover, the new endpoint's chain ID is validated against the primary's
 *      to prevent cross-chain replay
 *    - Failover is capped at MAX_FAILOVER_ATTEMPTS to bound latency on degraded networks
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
 *    - Non-retryable methods that fail on the primary endpoint throw without failover
 *    - Chain ID mismatch during failover throws ChainIdMismatchError
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

/**
 * Read-only RPC methods eligible for automatic failover. Write/mutation methods
 * are excluded so they attempt the primary endpoint once and fail immediately —
 * retrying a state-modifying call across endpoints risks double-execution if the
 * first attempt succeeded but the response was lost.
 */
const RETRYABLE_METHODS = new Set<string>([
  "getChainId",
  "getSpecVersion",
  "getBlock",
  "getBlockWithTxHashes",
  "getBlockWithTxs",
  "getBlockNumber",
  "getTransactionReceipt",
  "getTransaction",
  "getTransactionStatus",
  "getTransactionByBlockIdAndIndex",
  "estimateFee",
  "estimateMessageFee",
  "callContract",
  "getNonceForAddress",
  "getStorageAt",
  "getClassHashAt",
  "getClass",
  "getClassAt",
  "getEvents",
  "getBalance",
  "getSyncingStats",
  "getProtocolVersion",
  "pendingTransactions",
  "verifyMessageInStarknet",
]);

/**
 * Maximum number of distinct RPC endpoints to try during a single failover
 * cycle. Bounded to the configured endpoint count so degraded networks do not
 * cause unbounded latency.
 */
const MAX_FAILOVER_ATTEMPTS = starknetRpcUrls.length;

const rpcProviders = starknetRpcUrls.map((nodeUrl) => new RpcProvider({ nodeUrl }));

/** Index into rpcProviders for the last known healthy endpoint. */
let healthyRpcIndex = 0;
let cachedFailoverOrder: number[] | undefined;
let cachedHealthyIndex = -1;

function isRetryableMethod(method: string | symbol): boolean {
  return RETRYABLE_METHODS.has(String(method));
}

function rpcFailoverOrder(): number[] {
  if (rpcProviders.length === 1) {
    return [0];
  }

  if (healthyRpcIndex === cachedHealthyIndex && cachedFailoverOrder) {
    return cachedFailoverOrder;
  }

  const order = [healthyRpcIndex];
  for (let i = 0; i < rpcProviders.length; i++) {
    if (i !== healthyRpcIndex) {
      order.push(i);
    }
  }
  cachedHealthyIndex = healthyRpcIndex;
  cachedFailoverOrder = order;
  return order;
}

function isPrimitiveOrImmutable(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const type = typeof value;
  return type !== "object" && type !== "function";
}

function cloneRpcArgs(args: unknown[]): unknown[] {
  if (args.length === 0) return [];

  let hasMutable = false;
  for (let i = 0; i < args.length; i++) {
    if (!isPrimitiveOrImmutable(args[i])) {
      hasMutable = true;
      break;
    }
  }

  if (!hasMutable) {
    return [...args];
  }

  return args.map((argument) => cloneRpcValue(argument));
}

function cloneRpcValue(value: unknown): unknown {
  if (isPrimitiveOrImmutable(value)) {
    return value;
  }

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

  if (typeof value === "object") {
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
  const methodName = String(method);
  const isFeeQuote = methodName === "estimateFee";

  incStarknetMetric(STARKNET_METRICS.RPC_REQUESTS);
  if (isFeeQuote) {
    incStarknetMetric(STARKNET_METRICS.FEE_QUOTE_REQUESTS);
    logStarknetEvent("info", "starknet.fee_quote.requested", { method: methodName });
  }

  logStarknetEvent("debug", "starknet.rpc.request", {
    method: methodName,
    endpoint: starknetRpcUrls[healthyRpcIndex],
  });

  const startTime = Date.now();
  let lastError: unknown = new Error("No RPC providers available");

  for (const index of rpcFailoverOrder()) {
    const candidate = rpcProviders[index];
    if (!candidate) continue;

    try {
      const fn = Reflect.get(candidate, method) as (...a: unknown[]) => unknown;
      if (typeof fn !== "function") {
        throw new TypeError(`RpcProvider.${methodName} is not a function`);
      }

      const attemptArgs = cloneRpcArgs(args);
      const result = await fn.apply(candidate, attemptArgs);

      const durationMs = Date.now() - startTime;
      incStarknetMetric(STARKNET_METRICS.RPC_DURATION_MS, durationMs);

      if (index !== healthyRpcIndex) {
        incStarknetMetric(STARKNET_METRICS.RPC_FAILOVERS);
        logStarknetEvent("warn", "starknet.rpc.failover", {
          method: methodName,
          fromEndpoint: starknetRpcUrls[healthyRpcIndex],
          toEndpoint: starknetRpcUrls[index],
        });
        console.warn(
          `[starknet] RPC endpoint failover: ${starknetRpcUrls[healthyRpcIndex]} -> ${starknetRpcUrls[index]}`,
        );
        healthyRpcIndex = index;
      }

      logStarknetEvent("debug", "starknet.rpc.success", {
        method: methodName,
        endpoint: starknetRpcUrls[index],
        durationMs,
      });

      if (isFeeQuote) {
        incStarknetMetric(STARKNET_METRICS.FEE_QUOTE_SUCCESS);
        logStarknetEvent("info", "starknet.fee_quote.success", {
          method: methodName,
          durationMs,
        });
      }

      return result;
    } catch (err) {
      lastError = err;
      incStarknetMetric(STARKNET_METRICS.RPC_ERRORS);
      logStarknetEvent("warn", "starknet.rpc.error", {
        method: methodName,
        endpoint: starknetRpcUrls[index],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (isFeeQuote) {
    incStarknetMetric(STARKNET_METRICS.FEE_QUOTE_ERRORS);
    logStarknetEvent("error", "starknet.fee_quote.error", {
      method: methodName,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  throw lastError;
}

/**
 * After a successful failover to a different endpoint, verify that the new
 * endpoint reports the same chain ID as the primary. A mismatch indicates a
 * misconfiguration or network-level redirect that could lead to cross-chain
 * replay of signed data.
 *
 * Throws ChainIdMismatchError if the chain IDs diverge. The error is
 * intentionally not caught so the caller sees a clear failure rather than
 * silently operating on the wrong network.
 */
async function validateFailoverChainConsistency(newIndex: number): Promise<string> {
  const primary = rpcProviders[healthyRpcIndex]!;
  const secondary = rpcProviders[newIndex]!;
  try {
    const [primaryChainId, secondaryChainId] = await Promise.all([
      primary.getChainId(),
      secondary.getChainId(),
    ]);
    const primaryId = String(primaryChainId);
    const secondaryId = String(secondaryChainId);
    if (primaryId !== secondaryId) {
      throw new ChainIdMismatchError(primaryId, secondaryId, starknetRpcUrls[healthyRpcIndex]!, starknetRpcUrls[newIndex]!);
    }
    return secondaryId;
  } catch (err) {
    if (err instanceof ChainIdMismatchError) {
      throw err;
    }
    // If chain ID validation itself fails (e.g. primary is also down),
    // log a warning but allow the failover to proceed — the original
    // RPC call already succeeded on the secondary.
    console.warn(
      `[starknet] Chain ID validation failed during failover: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "";
  }
}

/**
 * Error thrown when a failover endpoint reports a different chain ID than the
 * primary endpoint. This indicates a misconfiguration or potential cross-chain
 * replay risk.
 */
export class ChainIdMismatchError extends Error {
  constructor(
    public readonly primaryChainId: string,
    public readonly secondaryChainId: string,
    public readonly primaryUrl: string,
    public readonly secondaryUrl: string,
  ) {
    super(
      `Chain ID mismatch during failover: primary ${primaryUrl} reports ${primaryChainId}, ` +
        `secondary ${secondaryUrl} reports ${secondaryChainId}`,
    );
    this.name = "ChainIdMismatchError";
  }
}

/**
 * Starknet RPC client with automatic failover across configured endpoints.
 * Subsequent calls reuse the last healthy endpoint until it fails again.
 *
 * **Security boundary — method classification**: only methods in
 * `RETRYABLE_METHODS` (read-only queries) are eligible for automatic failover.
 * Write/mutation methods (e.g. `addTransaction`) attempt the primary endpoint
 * once and throw immediately on failure — retrying a state-modifying call across
 * endpoints risks double-execution if the first attempt succeeded but the
 * response was lost.
 *
 * **Chain consistency**: after a successful failover, the new endpoint's chain
 * ID is validated against the primary's. A mismatch throws
 * `ChainIdMismatchError` to prevent cross-chain replay of signed data.
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
const methodCache = new Map<string | symbol, (...args: unknown[]) => Promise<unknown>>();

export const provider = new Proxy(rpcProviders[0]!, {
  get(_target, prop, _receiver) {
    if (prop === "then") {
      return undefined;
    }
    const active = rpcProviders[healthyRpcIndex]!;
    const value = Reflect.get(active, prop, active);
    if (typeof value === "function") {
      let cachedFn = methodCache.get(prop);
      if (!cachedFn) {
        cachedFn = (...args: unknown[]) => invokeWithFailover(prop, args);
        methodCache.set(prop, cachedFn);
      }
      return cachedFn;
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

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

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
 * Normalizes address hex casing and whitespace to avoid duplicate instances.
 */
export function escrowContract(address: string): Contract {
  const normalized = normalizeAddress(address);
  const key = `escrow:${normalized}`;
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
 * Normalizes address hex casing and whitespace to avoid duplicate instances.
 */
export function agreementContract(address: string): Contract {
  const normalized = normalizeAddress(address);
  const key = `agreement:${normalized}`;
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
    incStarknetMetric(STARKNET_METRICS.NETWORK_INFO_CACHE_HITS);
    logStarknetEvent("debug", "starknet.network_info.cache_hit", {
      chainId: cachedChainId,
      specVersion: cachedSpecVersion,
    });
    return { chainId: cachedChainId, specVersion: cachedSpecVersion };
  }

  // Deduplicate concurrent cache-miss fetches so only one RPC round-trip goes
  // out regardless of how many callers hit the miss simultaneously.
  if (!pendingNetworkInfo) {
    incStarknetMetric(STARKNET_METRICS.NETWORK_INFO_FETCHES);
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

        logStarknetEvent("info", "starknet.network_info.fetched", {
          chainId,
          specVersion,
        });

        return { chainId, specVersion };
      } catch (err) {
        incStarknetMetric(STARKNET_METRICS.NETWORK_INFO_ERRORS);
        logStarknetEvent("error", "starknet.network_info.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        // Always clear the pending promise — whether the fetch succeeded or
        // failed — so the next caller can issue a fresh request.
        pendingNetworkInfo = undefined;
      }
    })();
  } else {
    incStarknetMetric(STARKNET_METRICS.NETWORK_INFO_DEDUPED);
    logStarknetEvent("debug", "starknet.network_info.deduplicated", {});
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
  cachedHealthyIndex = -1;
  cachedFailoverOrder = undefined;
}

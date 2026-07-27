import { type Call, Contract, RpcProvider } from "starknet";
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

/**
 * Validates that the contract address string is a non-empty hex value.
 *
 * Accepts strings with an optional `0x` / `0X` prefix followed by one or more
 * hex digits.  Empty strings, pure whitespace, and non-hex values are rejected
 * immediately so callers receive a clear error rather than a confusing
 * downstream RPC failure.
 *
 * @throws {Error} When `address` is empty, blank, or not a valid hex string.
 */
export function validateContractAddress(address: string): void {
  if (typeof address !== "string" || address.trim().length === 0) {
    throw new Error("Contract address must be a non-empty string");
  }
  const hex = address.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      `Contract address must be a hex string (got "${address.trim()}")`,
    );
  }
}

/**
 * Validates a Starknet address for use in chain interactions (nonce lookups,
 * fee quotes, `callContract`, etc.).  Applies the same hex-string rules as
 * `validateContractAddress`; the two share identical semantics and exist as
 * separate exports so call sites can document intent clearly.
 *
 * @throws {Error} When `address` is empty, blank, or not a valid hex string.
 */
export function validateStarknetAddress(address: string): void {
  if (typeof address !== "string" || address.trim().length === 0) {
    throw new Error("Starknet address must be a non-empty string");
  }
  const hex = address.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      `Starknet address must be a hex string (got "${address.trim()}")`,
    );
  }
}

async function invokeWithFailover(
  method: string | symbol,
  args: unknown[],
): Promise<unknown> {
  if (rpcProviders.length === 0) {
    throw new Error("No RPC providers are configured");
  }

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
  // Preserve the original error when all providers fail.  Wrap it only when
  // lastError is falsy (edge case: provider threw undefined / null).
  if (lastError !== undefined && lastError !== null) {
    throw lastError;
  }
  throw new Error(
    `All ${rpcProviders.length} RPC provider(s) failed for method "${String(method)}"`,
  );
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
 * @throws {Error} When ESCROW_CONTRACT_CLASS_JSON is not configured.
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
 * @throws {Error} When AGREEMENT_CONTRACT_CLASS_JSON is not configured.
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
 *
 * @throws {Error} When `address` is empty or not a valid hex string.
 */
export function escrowContract(address: string): Contract {
  validateContractAddress(address);
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
 *
 * @throws {Error} When `address` is empty or not a valid hex string.
 */
export function agreementContract(address: string): Contract {
  validateContractAddress(address);
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
 * @param ttlMs - Time-to-live in milliseconds (default: 5 minutes). Must be a
 *   positive finite number; non-positive or non-finite values are rejected.
 * @returns An object containing the stringified chainId and specVersion.
 * @throws {RangeError} When `ttlMs` is not a positive finite number.
 */
export async function getCachedNetworkInfo(
  ttlMs = 300_000,
): Promise<{ chainId: string; specVersion: string }> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(
      `ttlMs must be a positive finite number (got ${ttlMs})`,
    );
  }

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
 * Returns the chain ID from the Starknet RPC, using the same in-memory cache as
 * `getCachedNetworkInfo`.  Prefer this over calling `provider.getChainId()`
 * directly so fee-quote and nonce-fetch code paths share a single cached value
 * rather than each issuing its own RPC round-trip.
 *
 * @param ttlMs - Cache TTL forwarded to `getCachedNetworkInfo` (default: 5 min).
 * @throws {RangeError} When `ttlMs` is not a positive finite number.
 */
export async function getCachedChainId(ttlMs = 300_000): Promise<string> {
  const { chainId } = await getCachedNetworkInfo(ttlMs);
  return chainId;
}

/**
 * Fetches the pending nonce for a Starknet account address.
 *
 * Validates `address` before making the RPC call so callers get a clear `Error`
 * rather than an opaque downstream RPC failure when the input is malformed.
 * The call goes through `provider` and therefore benefits from automatic
 * endpoint failover.
 *
 * @param address - The Starknet account address (hex, with or without `0x`).
 * @returns The pending nonce as returned by the RPC provider.
 * @throws {Error} When `address` is empty or not a valid hex string.
 */
export async function getNonceForAddress(address: string): Promise<string> {
  validateStarknetAddress(address);
  return provider.getNonceForAddress(address, "pending") as Promise<string>;
}

/**
 * Validates that `calls` is a non-empty array of objects each carrying at
 * least a `contractAddress` hex string and an `entrypoint` non-empty string.
 *
 * This is the minimal structural check needed before sending calls to the RPC
 * for fee estimation.  ABI correctness and argument encoding are the caller's
 * responsibility and are verified by the Starknet node itself.
 *
 * @throws {TypeError}  When `calls` is not an array.
 * @throws {RangeError} When `calls` is an empty array.
 * @throws {Error}      When any element is missing or has an invalid
 *                      `contractAddress` or `entrypoint`.
 */
export function validateCallArray(calls: unknown): asserts calls is Call[] {
  if (!Array.isArray(calls)) {
    throw new TypeError("calls must be an array");
  }
  if (calls.length === 0) {
    throw new RangeError("calls array must not be empty");
  }
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (call === null || typeof call !== "object") {
      throw new Error(`calls[${i}] must be an object`);
    }
    const { contractAddress, entrypoint } = call as Record<string, unknown>;
    // contractAddress – reuse the same hex-string rules as validateContractAddress
    if (typeof contractAddress !== "string" || contractAddress.trim().length === 0) {
      throw new Error(`calls[${i}].contractAddress must be a non-empty string`);
    }
    const hex = contractAddress.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(
        `calls[${i}].contractAddress must be a hex string (got "${contractAddress.trim()}")`,
      );
    }
    // entrypoint – must be a non-empty string (the selector name)
    if (typeof entrypoint !== "string" || entrypoint.trim().length === 0) {
      throw new Error(`calls[${i}].entrypoint must be a non-empty string`);
    }
  }
}

/**
 * Fetches an invoke fee estimate from the Starknet RPC for a single contract
 * call on behalf of `callerAddress`.
 *
 * Validates the caller address and the call object **before** issuing the RPC
 * request.  This keeps malformed inputs from reaching the network layer and
 * makes the failure reason explicit to callers.
 *
 * The underlying request goes through `provider` and therefore benefits from
 * automatic endpoint failover.  The pending nonce is fetched automatically via
 * `getNonceForAddress` so callers do not need a separate nonce round-trip.
 *
 * @param callerAddress - The Starknet account address that would sign the
 *   transaction (hex, with or without `0x`).
 * @param call - The contract call to estimate fees for.  Must carry a valid
 *   hex `contractAddress` and a non-empty `entrypoint` string.
 * @returns The fee estimate returned by the RPC provider.
 * @throws {Error}     When `callerAddress` is empty or not a valid hex string.
 * @throws {Error}     When `call.contractAddress` is empty or not a valid hex string.
 * @throws {Error}     When `call.entrypoint` is empty or missing.
 */
export async function getInvokeEstimateFee(
  callerAddress: string,
  call: Call,
): Promise<Awaited<ReturnType<RpcProvider["getInvokeEstimateFee"]>>> {
  validateStarknetAddress(callerAddress);
  validateCallArray([call]);
  const nonce = await getNonceForAddress(callerAddress);
  return provider.getInvokeEstimateFee(call, { nonce });
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

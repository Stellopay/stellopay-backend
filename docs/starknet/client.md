# Starknet Client (`src/starknet/client.ts`)

Provides the Starknet RPC provider, contract caching, ABI memoization, and
cached network-info helpers used by all route handlers.

---

## Compatibility Contract

This module (`src/starknet/client.ts`) provides a Starknet RPC client with automatic failover, contract caching, and network info caching. The following contract guarantees backward compatibility for existing callers and defines the expected behavior for future changes.

### Public API Surface

- **provider**: RpcProvider proxy with automatic failover across configured endpoints
- **getEscrowAbi()**: Returns memoized escrow contract ABI
- **getAgreementAbi()**: Returns memoized agreement contract ABI
- **escrowContract(address)**: Returns cached escrow Contract instance
- **agreementContract(address)**: Returns cached agreement Contract instance
- **getCachedNetworkInfo(ttlMs?)**: Returns cached chainId and specVersion
- **validateContractAddress(address)**: Validates a contract address hex string
- **validateStarknetAddress(address)**: Validates a Starknet account address hex string
- **validateCallArray(calls)**: Validates a non-empty Call[] for fee estimation
- **getNonceForAddress(address)**: Fetches the pending nonce for an account
- **getCachedChainId(ttlMs?)**: Returns only the chain ID from the cached network info
- **getInvokeEstimateFee(callerAddress, call)**: Estimates fee for a single invoke call
- **clearContractCache()**: Clears memoized ABIs and cached Contract instances (test-only)
- **clearNetworkCache()**: Clears network info cache (test-only)
- **resetRpcFailoverForTests()**: Resets RPC failover state to primary endpoint (test-only)

### Behavior Guarantees

#### 1. RPC Failover

- Tries endpoints in failover order (healthy endpoint first, then others)
- On success, updates `healthyRpcIndex` to the successful endpoint
- Logs `console.warn` on failover with old and new URLs
- Clones RPC arguments before each retry to prevent mutation
- Throws the last error if all endpoints fail; if the last thrown value is falsy, throws `Error("All N RPC provider(s) failed for method "…"")`
- Guards against an empty provider list: throws `Error("No RPC providers are configured")` before attempting any call
- **Argument cloning supports**: primitives, arrays, plain objects, Date, Map, Set
- **Argument cloning does NOT support**: custom class instances, cyclic structures

#### 2. Contract Caching

- Contracts are cached by `"<kind>:<address>"` key (kind = "escrow" or "agreement")
- ABI is parsed from disk once and memoized per contract type
- Same address returns the same Contract instance (reference equality)
- Different addresses return distinct instances even for same contract type
- escrow and agreement contracts never share instances even at same address
- `clearContractCache()` resets all caches and forces reload from disk

#### 3. Network Info Caching

- `getCachedNetworkInfo()` caches chainId and specVersion for default 5-minute TTL
- TTL is configurable via `ttlMs` parameter (milliseconds); must be a positive finite number
- Throws `RangeError` when `ttlMs` is zero, negative, `Infinity`, or `NaN`
- Cache is not poisoned on RPC failure - subsequent calls retry RPC
- `clearNetworkCache()` resets the cache

#### 4. Input Validation

- `validateContractAddress(address)` and `validateStarknetAddress(address)` reject empty, whitespace-only, or non-hex strings **before** any RPC or cache operation
- `validateCallArray(calls)` asserts a non-empty `Call[]` with valid `contractAddress` and `entrypoint` on each item
- `getNonceForAddress(address)` validates the address then delegates to `provider.getNonceForAddress`
- `getInvokeEstimateFee(callerAddress, call)` validates caller + call, fetches nonce automatically, then delegates to `provider.getInvokeEstimateFee`

#### 5. Error Handling

- `getEscrowAbi()` throws Error if `ESCROW_CONTRACT_CLASS_JSON` is not configured
- `getAgreementAbi()` throws Error if `AGREEMENT_CONTRACT_CLASS_JSON` is not configured
- RPC methods propagate errors from the underlying RpcProvider
- All errors are thrown synchronously or as rejected promises

#### 6. Test-Only Functions

- `clearContractCache()`, `clearNetworkCache()`, `resetRpcFailoverForTests()`
- These are exported for testing and should not be used in production code
- They reset module-level state to ensure test isolation

### Backward Compatibility

- All existing exports maintain their current signatures and behavior
- No breaking changes to the public API surface
- Existing callers in `routes/agreement.ts`, `routes/escrow.ts`, `routes/auth.ts`, etc. will continue to work without modification

## RPC Failover

The exported `provider` is a `Proxy` over an array of `RpcProvider` instances,
one per URL in `STARKNET_RPC_URL` (comma-separated). All method calls are routed
through `invokeWithFailover`, which:

1. Tries the last known healthy endpoint first (`healthyRpcIndex`).
2. On failure, iterates the remaining endpoints in configuration order.
3. On success at a different index, logs a `console.warn` with the old and new
   URL and updates `healthyRpcIndex`.
4. If every endpoint fails, re-throws the last error. If the last thrown value is
   falsy, throws `Error("All N RPC provider(s) failed for method "…"")`.

### Idempotency of RPC calls

**Read-only calls** (`getChainId`, `getSpecVersion`, `getTransactionReceipt`,
`estimateFee`, etc.) are always safe to retry — they observe state without
modifying it.

- `invokeWithFailover()` tries endpoints in failover order
- `healthyRpcIndex` tracks the last working endpoint
- Failed-over events log a `console.warn` with the old and new URL
- Each retry receives a fresh copy of the RPC arguments so pagination and batching payloads are not mutated by an earlier failed attempt
- The helper is intentionally scoped to plain JSON-like payloads used by current callers; custom class instances and cyclic structures are out of scope

## Fee Quotes

`getInvokeEstimateFee(callerAddress, call)` validates the caller address and
call object before issuing the RPC request. It fetches the pending nonce
automatically via `getNonceForAddress` so callers do not need a separate
nonce round-trip. The underlying request goes through `provider` and benefits
from automatic endpoint failover.

`estimateFee` is delegated to `starknet.js` `RpcProvider` via the failover
proxy. The call is read-only and idempotent.

---

## In-Flight Deduplication for Network Info

`getCachedNetworkInfo` coalesces concurrent cache-miss requests using
`pendingNetworkInfo`: a single in-flight `Promise` that all concurrent callers
share when the TTL has expired. This prevents N×2 fan-out RPC calls during a
cold start or TTL rollover under load.

The cache is **not poisoned on failure**: a rejected fetch clears
`pendingNetworkInfo` so the next caller issues a fresh request cleanly.

---

## Network Info Cache

`getCachedNetworkInfo(ttlMs?)` returns `{ chainId, specVersion }` with a
default 5-minute TTL. Repeated calls within the TTL return the cached value
without any RPC call.

`getCachedChainId(ttlMs?)` is a convenience wrapper that returns only the
`chainId` string, sharing the same cache so callers that only need the chain ID
do not issue a separate RPC round-trip.

- `clearNetworkCache()` — resets the cache and clears any pending in-flight
  request. Used by tests.

---

## Contract Caching

Contracts are cached by `"<kind>:<address>"` key in a module-level `Map`.
The ABI is parsed from disk exactly once per kind and memoized.

- `escrowContract(address)` - cached escrow instance (validates address on entry)
- `agreementContract(address)` - cached agreement instance (validates address on entry)
- `clearContractCache()` - reset for tests

The kind prefix in the cache key ensures escrow and agreement ABIs never
cross-contaminate even when the same address is used for both.

## Input Validation

### `validateContractAddress(address: string): void`

Guards entry points that accept a contract address string.

**Accepts:** strings with optional `0x`/`0X` prefix followed by hex digits.

**Rejects with `Error`:**
- Empty string or whitespace-only → `"Contract address must be a non-empty string"`
- Non-hex characters after stripping optional prefix → `"Contract address must be a hex string (got "…")"`

### `validateStarknetAddress(address: string): void`

Same rules as `validateContractAddress`; separate export so call sites document
intent clearly (nonce lookups, fee quotes, `callContract`, etc.).

### `validateCallArray(calls: unknown): asserts calls is Call[]`

Structural validation for fee-estimation call arrays.

**Rejects:**
- Non-array → `TypeError("calls must be an array")`
- Empty array → `RangeError("calls array must not be empty")`
- Element with invalid/missing `contractAddress` → `Error("calls[N].contractAddress …")`
- Element with empty/missing `entrypoint` → `Error("calls[N].entrypoint must be a non-empty string")`

## RPC URLs

Configured via `STARKNET_RPC_URL` environment variable (comma-separated). Defaults in `config.ts`.

## Error Handling Summary

| Scenario | Error type | Message pattern |
|---|---|---|
| Empty / blank address | `Error` | `"Contract/Starknet address must be a non-empty string"` |
| Non-hex address | `Error` | `"… must be a hex string (got …)"` |
| Invalid `ttlMs` | `RangeError` | `"ttlMs must be a positive finite number (got …)"` |
| ABI path not configured | `Error` | `"…path is not configured"` |
| No RPC providers configured | `Error` | `"No RPC providers are configured"` |
| All RPC providers fail | last provider error | (re-thrown as-is) |
| Non-array calls | `TypeError` | `"calls must be an array"` |
| Empty calls array | `RangeError` | `"calls array must not be empty"` |

## Edge Cases (Intentionally Out of Scope)

- **Custom class instances**: The argument cloning logic does not support custom class instances beyond Date, Map, and Set. Callers requiring such support should implement their own cloning before invoking RPC methods.
- **Cyclic structures**: The argument cloning logic does not handle cyclic references. Callers should ensure their payloads are acyclic.
- **Concurrent cache invalidation**: The module does not handle concurrent calls that might invalidate caches simultaneously. This is acceptable for the current use case where cache invalidation is primarily test-driven.
- **Dynamic RPC endpoint reconfiguration**: The RPC endpoints are fixed at module initialization. Runtime reconfiguration would require a module reload and is not supported.
- **Full SNIP-23 checksum validation**: Use `normalizeStarknetAddress` in `src/utils/address.ts` when a canonical, checksum-validated address is needed. The `validate*` functions only enforce that the value is a valid hex string.
- **Address length enforcement**: 64-hex-char padding is the caller's responsibility.
- **Retry back-off / jitter**: The failover list is tried once per call; there is no sleep between attempts.

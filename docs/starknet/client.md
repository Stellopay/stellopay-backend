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
- **ChainIdMismatchError**: Error class thrown on chain-ID divergence during failover
- **clearContractCache()**: Clears memoized ABIs and cached Contract instances (test-only)
- **clearNetworkCache()**: Clears network info cache (test-only)
- **resetRpcFailoverForTests()**: Resets RPC failover state to primary endpoint (test-only)

### Behavior Guarantees

#### 1. RPC Failover

- Tries endpoints in failover order (healthy endpoint first, then others)
- On success, updates `healthyRpcIndex` to the successful endpoint
- Logs `console.warn` on failover with old and new URLs
- Clones RPC arguments before each retry to prevent mutation
- Throws the last error if all endpoints fail
- **Argument cloning supports**: primitives, arrays, plain objects, Date, Map, Set
- **Argument cloning does NOT support**: custom class instances, cyclic structures
- **Only `RETRYABLE_METHODS` are eligible for failover**; non-retryable (write/mutation) methods attempt the primary endpoint once and throw immediately on failure
- **Chain ID validation**: after failover, the new endpoint's chain ID is validated against the primary's to prevent cross-chain replay
- **Retry budget**: failover is capped at `MAX_FAILOVER_ATTEMPTS` (= number of configured endpoints)

#### 2. Contract Caching

- Contracts are cached by `"<kind>:<address>"` key (kind = "escrow" or "agreement")
- ABI is parsed from disk once and memoized per contract type
- Same address returns the same Contract instance (reference equality)
- Different addresses return distinct instances even for same contract type
- escrow and agreement contracts never share instances even at same address
- `clearContractCache()` resets all caches and forces reload from disk

#### 3. Network Info Caching

- `getCachedNetworkInfo()` caches chainId and specVersion for default 5-minute TTL
- TTL is configurable via `ttlMs` parameter (milliseconds)
- Cache is not poisoned on RPC failure - subsequent calls retry RPC
- `clearNetworkCache()` resets the cache

#### 4. Error Handling

- `getEscrowAbi()` throws Error if `ESCROW_CONTRACT_CLASS_JSON` is not configured
- `getAgreementAbi()` throws Error if `AGREEMENT_CONTRACT_CLASS_JSON` is not configured
- RPC methods propagate errors from the underlying RpcProvider
- All errors are thrown synchronously or as rejected promises
- Non-retryable methods that fail on the primary endpoint throw without failover
- Chain ID mismatch during failover throws `ChainIdMismatchError`

#### 5. Test-Only Functions

- `clearContractCache()`, `clearNetworkCache()`, `resetRpcFailoverForTests()`
- These are exported for testing and should not be used in production code
- They reset module-level state to ensure test isolation

### Backward Compatibility

- All existing exports maintain their current signatures and behavior
- No breaking changes to the public API surface
- Existing callers in `routes/agreement.ts`, `routes/escrow.ts`, `routes/auth.ts`, etc. will continue to work without modification

---

## Security Boundary — Method Classification

The provider proxy routes all method calls through `invokeWithFailover`, which
classifies each call as **retryable** (read-only) or **non-retryable** (write/mutation):

### Retryable methods (eligible for failover)

These are read-only RPC calls that are safe to retry across endpoints because
they observe state without modifying it:

`getChainId`, `getSpecVersion`, `getBlock`, `getBlockWithTxHashes`,
`getBlockWithTxs`, `getBlockNumber`, `getTransactionReceipt`,
`getTransaction`, `getTransactionStatus`, `getTransactionByBlockIdAndIndex`,
`estimateFee`, `estimateMessageFee`, `callContract`, `getNonceForAddress`,
`getStorageAt`, `getClassHashAt`, `getClass`, `getClassAt`, `getEvents`,
`getBalance`, `getSyncingStats`, `getProtocolVersion`, `pendingTransactions`,
`verifyMessageInStarknet`

### Non-retryable methods (single attempt)

Any method **not** in the retryable set (e.g. `addTransaction`) is attempted
exactly once on the primary endpoint. If it fails, the error is thrown
immediately without trying other endpoints. This prevents double-execution of
state-modifying calls where the first attempt may have succeeded but the
response was lost.

---

## Chain ID Validation During Failover

After a successful failover to a different endpoint, `validateFailoverChainConsistency`
verifies that the new endpoint reports the same chain ID as the primary. This
prevents cross-chain replay of signed data when endpoints are misconfigured or
a network-level redirect occurs.

- If chain IDs match: failover proceeds normally
- If chain IDs diverge: throws `ChainIdMismatchError` with both chain IDs and URLs
- If chain ID validation RPC fails (e.g. primary is also down): logs a warning
  but allows the failover to proceed, since the original RPC call already succeeded

### `ChainIdMismatchError`

```
class ChainIdMismatchError extends Error {
  primaryChainId: string;    // chain ID from the primary endpoint
  secondaryChainId: string;  // chain ID from the failover endpoint
  primaryUrl: string;        // URL of the primary endpoint
  secondaryUrl: string;      // URL of the failover endpoint
}
```

---

## RPC Failover

The exported `provider` is a `Proxy` over an array of `RpcProvider` instances,
one per URL in `STARKNET_RPC_URL` (comma-separated). All method calls are routed
through `invokeWithFailover`, which:

1. Checks if the method is retryable (read-only); if not, attempts only the primary endpoint
2. Tries the last known healthy endpoint first (`healthyRpcIndex`).
3. On failure, iterates the remaining endpoints in configuration order (up to `MAX_FAILOVER_ATTEMPTS`).
4. On success at a different index, validates chain-ID consistency, logs a `console.warn` with the old and new URL and updates `healthyRpcIndex`.
5. If every endpoint fails, re-throws the last error.

### Idempotency of RPC calls

**Read-only calls** (`getChainId`, `getSpecVersion`, `getTransactionReceipt`,
`estimateFee`, etc.) are always safe to retry — they observe state without
modifying it.

- `invokeWithFailover()` tries endpoints in failover order
- `healthyRpcIndex` tracks the last working endpoint
- Failed-over events log a `console.warn` with the old and new URL

## Circuit Breaker

Each RPC endpoint is protected by an independent circuit breaker that composes with the failover logic. The circuit breaker prevents repeated wasted calls to a struggling-but-not-dead endpoint.

- When failures cross the threshold, the circuit **opens** and calls short-circuit immediately
- After a cooldown period, the circuit transitions to **HALF_OPEN** and allows a probe call
- Two consecutive successes **close** the circuit and return the endpoint to normal rotation
- A failing probe immediately **reopens** the circuit

See [circuit-breaker.md](./circuit-breaker.md) for full documentation.

### Configuration

| Env Var | Default | Description |
|---|---|---|
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | Failures in window before opening |
| `CIRCUIT_BREAKER_SUCCESS_THRESHOLD` | `2` | Consecutive successes to close from HALF_OPEN |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | `30000` | Cooldown before attempting recovery |
| `CIRCUIT_BREAKER_WINDOW_MS` | `60000` | Rolling window for failure counting |
- Each retry receives a fresh copy of the RPC arguments so pagination and batching payloads are not mutated by an earlier failed attempt
- The helper is intentionally scoped to plain JSON-like payloads used by current callers; custom class instances and cyclic structures are out of scope

## Fee Quotes

`estimateFee` is delegated to `starknet.js` `RpcProvider` via the failover
proxy. The call is read-only and idempotent, and is listed in `RETRYABLE_METHODS`
so it benefits from automatic failover.

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

- `clearNetworkCache()` — resets the cache and clears any pending in-flight
  request. Used by tests.

---

## Contract Caching

Contracts are cached by `"<kind>:<address>"` key in a module-level `Map`.
The ABI is parsed from disk exactly once per kind and memoized.

- `escrowContract(address)` - cached escrow instance
- `agreementContract(address)` - cached agreement instance
- `clearContractCache()` - reset for tests

The kind prefix in the cache key ensures escrow and agreement ABIs never
cross-contaminate even when the same address is used for both.

`getCachedNetworkInfo()` returns chainId and specVersion with a 5-minute TTL cache.

## Observability & Metrics

`src/starknet/client.ts` exposes structured logging and metric counters for RPC failovers, fee quotes, and chain interactions:

### Structured Logging (`logStarknetEvent`)
Emits JSON when `LOG_FORMAT=json`, otherwise text. Controlled by `LOG_LEVEL`:
- `starknet.rpc.request` / `starknet.rpc.success` / `starknet.rpc.failover` / `starknet.rpc.error`
- `starknet.fee_quote.requested` / `starknet.fee_quote.success` / `starknet.fee_quote.error`
- `starknet.network_info.cache_hit` / `starknet.network_info.fetched` / `starknet.network_info.deduplicated` / `starknet.network_info.failed`

### Metrics (`STARKNET_METRICS`)
Process-local metric counters accessed via `getStarknetMetricsSnapshot()`:
- `starknet_rpc_requests_total`
- `starknet_rpc_failover_total`
- `starknet_rpc_errors_total`
- `starknet_rpc_duration_ms_total`
- `starknet_fee_quote_requests_total`
- `starknet_fee_quote_success_total`
- `starknet_fee_quote_errors_total`
- `starknet_network_info_cache_hits_total`
- `starknet_network_info_fetches_total`
- `starknet_network_info_deduped_total`
- `starknet_network_info_errors_total`

- `resetStarknetMetrics()` — resets counters (used by tests).

## Performance Optimizations

To reduce redundant computation and allocation during high-frequency RPC retries, fee quotes, and chain interactions:

- **Fast-Path Argument Cloning**: Empty argument arrays (`[]`) and primitive value arguments (`string`, `number`, `boolean`, `bigint`, `symbol`, `null`, `undefined`) bypass recursive deep tree traversal, returning immediate shallow copies without garbage collection overhead.
- **Failover Order Array Caching**: Prevents allocating new index arrays on every RPC invocation when a single provider is configured or when the healthy endpoint index has not changed.
- **Proxy Method Binding Cache**: Caches method wrappers on the `provider` proxy to avoid creating new function closures on repeated method accesses.
- **Contract Address Normalization**: Normalizes hex casing and surrounding whitespace in contract addresses before building cache keys, preventing duplicate `Contract` instance creation for equivalent addresses.

## RPC URLs

Configured via `STARKNET_RPC_URL` environment variable (comma-separated). Defaults in `config.ts`.

## Edge Cases (Intentionally Out of Scope)

The following edge cases are intentionally out of scope for this compatibility contract:

- **Custom class instances**: The argument cloning logic does not support custom class instances beyond Date, Map, and Set. Callers requiring such support should implement their own cloning before invoking RPC methods.
- **Cyclic structures**: The argument cloning logic does not handle cyclic references. Callers should ensure their payloads are acyclic.
- **Concurrent cache invalidation**: The module does not handle concurrent calls that might invalidate caches simultaneously. This is acceptable for the current use case where cache invalidation is primarily test-driven.
- **Dynamic RPC endpoint reconfiguration**: The RPC endpoints are fixed at module initialization. Runtime reconfiguration would require a module reload and is not supported.
- **Write-method retry policies**: The current design fails non-retryable methods immediately. Future callers that need retry semantics for write methods (e.g. with idempotency keys) should implement their own retry logic outside the provider proxy.
- **Chain ID validation for primary endpoint**: Chain ID is only validated during failover, not on the primary endpoint. Primary endpoint chain ID is assumed correct based on configuration.

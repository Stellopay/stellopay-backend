# Starknet Client (`src/starknet/client.ts`)

Provides the Starknet RPC provider, contract caching, ABI memoization, and
cached network-info helpers used by all route handlers.

---

## RPC Failover

The exported `provider` is a `Proxy` over an array of `RpcProvider` instances,
one per URL in `STARKNET_RPC_URL` (comma-separated). All method calls are routed
through `invokeWithFailover`, which:

1. Tries the last known healthy endpoint first (`healthyRpcIndex`).
2. On failure, iterates the remaining endpoints in configuration order.
3. On success at a different index, logs a `console.warn` with the old and new
   URL and updates `healthyRpcIndex`.
4. If every endpoint fails, re-throws the last error.

### Idempotency of RPC calls

**Read-only calls** (`getChainId`, `getSpecVersion`, `getTransactionReceipt`,
`estimateFee`, etc.) are always safe to retry — they observe state without
modifying it.

- invokeWithFailover() tries endpoints in failover order
- healthyRpcIndex tracks the last working endpoint
- Failed-over events log a console.warn with the old and new URL
- Each retry receives a fresh copy of the RPC arguments so pagination and batching payloads are not mutated by an earlier failed attempt
- The helper is intentionally scoped to plain JSON-like payloads used by current callers; custom class instances and cyclic structures are out of scope for this change

## Fee Quotes

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

- `clearNetworkCache()` — resets the cache and clears any pending in-flight
  request. Used by tests.

---

## Contract Caching

Contracts are cached by `"<kind>:<address>"` key in a module-level `Map`.
The ABI is parsed from disk exactly once per kind and memoized.

| Function | Description |
| :--- | :--- |
| `escrowContract(address)` | Returns a cached `Contract` instance for the `PayrollEscrow` ABI at `address`. |
| `agreementContract(address)` | Returns a cached `Contract` instance for the `WorkAgreement` ABI at `address`. |
| `getEscrowAbi()` | Returns the memoized escrow ABI array. |
| `getAgreementAbi()` | Returns the memoized agreement ABI array. |
| `clearContractCache()` | Resets ABI memos and the contract instance cache. Used by tests. |

The kind prefix in the cache key ensures escrow and agreement ABIs never
cross-contaminate even when the same address is used for both.

---

## RPC URLs

Configured via the `STARKNET_RPC_URL` environment variable (comma-separated
HTTPS URLs, primary first). Parsed by `parseStarknetRpcUrls` in
`src/starknet/rpc-urls.ts`.

---

## Test Utilities

| Function | Description |
| :--- | :--- |
| `clearNetworkCache()` | Resets the network info cache and pending promise. |
| `clearContractCache()` | Resets ABI memos and contract instance cache. |
| `resetRpcFailoverForTests()` | Resets `healthyRpcIndex` to 0 (primary endpoint). |

# Starknet Client - RPC, Fees, and Chain Interactions

## Compatibility Contract

This module (`src/starknet/client.ts`) provides a Starknet RPC client with automatic failover, contract caching, and network info caching. The following contract guarantees backward compatibility for existing callers and defines the expected behavior for future changes.

### Public API Surface

- **provider**: RpcProvider proxy with automatic failover across configured endpoints
- **getEscrowAbi()**: Returns memoized escrow contract ABI
- **getAgreementAbi()**: Returns memoized agreement contract ABI
- **escrowContract(address)**: Returns cached escrow Contract instance
- **agreementContract(address)**: Returns cached agreement Contract instance
- **getCachedNetworkInfo(ttlMs?)**: Returns cached chainId and specVersion
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

#### 5. Test-Only Functions

- `clearContractCache()`, `clearNetworkCache()`, `resetRpcFailoverForTests()`
- These are exported for testing and should not be used in production code
- They reset module-level state to ensure test isolation

### Backward Compatibility

- All existing exports maintain their current signatures and behavior
- No breaking changes to the public API surface
- Existing callers in `routes/agreement.ts`, `routes/escrow.ts`, `routes/auth.ts`, etc. will continue to work without modification

## RPC Failover

The provider wraps multiple RPC endpoints with automatic failover. When the active endpoint fails, the next healthy one is tried. On success, it becomes the new primary.

- `invokeWithFailover()` tries endpoints in failover order
- `healthyRpcIndex` tracks the last working endpoint
- Failed-over events log a `console.warn` with the old and new URL
- Each retry receives a fresh copy of the RPC arguments so pagination and batching payloads are not mutated by an earlier failed attempt
- The helper is intentionally scoped to plain JSON-like payloads used by current callers; custom class instances and cyclic structures are out of scope

## Fee Quotes

Fee estimation is delegated to starknet.js RpcProvider. All contract calls use the provider proxy which routes through the failover logic.

## Contract Caching

Contracts are cached by address and type (escrow/agreement). The ABI is parsed from disk once and memoized.

- `escrowContract(address)` - cached escrow instance
- `agreementContract(address)` - cached agreement instance
- `clearContractCache()` - reset for tests

## Network Info

`getCachedNetworkInfo()` returns chainId and specVersion with a 5-minute TTL cache.

## RPC URLs

Configured via `STARKNET_RPC_URL` environment variable (comma-separated). Defaults in `config.ts`.

## Edge Cases (Intentionally Out of Scope)

The following edge cases are intentionally out of scope for this compatibility contract:

- **Custom class instances**: The argument cloning logic does not support custom class instances beyond Date, Map, and Set. Callers requiring such support should implement their own cloning before invoking RPC methods.
- **Cyclic structures**: The argument cloning logic does not handle cyclic references. Callers should ensure their payloads are acyclic.
- **Concurrent cache invalidation**: The module does not handle concurrent calls that might invalidate caches simultaneously. This is acceptable for the current use case where cache invalidation is primarily test-driven.
- **Dynamic RPC endpoint reconfiguration**: The RPC endpoints are fixed at module initialization. Runtime reconfiguration would require a module reload and is not supported.

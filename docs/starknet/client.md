# Starknet Client - RPC, Fees, and Chain Interactions

## RPC Failover

The provider wraps multiple RPC endpoints with automatic failover. When the active endpoint fails, the next healthy one is tried. On success, it becomes the new primary.

- invokeWithFailover() tries endpoints in failover order
- healthyRpcIndex tracks the last working endpoint
- Failed-over events log a console.warn with the old and new URL
- Each retry receives a fresh copy of the RPC arguments so pagination and batching payloads are not mutated by an earlier failed attempt
- The helper is intentionally scoped to plain JSON-like payloads used by current callers; custom class instances and cyclic structures are out of scope for this change

## Fee Quotes

Fee estimation is delegated to starknet.js RpcProvider. All contract calls use the provider proxy which routes through the failover logic.

## Contract Caching

Contracts are cached by address and type (escrow/agreement). The ABI is parsed from disk once and memoized.

- escrowContract(address) - cached escrow instance
- agreementContract(address) - cached agreement instance
- clearContractCache() - reset for tests

## Network Info

getCachedNetworkInfo() returns chainId and specVersion with a 5-minute TTL cache.

## RPC URLs

Configured via STARKNET_RPC_URLS environment variable (comma-separated). Defaults in config.ts.

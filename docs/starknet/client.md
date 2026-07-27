# Starknet Client - RPC, Fees, and Chain Interactions

## RPC Failover

The provider wraps multiple RPC endpoints with automatic failover. When the active endpoint fails, the next healthy one is tried. On success, it becomes the new primary.

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

## Fee Quotes

Fee estimation is delegated to starknet.js RpcProvider. All contract calls use the provider proxy which routes through the failover logic.

## Contract Caching

Contracts are cached by address and type (escrow/agreement). The ABI is parsed from disk once and memoized.

- `escrowContract(address)` - cached escrow instance
- `agreementContract(address)` - cached agreement instance
- `clearContractCache()` - reset for tests

## Network Info

`getCachedNetworkInfo()` returns chainId and specVersion with a 5-minute TTL cache.

## Diagnostics

`getCircuitBreakerSnapshots()` returns a safe, read-only view of all circuit breaker states, included in the `GET /diagnostics/events` response.

## RPC URLs

Configured via `STARKNET_RPC_URL` environment variable (comma-separated). Defaults in config.ts.

## Test Utilities

- `resetRpcFailoverForTests()` — reset healthyRpcIndex to 0
- `resetCircuitBreakersForTests()` — reset all circuit breakers to CLOSED
- `clearNetworkCache()` — clear chainId/specVersion cache
- `clearContractCache()` — clear ABI and contract instance caches

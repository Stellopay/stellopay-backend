# Runbook: Starknet Circuit Breaker

**Owner:** Backend / Platform  
**Severity when triggered:** Medium (degraded RPC, failover may cover it)

---

## Overview

Each Starknet RPC endpoint is protected by an `EndpointCircuitBreaker`
(`src/starknet/circuit-breaker.ts`).  When an endpoint accumulates enough
failures inside a rolling time window, the circuit opens and all further
calls to that endpoint are fast-rejected until a cooldown elapses and
recovery probes succeed.

The circuit breaker composes with RPC failover — when the primary endpoint's
circuit opens, requests automatically fall over to the next endpoint in the
configured failover list.

---

## Symptoms

| Symptom                                                                  | Likely Cause                          |
| ------------------------------------------------------------------------ | ------------------------------------- |
| `[starknet] Circuit breaker OPENED for <url>` in logs                    | Endpoint crossed failure threshold    |
| `[starknet] Circuit breaker re-OPENED for <url>`                         | Probe call during HALF_OPEN failed    |
| `CircuitOpenError` thrown to callers                                     | All endpoints have open circuits      |
| `starknet_circuit_breaker_state` gauge = 1 (OPEN) for > 5 minutes        | Endpoint remains unhealthy            |
| `starknet_circuit_breaker_transitions_total` incrementing rapidly        | Flapping — repeated OPEN ↔ HALF_OPEN  |
| Increased latency on agreement/token/escrow reads                        | Failover to secondary endpoint        |
| Diagnostics endpoint shows `"state": "OPEN"` for one or more breakers    | Active circuit protection             |

---

## Relevant Environment Variables

| Variable                              | Default      | Description                                       |
| ------------------------------------- | ------------ | ------------------------------------------------- |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD`   | `5`          | Failures in window before circuit opens           |
| `CIRCUIT_BREAKER_SUCCESS_THRESHOLD`   | `2`          | Consecutive successes needed to close from HALF_OPEN |
| `CIRCUIT_BREAKER_COOLDOWN_MS`         | `30000`      | Time (ms) circuit stays OPEN before probing       |
| `CIRCUIT_BREAKER_WINDOW_MS`           | `60000`      | Rolling window (ms) for counting failures         |
| `STARKNET_RPC_URL`                    | *(required)* | Comma-separated RPC endpoints                    |

See `src/config.ts` and `docs/starknet/circuit-breaker.md` for full
configuration details.

---

## Diagnostics Endpoints to Check First

### 1. `GET /api/v1/diagnostics/events` (admin auth required)

Returns the `circuitBreakers` array with per-endpoint state:

```json
"circuitBreakers": [
  {
    "endpointUrl": "https://starknet-mainnet.example.com/rpc",
    "state": "CLOSED",
    "recentFailureCount": 0,
    "openedAt": null
  }
]
```

| Field                | Meaning                                           |
| -------------------- | ------------------------------------------------- |
| `state`              | `CLOSED`, `OPEN`, or `HALF_OPEN`                  |
| `recentFailureCount` | Failures in the current rolling window             |
| `openedAt`           | Epoch ms when circuit opened (`null` if CLOSED)    |

### 2. `GET /api/v1/system/ready`

Returns RPC health: `"starknet-rpc": "reachable"` or `"unreachable"`.  If
the readiness probe itself can reach the RPC, failover is likely working —
the circuit breaker is protecting callers from a known-bad endpoint.

---

## Step-by-Step Response

### 1. Triage: Is failover covering it?

Check logs and diagnostics.  If the primary circuit is OPEN but the
secondary is CLOSED and serving requests, the system is degraded but
functional.  No immediate action required — monitor for recovery.

### 2. All circuits OPEN (critical)

If every configured RPC endpoint has an open circuit, **all** Starknet
calls will fail.  Steps:

1. Verify the RPC endpoints are reachable from the backend host:
   ```bash
   curl -s -X POST <RPC_URL> \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"starknet_blockNumber","params":[],"id":1}'
   ```
2. If the RPC endpoints are healthy but the circuit breaker hasn't
   recovered, the `CIRCUIT_BREAKER_COOLDOWN_MS` may be too long or the
   `CIRCUIT_BREAKER_SUCCESS_THRESHOLD` may be too high for the current
   endpoint behavior.
3. **Immediate mitigation**: If the RPC is confirmed healthy, restart the
   backend process — circuits start in CLOSED state.
4. Consider reducing `CIRCUIT_BREAKER_COOLDOWN_MS` (e.g. to `15000`) or
   increasing `CIRCUIT_BREAKER_FAILURE_THRESHOLD` if the endpoint is
   known to have occasional blips.

### 3. Circuit flapping (rapid OPEN ↔ HALF_OPEN transitions)

This indicates partial recovery — probes succeed intermittently but regular
traffic still fails.

1. Check the RPC endpoint's error rate at the provider level.
2. Increase `CIRCUIT_BREAKER_WINDOW_MS` to smooth out transient failures.
3. Increase `CIRCUIT_BREAKER_SUCCESS_THRESHOLD` to require more consecutive
   successes before closing.

### 4. Post-incident

1. Review logs for the root cause of RPC failures (timeouts, rate limits,
   provider outage).
2. Adjust circuit breaker thresholds if the defaults are too sensitive or
   too lenient for your RPC provider's characteristics.
3. Ensure at least two independent RPC endpoints are configured in
   `STARKNET_RPC_URL` for failover resilience.

---

## Metrics Reference

| Metric                                              | Type    | Meaning                                      |
| --------------------------------------------------- | ------- | -------------------------------------------- |
| `starknet_circuit_breaker_state`                    | Gauge   | 0=CLOSED, 1=OPEN, 2=HALF_OPEN (per endpoint) |
| `starknet_circuit_breaker_transitions_total`        | Counter | Label: `{endpoint, transition}`               |

**Alert thresholds (suggested):**

- `state = 1` for > 5 minutes on any endpoint → investigate
- `CLOSED_to_OPEN` transitions > 5 in 10 minutes → flapping, investigate

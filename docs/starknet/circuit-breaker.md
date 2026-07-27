# Starknet Circuit Breaker

## Overview

The circuit breaker pattern prevents cascading failures and reduces latency by failing fast when an RPC endpoint is unhealthy. Each Starknet RPC endpoint is protected by its own circuit breaker instance that tracks failures and manages state transitions.

## States

### CLOSED (Normal Operation)
- All calls pass through normally
- Recent failures are tracked in a rolling time window
- Transitions to OPEN when failures reach the configured threshold

### OPEN (Fail-Fast)
- All calls are immediately rejected with `CircuitOpenError`
- No actual RPC calls are made, saving timeout costs
- After a cooldown period, transitions to HALF_OPEN to test recovery

### HALF_OPEN (Recovery Probe)
- A single probe call is allowed through to test endpoint health
- Success: Accumulates toward `successThreshold` to close the circuit
- Failure: Immediately reopens the circuit and resets the cooldown

## Configuration

Circuit breaker behavior is controlled via environment variables:

```bash
# Number of failures before circuit opens (default: 5)
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5

# Number of successes needed to close from HALF_OPEN (default: 2)
CIRCUIT_BREAKER_SUCCESS_THRESHOLD=2

# Cooldown period before attempting recovery (default: 30000ms = 30s)
CIRCUIT_BREAKER_COOLDOWN_MS=30000

# Rolling time window for counting failures (default: 60000ms = 60s)
CIRCUIT_BREAKER_WINDOW_MS=60000
```

## Integration with Failover

The circuit breaker composes with the existing RPC failover logic:

1. **Circuit Open**: When a circuit is open, `invokeWithFailover` immediately skips that endpoint and tries the next one in the failover order
2. **Failover Triggered**: If the primary endpoint's circuit opens, subsequent calls automatically use the healthy secondary endpoint
3. **Recovery**: After the cooldown, the circuit attempts recovery with a probe call

This combination provides both fast failure detection (circuit breaker) and automatic endpoint switching (failover).

## Monitoring

Circuit breaker state is exposed in the diagnostics endpoint (`GET /diagnostics/events`):

```json
{
  "circuitBreakers": [
    {
      "endpointUrl": "https://rpc.example.com",
      "state": "CLOSED",
      "recentFailureCount": 0,
      "openedAt": null
    }
  ]
}
```

### State Fields

- **endpointUrl**: The RPC endpoint URL
- **state**: Current circuit state (`CLOSED`, `OPEN`, or `HALF_OPEN`)
- **recentFailureCount**: Number of failures in the current rolling window
- **openedAt**: Timestamp when circuit opened (milliseconds since epoch), or `null` if closed

## Example Scenarios

### Scenario 1: Endpoint Degrades
1. RPC endpoint starts returning timeouts
2. After 5 failures in 60 seconds, circuit opens
3. Subsequent calls skip this endpoint immediately
4. Failover to secondary endpoint succeeds
5. After 30 seconds, circuit attempts recovery
6. 2 successful probe calls close the circuit
7. Endpoint returns to normal rotation

### Scenario 2: Temporary Network Blip
1. 2 failures occur due to temporary network issue
2. Circuit remains CLOSED (below threshold of 5)
3. After 60 seconds, these failures age out of the window
4. No circuit opening occurs

### Scenario 3: All Endpoints Down
1. Primary circuit opens after 5 failures
2. Failover to secondary
3. Secondary also fails 5 times and circuit opens
4. All circuits open, final request throws error
5. After cooldown, both circuits attempt recovery
6. First endpoint to recover closes its circuit and handles requests

## Implementation Details

### Failure Tracking

Failures are tracked with timestamps in a rolling window. Old failures outside the window are automatically pruned, ensuring the circuit only reacts to recent patterns.

```typescript
// Example: 3 failures at t=0, t=30s, t=120s with 60s window
// At t=120s: Only the t=30s and t=120s failures count (2 total)
// The t=0 failure is outside the 60s window and is pruned
```

### Half-Open Behavior

In HALF_OPEN state, only one probe call is allowed through at a time. This prevents a "thundering herd" of simultaneous recovery attempts that could overwhelm a recovering endpoint.

### Success Threshold Rationale

The `successThreshold` of 2 (default) prevents premature circuit closure from a single lucky success. Two consecutive successes provide more confidence that the endpoint has genuinely recovered.

## Testing

The circuit breaker is tested at two levels:

1. **Unit Tests** (`circuit-breaker.test.ts`): Test state transitions, threshold logic, and time windows
2. **Integration Tests** (`client.test.ts`): Test interaction with failover, proxy behavior, and end-to-end flows

All tests achieve >95% coverage as required by project guidelines.

## Security Considerations

The circuit breaker improves security posture by:

1. **Reducing Attack Surface**: Open circuits prevent repeated calls to potentially compromised endpoints
2. **DoS Mitigation**: Fail-fast behavior prevents resource exhaustion from hanging calls
3. **Observable State**: Circuit state is exposed in diagnostics for operator visibility

Circuit state does not leak sensitive information (e.g., request contents or user data) and is safe to expose in admin-only diagnostics endpoints.

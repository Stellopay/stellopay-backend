import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  EndpointCircuitBreaker,
  CircuitOpenError,
  snapshotCircuitBreaker,
  type CircuitBreakerOptions,
} from "./circuit-breaker.js";
import {
  getStarknetMetricsSnapshot,
  resetStarknetMetrics,
} from "./client-metrics.js";

const ENDPOINT = "https://rpc.example.com";

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  successThreshold: 2,
  cooldownMs: 10_000,
  windowMs: 60_000,
};

function makeBreaker(opts: Partial<CircuitBreakerOptions> = {}): EndpointCircuitBreaker {
  return new EndpointCircuitBreaker(ENDPOINT, { ...DEFAULT_OPTIONS, ...opts });
}

// ---------------------------------------------------------------------------
// CircuitOpenError
// ---------------------------------------------------------------------------
describe("CircuitOpenError", () => {
  it("is an Error with the correct name", () => {
    const err = new CircuitOpenError(ENDPOINT);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CircuitOpenError");
  });

  it("includes the endpoint URL in the message", () => {
    const err = new CircuitOpenError(ENDPOINT);
    expect(err.message).toContain(ENDPOINT);
  });

  it("exposes endpointUrl", () => {
    const err = new CircuitOpenError(ENDPOINT);
    expect(err.endpointUrl).toBe(ENDPOINT);
  });
});

describe("circuit breaker metrics", () => {
  beforeEach(() => resetStarknetMetrics());

  it("records the current state and every transition with endpoint labels", () => {
    const breaker = makeBreaker({ failureThreshold: 1 });
    breaker.recordFailure();

    const { gauges, counters } = getStarknetMetricsSnapshot();
    expect(gauges['starknet_circuit_breaker_state{endpoint="https://rpc.example.com"}']).toBe(1);
    expect(
      counters[
        'starknet_circuit_breaker_transitions_total{endpoint="https://rpc.example.com",transition="CLOSED_to_OPEN"}'
      ],
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
describe("EndpointCircuitBreaker — initial state", () => {
  it("starts in CLOSED state", () => {
    const b = makeBreaker();
    expect(b.currentState).toBe("CLOSED");
  });

  it("permits calls when CLOSED", () => {
    const b = makeBreaker();
    expect(b.isCallPermitted()).toBe(true);
  });

  it("exposes the endpoint URL", () => {
    const b = makeBreaker();
    expect(b.endpointUrl).toBe(ENDPOINT);
  });
});

// ---------------------------------------------------------------------------
// CLOSED → OPEN transition
// ---------------------------------------------------------------------------
describe("EndpointCircuitBreaker — CLOSED → OPEN", () => {
  let b: EndpointCircuitBreaker;

  beforeEach(() => {
    b = makeBreaker({ failureThreshold: 3 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays CLOSED below the failure threshold", () => {
    b.recordFailure();
    b.recordFailure();
    expect(b.currentState).toBe("CLOSED");
    expect(b.isCallPermitted()).toBe(true);
  });

  it("opens after reaching the failure threshold", () => {
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.currentState).toBe("OPEN");
  });

  it("denies calls immediately once OPEN", () => {
    for (let i = 0; i < 3; i++) b.recordFailure();
    expect(b.isCallPermitted()).toBe(false);
  });

  it("does not open when failures fall outside the time window", () => {
    // Two failures, then advance past the window so they expire
    b.recordFailure();
    b.recordFailure();
    vi.advanceTimersByTime(DEFAULT_OPTIONS.windowMs + 1);
    // This third failure is within window but the earlier two are pruned
    b.recordFailure();
    expect(b.currentState).toBe("CLOSED");
  });

  it("counts only failures within the rolling window", () => {
    // First failure — will later fall outside the window
    b.recordFailure();
    vi.advanceTimersByTime(DEFAULT_OPTIONS.windowMs + 1);
    // Two more failures within the fresh window
    b.recordFailure();
    b.recordFailure();
    // Total in-window: 2 (below threshold of 3)
    expect(b.currentState).toBe("CLOSED");
    // One more should open it
    b.recordFailure();
    expect(b.currentState).toBe("OPEN");
  });

  it("logs a warning when the circuit opens from CLOSED", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) b.recordFailure();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("OPENED"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(ENDPOINT));
    warnSpy.mockRestore();
  });

  it("success in CLOSED state does not open the circuit", () => {
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess(); // should not reset failure count (prune only)
    b.recordFailure();
    // still only 2 in-window failures after prune; should stay CLOSED
    expect(b.currentState).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// OPEN → HALF_OPEN transition
// ---------------------------------------------------------------------------
describe("EndpointCircuitBreaker — OPEN → HALF_OPEN", () => {
  let b: EndpointCircuitBreaker;

  beforeEach(() => {
    b = makeBreaker({ failureThreshold: 2, cooldownMs: 5_000 });
    vi.useFakeTimers();
    // Open the circuit
    b.recordFailure();
    b.recordFailure();
    expect(b.currentState).toBe("OPEN");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("remains OPEN before cooldown elapses", () => {
    vi.advanceTimersByTime(4_999);
    expect(b.isCallPermitted()).toBe(false);
    expect(b.currentState).toBe("OPEN");
  });

  it("transitions to HALF_OPEN after cooldown", () => {
    vi.advanceTimersByTime(5_000);
    b.isCallPermitted(); // triggers the transition
    expect(b.currentState).toBe("HALF_OPEN");
  });

  it("permits exactly one call in HALF_OPEN", () => {
    vi.advanceTimersByTime(5_000);
    expect(b.isCallPermitted()).toBe(true); // probe allowed
  });

  it("logs info when transitioning to HALF_OPEN", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.advanceTimersByTime(5_000);
    b.isCallPermitted();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("HALF-OPEN"));
    infoSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// HALF_OPEN → CLOSED (successful recovery)
// ---------------------------------------------------------------------------
describe("EndpointCircuitBreaker — HALF_OPEN → CLOSED", () => {
  let b: EndpointCircuitBreaker;

  beforeEach(() => {
    b = makeBreaker({ failureThreshold: 2, cooldownMs: 1_000, successThreshold: 2 });
    vi.useFakeTimers();
    // Open circuit then advance past cooldown
    b.recordFailure();
    b.recordFailure();
    vi.advanceTimersByTime(1_001);
    b.isCallPermitted(); // → HALF_OPEN
    expect(b.currentState).toBe("HALF_OPEN");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays HALF_OPEN after fewer successes than the success threshold", () => {
    b.recordSuccess();
    expect(b.currentState).toBe("HALF_OPEN");
  });

  it("closes the circuit after meeting successThreshold", () => {
    b.recordSuccess();
    b.recordSuccess();
    expect(b.currentState).toBe("CLOSED");
  });

  it("permits calls again once CLOSED", () => {
    b.recordSuccess();
    b.recordSuccess();
    expect(b.isCallPermitted()).toBe(true);
  });

  it("logs info when circuit closes", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    b.recordSuccess();
    b.recordSuccess();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("CLOSED"));
    infoSpy.mockRestore();
  });

  it("clears failure history and opened-at timestamp when CLOSED", () => {
    b.recordSuccess();
    b.recordSuccess();
    const snap = snapshotCircuitBreaker(b);
    expect(snap.recentFailureCount).toBe(0);
    expect(snap.openedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HALF_OPEN → OPEN (probe failure)
// ---------------------------------------------------------------------------
describe("EndpointCircuitBreaker — HALF_OPEN → OPEN on probe failure", () => {
  let b: EndpointCircuitBreaker;

  beforeEach(() => {
    b = makeBreaker({ failureThreshold: 2, cooldownMs: 1_000, successThreshold: 2 });
    vi.useFakeTimers();
    b.recordFailure();
    b.recordFailure();
    vi.advanceTimersByTime(1_001);
    b.isCallPermitted(); // → HALF_OPEN
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reopens the circuit on probe failure", () => {
    b.recordFailure();
    expect(b.currentState).toBe("OPEN");
  });

  it("denies calls after reopening", () => {
    b.recordFailure();
    expect(b.isCallPermitted()).toBe(false);
  });

  it("resets consecutive successes counter when reopened", () => {
    b.recordSuccess(); // 1 success in HALF_OPEN
    b.recordFailure(); // probe failure → OPEN
    // Advance cooldown again
    vi.advanceTimersByTime(1_001);
    b.isCallPermitted(); // → HALF_OPEN again
    // Need full successThreshold successes from scratch
    b.recordSuccess();
    expect(b.currentState).toBe("HALF_OPEN");
    b.recordSuccess();
    expect(b.currentState).toBe("CLOSED");
  });

  it("logs a warning mentioning HALF_OPEN when the probe fails", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    b.recordFailure();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("HALF_OPEN"));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------
describe("EndpointCircuitBreaker — reset()", () => {
  it("returns to CLOSED from OPEN", () => {
    const b = makeBreaker({ failureThreshold: 2 });
    b.recordFailure();
    b.recordFailure();
    expect(b.currentState).toBe("OPEN");
    b.reset();
    expect(b.currentState).toBe("CLOSED");
  });

  it("clears failure history on reset", () => {
    const b = makeBreaker({ failureThreshold: 5 });
    b.recordFailure();
    b.recordFailure();
    b.reset();
    const snap = snapshotCircuitBreaker(b);
    expect(snap.recentFailureCount).toBe(0);
  });

  it("permits calls after reset", () => {
    const b = makeBreaker({ failureThreshold: 2 });
    b.recordFailure();
    b.recordFailure();
    b.reset();
    expect(b.isCallPermitted()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// snapshotCircuitBreaker
// ---------------------------------------------------------------------------
describe("snapshotCircuitBreaker", () => {
  it("returns correct state for a CLOSED breaker", () => {
    const b = makeBreaker();
    const snap = snapshotCircuitBreaker(b);
    expect(snap.state).toBe("CLOSED");
    expect(snap.recentFailureCount).toBe(0);
    expect(snap.openedAt).toBeNull();
    expect(snap.endpointUrl).toBe(ENDPOINT);
  });

  it("returns correct state for an OPEN breaker", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 2 });
    b.recordFailure();
    b.recordFailure();
    const snap = snapshotCircuitBreaker(b);
    expect(snap.state).toBe("OPEN");
    expect(snap.recentFailureCount).toBe(2);
    expect(snap.openedAt).toBeTypeOf("number");
    vi.useRealTimers();
  });

  it("returns correct state for a HALF_OPEN breaker", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 2, cooldownMs: 100 });
    b.recordFailure();
    b.recordFailure();
    vi.advanceTimersByTime(101);
    b.isCallPermitted();
    const snap = snapshotCircuitBreaker(b);
    expect(snap.state).toBe("HALF_OPEN");
    vi.useRealTimers();
  });
});

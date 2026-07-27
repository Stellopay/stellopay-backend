/**
 * Circuit breaker for Starknet RPC endpoints.
 *
 * Each RPC endpoint gets its own `EndpointCircuitBreaker` instance. The
 * breaker moves through three states:
 *
 *   CLOSED  →  failures accumulate inside a rolling time window
 *           →  once `failureThreshold` failures occur in `windowMs`, it opens
 *
 *   OPEN    →  all calls are immediately rejected (fail-fast)
 *           →  after `cooldownMs` elapses the breaker transitions to HALF_OPEN
 *
 *   HALF_OPEN → a single probe call is allowed through
 *             → on success: `successThreshold` consecutive successes close it
 *             → on failure: resets to OPEN, starting the cooldown again
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Number of failures in the rolling window that open the circuit. */
  failureThreshold: number;
  /** Number of consecutive successes in HALF_OPEN state that close the circuit. */
  successThreshold: number;
  /** Duration (ms) an OPEN circuit waits before transitioning to HALF_OPEN. */
  cooldownMs: number;
  /**
   * Rolling window size (ms) used to count recent failures.
   * Failures older than this window are not counted towards the threshold.
   */
  windowMs: number;
}

export class CircuitOpenError extends Error {
  readonly endpointUrl: string;

  constructor(endpointUrl: string) {
    super(`Circuit breaker OPEN for RPC endpoint: ${endpointUrl}`);
    this.name = "CircuitOpenError";
    this.endpointUrl = endpointUrl;
  }
}

export class EndpointCircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureTimestamps: number[] = [];
  private consecutiveSuccesses = 0;
  private openedAt: number | null = null;
  private readonly options: CircuitBreakerOptions;
  readonly endpointUrl: string;
  constructor(endpointUrl: string, options: CircuitBreakerOptions) {
    this.endpointUrl = endpointUrl;
    this.options = options;
  }

  /** Current circuit state. */
  get currentState(): CircuitState {
    return this.state;
  }

  /** Number of failures recorded in the current rolling window. */
  get recentFailureCount(): number {
    return this.failureTimestamps.length;
  }

  /** Timestamp (ms) when the circuit was last opened, or null when closed. */
  get openedAtMs(): number | null {
    return this.openedAt;
  }

  /**
   * Returns `true` when this circuit will allow a call to pass through.
   * Also handles the OPEN → HALF_OPEN transition when cooldown has elapsed.
   */
  isCallPermitted(): boolean {
    if (this.state === "CLOSED") {
      return true;
    }

    if (this.state === "OPEN") {
      const now = Date.now();
      if (this.openedAt !== null && now - this.openedAt >= this.options.cooldownMs) {
        // Cooldown elapsed — let one probe call through
        this.transitionTo("HALF_OPEN");
        return true;
      }
      return false;
    }

    // HALF_OPEN: only one concurrent probe is permitted; all other callers are
    // fast-rejected to avoid thundering-herd recovery spikes.
    return true;
  }

  /**
   * Records a successful RPC call against this endpoint.
   * In HALF_OPEN state, accumulates successes toward closing the circuit.
   */
  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.options.successThreshold) {
        this.transitionTo("CLOSED");
      }
      return;
    }

    if (this.state === "CLOSED") {
      // Reset the failure window on success so isolated errors don't linger
      this.pruneOldFailures();
    }
  }

  /**
   * Records a failed RPC call against this endpoint.
   * May open the circuit when the failure threshold is reached.
   */
  recordFailure(): void {
    if (this.state === "HALF_OPEN") {
      // Any failure during probe → back to OPEN
      this.consecutiveSuccesses = 0;
      this.transitionTo("OPEN");
      return;
    }

    if (this.state === "CLOSED") {
      const now = Date.now();
      this.failureTimestamps.push(now);
      this.pruneOldFailures();
      if (this.failureTimestamps.length >= this.options.failureThreshold) {
        this.transitionTo("OPEN");
      }
    }
  }

  /** Resets the breaker to its initial CLOSED state. Intended for tests only. */
  reset(): void {
    this.state = "CLOSED";
    this.failureTimestamps = [];
    this.consecutiveSuccesses = 0;
    this.openedAt = null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private transitionTo(next: CircuitState): void {
    const previous = this.state;
    this.state = next;

    if (next === "OPEN") {
      this.openedAt = Date.now();
      this.consecutiveSuccesses = 0;
      // Keep failure timestamps intact so diagnostics can inspect them
      if (previous === "CLOSED") {
        console.warn(
          `[starknet] Circuit breaker OPENED for ${this.endpointUrl} ` +
            `(${this.failureTimestamps.length} failures in window)`,
        );
      } else {
        console.warn(
          `[starknet] Circuit breaker re-OPENED for ${this.endpointUrl} ` +
            `(probe call failed during HALF_OPEN)`,
        );
      }
    } else if (next === "HALF_OPEN") {
      console.info(`[starknet] Circuit breaker HALF-OPEN for ${this.endpointUrl} — sending probe`);
    } else if (next === "CLOSED") {
      this.failureTimestamps = [];
      this.openedAt = null;
      this.consecutiveSuccesses = 0;
      console.info(`[starknet] Circuit breaker CLOSED for ${this.endpointUrl} — endpoint healthy`);
    }
  }

  private pruneOldFailures(): void {
    const cutoff = Date.now() - this.options.windowMs;
    this.failureTimestamps = this.failureTimestamps.filter((ts) => ts > cutoff);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics helpers
// ---------------------------------------------------------------------------

/**
 * A snapshot of circuit breaker state for one endpoint, safe to serialize
 * and include in diagnostics responses.
 */
export interface CircuitBreakerSnapshot {
  endpointUrl: string;
  state: CircuitState;
  recentFailureCount: number;
  openedAt: number | null;
}

/**
 * Returns a read-only snapshot of the circuit breaker state for the given
 * breaker.  This is deliberately a pure function over publicly-observable
 * fields so it can be called safely from diagnostics routes.
 */
export function snapshotCircuitBreaker(breaker: EndpointCircuitBreaker): CircuitBreakerSnapshot {
  return {
    endpointUrl: breaker.endpointUrl,
    state: breaker.currentState,
    recentFailureCount: breaker.recentFailureCount,
    openedAt: breaker.openedAtMs,
  };
}

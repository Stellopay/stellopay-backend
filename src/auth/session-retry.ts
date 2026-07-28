/**
 * Bounded retry helper for idempotent session DB writes.
 *
 * `withBoundedRetry` runs an async operation up to `maxAttempts` times,
 * pausing `delayMs` between attempts. It is intended ONLY for writes that
 * are known to be idempotent at the SQL level (e.g. `UPDATE … SET revokedAt
 * = now()` applied to the same row twice produces the same final state).
 * It is NOT a general-purpose HTTP retry wrapper.
 *
 * Failure semantics (used by `src/auth/session.ts`):
 *
 *   - On every retry except the last, an `onRetry(attempt, error)` callback
 *     is fired so the caller can emit a warn log and bump a counter.
 *   - On the final attempt, the underlying error is rethrown so the caller
 *     can surface it (the auth route will turn it into a 5xx response and
 *     the sweeper will keep marking itself healthy on a separate code path).
 *   - `isRetryable(error)` decides whether to attempt a retry at all. The
 *     default policy treats anything that isn't an obvious deterministic
 *     constraint / permission violation as retryable.
 *
 * NOTE: `createSession` (insert) and `rotateSession` (insert-then-update)
 * are intentionally NOT wrapped. Their success-on-retry would either leave
 * duplicate rows or orphan the original session. Decided failure modes:
 * throw on first DB error, no retry.
 */
export type RetryPolicy = {
  maxAttempts: number;
  delayMs: number;
  isRetryable: (error: unknown) => boolean;
};

const NON_RETRYABLE_HINTS = ["unique", "constraint", "permission"] as const;

const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 3,
  delayMs: 50,
  isRetryable: (error) => {
    if (!(error instanceof Error)) return true;
    const msg = error.message.toLowerCase();
    return !NON_RETRYABLE_HINTS.some((hint) => msg.includes(hint));
  },
};

export type RetryAttemptInfo = {
  attempt: number;
  maxAttempts: number;
  error: unknown;
  delayMs: number;
};

/**
 * Run `op` up to `maxAttempts` times. Returns the eventual value of the
 * last successful call, or rethrows the last error if every attempt fails.
 *
 * `policy` is merged on top of {@link DEFAULT_POLICY} — pass any subset.
 *
 * `onRetry` is invoked once BETWEEN attempts (so it fires maxAttempts-1
 * times per `op` call). It receives the attempt number that just failed
 * (1-indexed) and gives callers a single hook to emit a structured retry
 * log + bump a counter.
 */
export async function withBoundedRetry<T>(
  op: () => Promise<T>,
  policy: Partial<RetryPolicy> = {},
  onRetry?: (info: RetryAttemptInfo) => void,
): Promise<T> {
  const merged: RetryPolicy = { ...DEFAULT_POLICY, ...policy };
  let lastError: unknown;

  for (let attempt = 1; attempt <= merged.maxAttempts; attempt++) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      const isFinal = attempt === merged.maxAttempts;
      if (isFinal || !merged.isRetryable(error)) {
        throw error;
      }
      if (onRetry) {
        onRetry({
          attempt,
          maxAttempts: merged.maxAttempts,
          error,
          delayMs: merged.delayMs,
        });
      }
      if (merged.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, merged.delayMs));
      }
    }
  }
  // Unreachable: the for-loop either returns or throws. Add this to keep
  // TypeScript's control-flow analysis happy under `strict`.
  throw lastError;
}

import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { env } from "../config.js";

// ---------------------------------------------------------------------------
// PII / sensitive query-param redaction
// ---------------------------------------------------------------------------

const REDACTED_PARAM_NAMES = new Set([
  "token",
  "access_token",
  "auth",
  "authorization",
  "secret",
  "password",
  "api_key",
  "apikey",
  "key",
  "signature",
  "sig",
  "private_key",
  "wallet",
  "address",
  "account",
]);

const REDACTED = "[redacted]";

/**
 * Redact sensitive query-parameter values from a URL string before it is
 * written to the log.
 *
 * - Any param whose name matches {@link REDACTED_PARAM_NAMES}
 *   (case-insensitive) has its value replaced with `"[redacted]"`.
 * - Non-matching params pass through unchanged.
 * - URLs with no query string are returned as-is (fast path).
 * - Malformed URLs that cannot be parsed return the path portion only
 *   (everything before `?`) so the function never throws and never leaks data.
 */
export function redactSensitiveParams(rawUrl: string): string {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return rawUrl;

  let parsed: URL;
  try {
    // URL() requires an absolute form — dummy base lets relative paths work.
    parsed = new URL(rawUrl, "http://localhost");
  } catch {
    // Malformed: emit only the path to avoid leaking anything.
    return rawUrl.slice(0, qIndex);
  }

  let modified = false;
  for (const [key] of parsed.searchParams) {
    if (REDACTED_PARAM_NAMES.has(key.toLowerCase())) {
      parsed.searchParams.set(key, REDACTED);
      modified = true;
    }
  }

  if (!modified) return rawUrl;

  // URLSearchParams encodes brackets as %5B / %5D.
  // Decode them back so the log entry remains human-readable.
  return (
    parsed.pathname +
    "?" +
    parsed.searchParams
      .toString()
      .replace(/%5B/gi, "[")
      .replace(/%5D/gi, "]")
  );
}

// ---------------------------------------------------------------------------
// Idempotency — duplicate-request tracking
// ---------------------------------------------------------------------------

/**
 * Maximum number of recently-seen request IDs to retain in the deduplication
 * set. When the set exceeds this size the oldest half is evicted to bound
 * memory usage regardless of TTL.
 */
const MAX_SEEN_IDS = 10_000;

/**
 * Time-to-live (ms) for a deduplication entry. Request IDs older than this
 * are considered expired and eligible for garbage collection.
 *
 * Default 60 s — longer than a typical HTTP timeout + retry window, short
 * enough that the set does not grow unbounded under steady traffic.
 */
const SEEN_ID_TTL_MS = 60_000;

/**
 * In-process set of recently-seen request IDs for idempotency.
 *
 * Retries or duplicate delivery of the same request (same correlation ID)
 * must not produce duplicate log lines. This bounded, TTL-based set records
 * every request ID the first time it is observed and silently skips the
 * access-log emission when the same ID is seen again within the TTL window.
 *
 * Design constraints
 * ------------------
 * - **Bounded memory**: the set is capped at {@link MAX_SEEN_IDS} entries.
 *   When the cap is exceeded the oldest half of entries is evicted before
 *   inserting the new one.
 * - **TTL-aware lookup**: stale entries are detected on lookup via the
 *   per-entry timestamp — no timer, no background sweeps. Expired entries
 *   are treated as "new" and re-recorded.
 * - **Process-local**: deduplication does not survive a restart. This is
 *   intentional — the set is a best-effort guard, not a durability guarantee.
 *   A process restart creates a fresh log stream where duplicates are
 *   harmless (the old process's logs are distinct).
 * - **Not shared across instances**: each process maintains its own set.
 *   Horizon-scaling deployments should handle cross-instance dedup at the
 *   log-aggregation layer.
 */
class SeenRequestIds {
  /** Map of request ID → insertion time (Date.now() ms). Insertion order is preserved. */
  private _ids = new Map<string, number>();

  /**
   * Test whether `id` is new and should be logged.
   *
   * Returns `true` when the ID has never been seen or has expired.
   * Returns `false` when the ID is still fresh — the caller should skip
   * emitting a log line for this request.
   *
   * Side effect: records `id` with the current timestamp on first sighting.
   * When the map hits its size cap the oldest half is evicted — a single
   * O(n) compaction that keeps the hot path O(1) under normal load.
   */
  isNew(id: string): boolean {
    const now = Date.now();
    const existing = this._ids.get(id);

    if (existing !== undefined && now - existing < SEEN_ID_TTL_MS) {
      // Still fresh — duplicate.
      return false;
    }

    // Bounded-memory safety: evict the oldest half when the map is full.
    // This is the only eviction path — no per-insert full scan.
    if (this._ids.size >= MAX_SEEN_IDS) {
      let count = 0;
      const toRemove = Math.ceil(this._ids.size / 2);
      for (const key of this._ids.keys()) {
        if (count >= toRemove) break;
        this._ids.delete(key);
        count++;
      }
    }

    this._ids.set(id, now);
    return true;
  }

  /** Number of entries in the dedup set. Visible for tests. */
  get size(): number {
    return this._ids.size;
  }

  /** Remove all tracked IDs. Visible for tests. */
  reset(): void {
    this._ids.clear();
  }
}

/** Singleton deduplication store. Exported for test visibility. */
export const seenRequestIds = new SeenRequestIds();

// ---------------------------------------------------------------------------
// Log-entry shape
// ---------------------------------------------------------------------------

/** The structured object written to stdout for every logged request. */
export interface AccessLogEntry {
  timestamp: string;
  level: "info";
  method: string;
  /** URL with sensitive query-parameter values replaced by `[redacted]`. */
  path: string;
  status: number;
  duration_ms: number;
  request_id: string;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Structured access-log middleware.
 *
 * Behaviour
 * ---------
 * - Skips `/health` to avoid log noise from liveness probes.
 * - Reads the correlation ID from `res.locals.requestId` (set by
 *   {@link requestIdMiddleware}). Falls back to a `crypto.randomUUID()` when
 *   that middleware is not mounted, so every log line always carries a valid ID.
 * - **Idempotency**: the same request ID is only logged once within the
 *   deduplication window (60 s). Retries or accidental duplicate delivery
 *   with the same correlation ID produce at most one log line. See
 *   {@link SeenRequestIds} for the dedup contract.
 * - Redacts sensitive query-parameter values via {@link redactSensitiveParams}
 *   before writing to the log — wallet addresses, tokens, passwords, etc.
 * - Emits one log line per request on the `res.finish` event, after the status
 *   code and duration are both known.
 * - Never logs request/response bodies, `Authorization` headers, or any other
 *   header — only the fields in {@link AccessLogEntry}.
 * - All logic inside the `finish` handler is wrapped in `try/catch`. A logging
 *   failure is reported via `console.error` and never re-thrown, so it cannot
 *   crash the process or affect the HTTP response.
 *
 * Log formats
 * -----------
 * Controlled by `LOG_FORMAT` (default `"json"`):
 * - `"json"` — `JSON.stringify(entry)` on one line; machine-parseable.
 * - anything else — human-readable:
 *   `[<timestamp>] INFO <method> <path> <status> <duration>ms [<request_id>]`
 */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip noisy /health liveness-probe requests.
  if (req.path === "/health") {
    return next();
  }

  // Snapshot the correlation ID now.
  // Falls back to a fresh UUID when requestIdMiddleware is not mounted.
  const snapshotId: string =
    typeof res.locals.requestId === "string" && res.locals.requestId.length > 0
      ? res.locals.requestId
      : crypto.randomUUID();

  const startHrTime = process.hrtime.bigint();

  res.on("finish", () => {
    try {
      // Prefer the live value (requestIdMiddleware may have run after us),
      // but keep the snapshot as the guaranteed-valid fallback.
      const requestId: string =
        typeof res.locals.requestId === "string" && res.locals.requestId.length > 0
          ? res.locals.requestId
          : snapshotId;

      // Idempotency guard: skip when the same request ID was recently logged.
      if (!seenRequestIds.isNew(requestId)) {
        return;
      }

      const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1_000_000;

      const entry: AccessLogEntry = {
        timestamp: new Date().toISOString(),
        level: "info",
        method: req.method,
        path: redactSensitiveParams(req.originalUrl || req.path),
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        request_id: requestId,
      };

      if (env.LOG_FORMAT === "json") {
        // eslint-disable-next-line no-console
        console.info(JSON.stringify(entry));
      } else {
        // eslint-disable-next-line no-console
        console.info(
          `[${entry.timestamp}] INFO ${entry.method} ${entry.path} ${entry.status} ${entry.duration_ms}ms [${entry.request_id}]`,
        );
      }
    } catch (err) {
      // A logging failure must never affect the caller.
      // eslint-disable-next-line no-console
      console.error("[access-log] failed to emit log entry", err);
    }
  });

  next();
}

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

/** The replacement value written into the log for redacted param values. */
export const REDACTED_VALUE = "[redacted]";

/**
 * Redact sensitive query-parameter values from a URL string before it is
 * written to the log.
 *
 * Contract
 * --------
 * - Any param whose name matches {@link REDACTED_PARAM_NAMES}
 *   (case-insensitive) has its value replaced with `"[redacted]"`.
 * - Non-matching params pass through unchanged.
 * - URLs with no query string (`?` absent) are returned as-is (fast path).
 * - Malformed URLs that cannot be parsed return the path portion only
 *   (everything before `?`) so the function **never throws** and
 *   **never leaks data**.
 * - The return value is always a `string`; it is safe to embed directly in
 *   a log entry.
 *
 * Batching / pagination note
 * --------------------------
 * This function is **pure and stateless** — it processes exactly one URL
 * string per call with no internal queue or buffer. Each call to
 * {@link accessLogMiddleware} invokes it once on `res.finish`, so one HTTP
 * request produces exactly one redacted log line.
 */
export function redactSensitiveParams(rawUrl: string): string {
  // Guard against null/undefined/missing input — never throw, never leak data.
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return "";

  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return rawUrl;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl, "http://localhost");
  } catch {
    return rawUrl.slice(0, qIndex);
  }

  let modified = false;
  for (const [key] of parsed.searchParams) {
    if (REDACTED_PARAM_NAMES.has(key.toLowerCase())) {
      parsed.searchParams.set(key, REDACTED_VALUE);
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
// Idempotency
// ---------------------------------------------------------------------------

/** Maximum number of entries the deduplication cache may hold.  Beyond this
 *  limit new entries are refused silently — the request is still logged — so
 *  an attacker cannot exhaust memory by sending unique IDs. */
export const MAX_CACHE_SIZE = 10_000;

/**
 * A bounded deduplication cache to prevent logging the same request ID more
 * than once within a 60-second window.
 *
 * Security contract
 * -----------------
 * - The cache has a hard upper bound ({@link MAX_CACHE_SIZE}).  Once full,
 *   `add()` returns `true` (log it) for new IDs without inserting them, so a
 *   flood of unique IDs cannot cause an OOM.
 * - Entries auto-expire after 60 s via `setTimeout(…).unref()`, keeping the
 *   timer from blocking process exit.
 * - The cache operates on the already-validated request ID (see
 *   {@link validateCorrelationId}), so malformed or overlong IDs never reach
 *   this layer.
 */
export const seenRequestIds = {
  cache: new Set<string>(),
  add(id: string): boolean {
    if (this.cache.has(id)) {
      return false; // Already seen
    }
    if (this.cache.size >= MAX_CACHE_SIZE) {
      // Cache is at capacity — log the request rather than silently dropping
      // it, but do not insert into the full cache.
      return true;
    }
    this.cache.add(id);
    setTimeout(() => this.cache.delete(id), 60_000).unref();
    return true;
  },
  reset(): void {
    this.cache.clear();
  }
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface AccessLogMetrics {
  totalRequests: number;
  requestsByStatus: Record<number, number>;
  requestsByPath: Record<string, number>;
  totalDurationMs: number;
}

let metrics: AccessLogMetrics = {
  totalRequests: 0,
  requestsByStatus: {},
  requestsByPath: {},
  totalDurationMs: 0,
};

/** Return a snapshot of the current metrics counters. */
export function getMetrics(): Readonly<AccessLogMetrics> {
  return { ...metrics, requestsByStatus: { ...metrics.requestsByStatus }, requestsByPath: { ...metrics.requestsByPath } };
}

/** Reset all metrics counters (for use in tests). */
export function resetMetrics(): void {
  metrics = { totalRequests: 0, requestsByStatus: {}, requestsByPath: {}, totalDurationMs: 0 };
  resetDurationHistogram();
}

// ---------------------------------------------------------------------------
// Duration histogram
// ---------------------------------------------------------------------------

/**
 * A single bucket in the `http_request_duration_seconds` histogram,
 * keyed by `method` × `route` × `statusClass`.
 */
export interface DurationHistogramBucket {
  /** HTTP method, e.g. GET / POST. */
  method: string;
  /** Normalised route pattern (from `req.route?.path ?? req.path`). */
  route: string;
  /** Status-code class: `1xx`, `2xx`, `3xx`, `4xx`, or `5xx`. */
  statusClass: string;
  /** Total observations in this bucket. */
  count: number;
  /** Cumulative duration in seconds. */
  sumSeconds: number;
  /** Shortest observed duration in this bucket (seconds). */
  minSeconds: number;
  /** Longest observed duration in this bucket (seconds). */
  maxSeconds: number;
}

let durationHistogram: Map<string, DurationHistogramBucket> = new Map();

function statusClass(status: number): string {
  if (status < 200) return "1xx";
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return "4xx";
  return "5xx";
}

function histogramKey(method: string, route: string, sc: string): string {
  return `${method}:${route}:${sc}`;
}

function recordDuration(method: string, route: string, status: number, durationSeconds: number): void {
  const sc = statusClass(status);
  const key = histogramKey(method, route, sc);
  let bucket = durationHistogram.get(key);
  if (!bucket) {
    bucket = {
      method,
      route,
      statusClass: sc,
      count: 0,
      sumSeconds: 0,
      minSeconds: Infinity,
      maxSeconds: -Infinity,
    };
    durationHistogram.set(key, bucket);
  }
  bucket.count += 1;
  bucket.sumSeconds += durationSeconds;
  if (durationSeconds < bucket.minSeconds) bucket.minSeconds = durationSeconds;
  if (durationSeconds > bucket.maxSeconds) bucket.maxSeconds = durationSeconds;
}

/**
 * Return a snapshot of the current duration histogram, sorted by
 * method → route → statusClass for stable output.
 */
export function getDurationHistogram(): DurationHistogramBucket[] {
  return Array.from(durationHistogram.values())
    .map((b) => ({ ...b }))
    .sort((a, b) => {
      const byMethod = a.method.localeCompare(b.method);
      if (byMethod !== 0) return byMethod;
      const byRoute = a.route.localeCompare(b.route);
      if (byRoute !== 0) return byRoute;
      return a.statusClass.localeCompare(b.statusClass);
    });
}

/** Clear all histogram data (for use in tests). */
export function resetDurationHistogram(): void {
  durationHistogram.clear();
}

// ---------------------------------------------------------------------------
// Log-entry shape
// ---------------------------------------------------------------------------

/** The structured object written to stdout for every logged request. */
export interface AccessLogEntry {
  timestamp: string;
  level: "info";
  method: string;
  /** URL with sensitive query-parameter values replaced by `"[redacted]"`. */
  path: string;
  status: number;
  /** Wall-clock milliseconds from middleware mount to `res.finish`, 2 dp. */
  duration_ms: number;
  request_id: string;
  /** Content-Length of the response body, if set. */
  content_length?: number;
}

// ---------------------------------------------------------------------------
// Correlation-ID validation
// ---------------------------------------------------------------------------

/**
 * UUID v4 regex used to validate externally-supplied correlation IDs before
 * they are trusted for deduplication and log-line attribution.
 *
 * Only IDs matching this pattern are accepted; anything else is silently
 * replaced with a fresh `crypto.randomUUID()`.  This prevents an attacker
 * from injecting long strings (memory pressure in the dedup cache), control
 * characters (log-line forgery), or crafted values that could confuse
 * downstream log processors.
 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate a correlation ID string from `res.locals.requestId`.
 *
 * Returns the input unchanged when it is a valid UUID v4 string.  Returns
 * `null` for any other value — empty strings, non-strings, overlong
 * payloads, or otherwise malformed IDs — so the caller can fall back to a
 * generated UUID.
 *
 * This is the single validation gate every externally-supplied correlation ID
 * must pass before it is written into a log entry or inserted into the
 * deduplication cache.
 */
export function validateCorrelationId(id: unknown): string | null {
  if (typeof id !== "string" || id.length === 0 || id.length > 36) {
    return null;
  }
  return UUID_V4_PATTERN.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Structured access-log middleware.
 *
 * Behaviour
 * ---------
 * - Skips `/health` and `/ready` to avoid log noise from liveness probes.
 * - Reads the correlation ID from `res.locals.requestId` (set by
 *   {@link requestIdMiddleware}), validates it via
 *   {@link validateCorrelationId}, and falls back to `crypto.randomUUID()`
 *   when validation fails or the middleware is not mounted.  This gate
 *   ensures that only well-formed UUIDs enter the dedup cache and log
 *   stream — non-UUID or overlong values never leak in.
 * - **Idempotency**: the same request ID is only logged once within the
 *   deduplication window (60 s). Retries or accidental duplicate delivery
 *   with the same correlation ID produce at most one log line. See
 *   {@link seenRequestIds} for the dedup contract.
 * - Redacts sensitive query-parameter values via {@link redactSensitiveParams}
 *   before writing to the log — wallet addresses, tokens, passwords, etc.
 * - Emits **exactly one log line per request** on the `res.finish` event,
 *   after the status code and duration are both known.
 * - Never logs request/response bodies, `Authorization` headers, or any
 *   other header — only the fields in {@link AccessLogEntry}.
 * - Records the per-request duration into the
 *   {@link DurationHistogramBucket} histogram, labelled by method, normalised
 *   route, and status-code class, for aggregate latency queries
 *   (p50/p95/p99).
 *
 * Security boundary
 * -----------------
 * This middleware enforces the following security guarantees:
 *
 * 1. **No header logging**: The `Authorization`, `Cookie`, `Set-Cookie`,
 *    `X-API-Key`, and `X-Auth-Token` headers are **never** written to the
 *    log. Only the whitelisted fields in {@link AccessLogEntry} are emitted.
 * 2. **No body logging**: Request and response bodies are never read or
 *    logged by this middleware.
 * 3. **PII redaction**: Sensitive query-parameter values are redacted via
 *    {@link redactSensitiveParams} — wallet addresses, tokens, passwords, etc.
 * 4. **Safe fallback on malformed URLs**: {@link redactSensitiveParams}
 *    never throws on malformed input and returns only the path portion
 *    when parsing fails, preventing information leakage.
 * 5. **Graceful failure**: A `try/catch` around the entire finish handler
 *    ensures that a logging failure never crashes the process or affects
 *    the HTTP response. Errors are reported via `console.error`.
 * 6. **Audit trail**: The `request_id` field is always a valid,
 *    non-empty string — either the client-supplied correlation ID or a
 *    `crypto.randomUUID()` fallback — so every log line is traceable.
 * - All logic inside the `finish` handler is wrapped in `try/catch`. A
 *   logging failure is reported via `console.error` and **never re-thrown**,
 *   so it cannot crash the process or affect the HTTP response.
 *
 * Authorization / security boundary
 * ----------------------------------
 * The path-skip list (`/health`, `/ready`) is the sole authorization gate.
 * If a path should never appear in the access log (e.g. a future token
 * introspection endpoint) it must be added here.  The skip decision happens
 * before the request ID is read from `res.locals`, so endpoints excluded from
 * logging are also excluded from deduplication and metrics.
 *
 * Correlation-ID validation (see {@link validateCorrelationId}) is the
 * secondary security boundary: only UUID-formatted IDs flow into the dedup
 * cache and log stream.  A non-conforming value is silently replaced with a
 * freshly-generated UUID, so an attacker gains nothing by sending a crafted
 * `x-request-id` header.
 *
 * Batching / pagination contract
 * --------------------------------
 * The middleware registers **one** `finish` listener per request. There is
 * no internal buffer, queue, or batch accumulation. Each HTTP request
 * produces exactly one {@link AccessLogEntry} when the response finishes.
 * Concurrent requests each get their own independent listener and their own
 * log line — they do not interfere with each other.
 *
 * Log formats
 * -----------
 * Controlled by `LOG_FORMAT` (default `"json"`):
 * - `"json"` — `JSON.stringify(entry)` on one line; machine-parseable.
 * - anything else — human-readable:
 *   `[<timestamp>] INFO <method> <path> <status> <duration>ms [<request_id>]`
 */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health" || req.path === "/ready") {
    return next();
  }

  const externalId = validateCorrelationId(res.locals.requestId);
  const snapshotId: string = externalId ?? crypto.randomUUID();

  const startHrTime = process.hrtime.bigint();

  res.on("finish", () => {
    try {
      const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1_000_000;

      const requestId: string =
        validateCorrelationId(res.locals.requestId) ?? snapshotId;

      if (!seenRequestIds.add(requestId)) {
        return;
      }

      metrics.totalRequests += 1;
      metrics.requestsByStatus[res.statusCode] = (metrics.requestsByStatus[res.statusCode] ?? 0) + 1;
      const pathKey = req.route?.path ?? req.path;
      metrics.requestsByPath[pathKey] = (metrics.requestsByPath[pathKey] ?? 0) + 1;
      metrics.totalDurationMs += durationMs;

      // Record duration into the labelled histogram for aggregate queries.
      const durationSeconds = durationMs / 1000;
      recordDuration(req.method, pathKey, res.statusCode, durationSeconds);

      const contentLength =
        typeof res.getHeader === "function"
          ? res.getHeader("content-length")
          : undefined;

      const entry: AccessLogEntry = {
        timestamp: new Date().toISOString(),
        level: "info",
        method: req.method,
        path: redactSensitiveParams(req.originalUrl || req.path),
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        request_id: requestId,
      };

      if (contentLength !== undefined) {
        entry.content_length = Number(contentLength);
      }

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
      // eslint-disable-next-line no-console
      console.error("[access-log] failed to emit log entry", err);
    }
  });

  next();
}

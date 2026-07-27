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
    parsed = new URL(rawUrl, "http://localhost");
  } catch {
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

  return parsed.pathname + "?" + parsed.searchParams.toString();
}

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
}

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
  /** Content-Length of the response body, if set. */
  content_length?: number;
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
  if (req.path === "/health") {
    return next();
  }

  const snapshotId: string =
    typeof res.locals.requestId === "string" && res.locals.requestId.length > 0
      ? res.locals.requestId
      : crypto.randomUUID();

  const startHrTime = process.hrtime.bigint();

  res.on("finish", () => {
    try {
      const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1_000_000;

      const requestId: string =
        typeof res.locals.requestId === "string" && res.locals.requestId.length > 0
          ? res.locals.requestId
          : snapshotId;

      metrics.totalRequests += 1;
      metrics.requestsByStatus[res.statusCode] = (metrics.requestsByStatus[res.statusCode] ?? 0) + 1;
      const pathKey = req.route?.path ?? req.path;
      metrics.requestsByPath[pathKey] = (metrics.requestsByPath[pathKey] ?? 0) + 1;
      metrics.totalDurationMs += durationMs;

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
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
      parsed.searchParams.set(key, REDACTED_VALUE);
      modified = true;
    }
  }

  if (!modified) return rawUrl;

  return parsed.pathname + "?" + parsed.searchParams.toString();
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
 *   that middleware is not mounted, so **every log line always carries a
 *   valid ID — the string `"unknown"` is never emitted**.
 * - Redacts sensitive query-parameter values via {@link redactSensitiveParams}
 *   before writing to the log — wallet addresses, tokens, passwords, etc.
 * - Emits **exactly one log line per request** on the `res.finish` event,
 *   after the status code and duration are both known.
 * - Never logs request/response bodies, `Authorization` headers, or any
 *   other header — only the fields in {@link AccessLogEntry}.
 * - All logic inside the `finish` handler is wrapped in `try/catch`. A
 *   logging failure is reported via `console.error` and **never re-thrown**,
 *   so it cannot crash the process or affect the HTTP response.
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
      const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1_000_000;

      // Prefer the live value (requestIdMiddleware may have run after us),
      // but keep the snapshot as the guaranteed-valid fallback.
      const requestId: string =
        typeof res.locals.requestId === "string" && res.locals.requestId.length > 0
          ? res.locals.requestId
          : snapshotId;

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

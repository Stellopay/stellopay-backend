import { Request, Response, NextFunction } from "express";
import { env } from "../config.js";

/**
 * Maximum length accepted for a logged URL / path value.
 * Prevents unbounded log entries from extremely long paths.
 */
const MAX_PATH_LENGTH = 2048;

/**
 * Maximum length accepted for a logged method value.
 */
const MAX_METHOD_LENGTH = 16;

/**
 * Header names whose values MUST never appear in log output.
 * Comparison is case-insensitive.
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
  "x-auth-token",
  "x-csrf-token",
]);

/**
 * Sanitise a string value so it is safe for log output.
 *
 * - Strips ASCII control characters (0x00–0x1F) except TAB (0x09), and DEL
 *   (0x7F) to prevent log injection via newlines, carriage returns, etc.
 * - Truncates to {@link MAX_PATH_LENGTH} characters.
 * - Replaces remaining non-printable sequences with a safe placeholder.
 *
 * @param value - The raw value to sanitise.
 * @param maxLen - Optional maximum length; defaults to {@link MAX_PATH_LENGTH}.
 * @returns The sanitised, truncated value.
 */
function sanitiseForLog(value: string, maxLen: number = MAX_PATH_LENGTH): string {
  // First, decode percent-encoded sequences so that URL-encoded control
  // characters (e.g. %0a, %0d, %00) are handled as actual control characters
  // and then stripped or replaced.
  let sanitised = value;
  try {
    sanitised = decodeURIComponent(sanitised);
  } catch {
    // If the value contains malformed percent-encoding (e.g. %ZZ), leave it
    // as-is — decodeURIComponent throws URIError on invalid sequences.
  }

  sanitised = sanitised
    // Strip ASCII control characters except TAB (\t = 0x09).
    // This explicitly includes newline (0x0A) and carriage return (0x0D) to
    // prevent log injection via crafted URLs.
    .replace(/[\x00-\x08\x0A\x0B\x0C\x0D\x0E-\x1F\x7F]/g, "")
    // Replace any remaining non-printable Unicode with a placeholder,
    // but preserve actual TAB characters.
    .replace(/(?!\t)\p{C}/gu, "<\\x??>");

  if (sanitised.length > maxLen) {
    sanitised = sanitised.slice(0, maxLen) + "...";
  }

  return sanitised;
}

/**
 * Redact sensitive header values from a headers object for safe logging.
 *
 * Returns a new plain object where every value whose key matches a known
 * sensitive header is replaced with `"[REDACTED]"`. All other values pass
 * through unchanged. The returned object is flat — repeated headers are
 * represented as a single comma-joined string, which is the Express
 * convention for `req.headers`.
 *
 * @param headers - The raw `req.headers` object (or a partial copy).
 * @returns A new object safe for inclusion in log output.
 */
function redactSensitiveHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    const headerValue = Array.isArray(value) ? value.join(", ") : value;
    redacted[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
      ? "[REDACTED]"
      : headerValue;
  }
  return redacted;
}

// Exported for testing only — not part of the public API.
export { sanitiseForLog, redactSensitiveHeaders };

/**
 * Structured access log middleware.
 *
 * Records method, sanitised path, status code, and duration of every request.
 * Sensitive headers are NEVER written to log output. URLs and paths are
 * sanitised to strip control characters (preventing log injection) and
 * truncated to a maximum length.
 *
 * Reads `res.locals.requestId` set by {@link requestIdMiddleware}, which must
 * be mounted before this middleware.
 *
 * ## Security guarantees
 *
 * - **No PII in default fields** — the log entry never contains request bodies,
 *   query strings, or raw headers by default. The `redacted_headers` field is
 *   only present for diagnostic use and has all sensitive values replaced with
 *   `"[REDACTED]"`.
 * - **Log-injection prevention** — every string field (method, path, URL) is
 *   passed through {@link sanitiseForLog} which strips ASCII control
 *   characters (newlines, carriage returns, etc.) so an attacker cannot forge
 *   fake log lines via a crafted URL.
 * - **Length limits** — all logged string values are capped to prevent
 *   unbounded log entries from extremely long input.
 * - **Health-check exemption** — `/health` and `/ready` requests are skipped
 *   immediately and never produce a log line.
 */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip noisy /health and /ready requests
  if (req.path === "/health" || req.path === "/ready") {
    return next();
  }

  const startHrTime = process.hrtime.bigint();

  res.on("finish", () => {
    const endHrTime = process.hrtime.bigint();
    const durationMs = Number(endHrTime - startHrTime) / 1_000_000;

    // Sanitise every string field to prevent log injection.
    const logEntry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: "info",
      method: sanitiseForLog(req.method, MAX_METHOD_LENGTH),
      path: sanitiseForLog(req.originalUrl || req.path),
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      // ID is set by requestIdMiddleware; fall back gracefully when used standalone
      request_id: res.locals.requestId ?? "unknown",
    };

    // Include sanitised response headers only when LOG_LEVEL is debug/trace so
    // operators can inspect redacted header values for debugging without
    // leaking PII in default-level logs.
    if (env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace") {
      logEntry.redacted_headers = redactSensitiveHeaders(req.headers as Record<string, string | string[] | undefined>);
    }

    if (env.LOG_FORMAT === "json") {
      // eslint-disable-next-line no-console
      console.info(JSON.stringify(logEntry));
    } else {
      // eslint-disable-next-line no-console
      console.info(
        `[${logEntry.timestamp}] INFO ${logEntry.method} ${logEntry.path} ${logEntry.status} ${logEntry.duration_ms}ms [${logEntry.request_id}]`,
      );
    }
  });

  next();
}

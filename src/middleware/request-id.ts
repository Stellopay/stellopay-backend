import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

/** Maximum length accepted for a client-supplied X-Request-Id value. */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Sanitise a client-supplied request ID.
 *
 * Allows only printable ASCII characters (0x20–0x7E) excluding control
 * characters, newlines and carriage returns so the value cannot be used for
 * log injection or HTTP response-header smuggling.
 *
 * Returns `null` when the value is absent, empty, overlong, or contains
 * disallowed characters, causing the middleware to generate a fresh UUID.
 */
function sanitiseClientId(raw: string | undefined): string | null {
  if (!raw || raw.length === 0) return null;
  if (raw.length > MAX_REQUEST_ID_LENGTH) return null;
  // Only printable ASCII — no control chars, no CR/LF
  if (!/^[\x20-\x7E]+$/.test(raw)) return null;
  return raw;
}

/**
 * Request-ID correlation middleware.
 *
 * - Reads an incoming `X-Request-Id` header; validates and sanitises it.
 * - Falls back to a `crypto.randomUUID()` when the header is absent or invalid.
 * - Stores the final ID on `res.locals.requestId` for downstream use.
 * - Echoes the ID back on the `X-Request-Id` response header so clients can
 *   correlate their own logs with server-side log lines.
 *
 * Security guarantees
 * -------------------
 * - Client-supplied IDs are length-capped at {@link MAX_REQUEST_ID_LENGTH}
 *   characters and restricted to printable ASCII to prevent log injection and
 *   header smuggling.
 * - Rejected IDs are silently replaced with a server-generated UUID; the
 *   client is never told why (no information leakage).
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const clientId = sanitiseClientId(req.headers["x-request-id"] as string | undefined);
  const requestId = clientId ?? crypto.randomUUID();

  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  next();
}

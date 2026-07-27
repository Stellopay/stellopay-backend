import { Request, Response, NextFunction } from "express";
import { env } from "../config.js";

/**
 * Redact sensitive query parameters from a URL string or path.
 */
function redactQueryParams(originalPath: string): string {
  try {
    // URL requires a base, dummy one is fine for parsing relative paths
    const url = new URL(originalPath, "http://localhost");
    let redacted = false;
    for (const [key, value] of url.searchParams.entries()) {
      if (env.LOG_REDACT_QUERY_PARAMS.includes(key.toLowerCase()) && value) {
        url.searchParams.set(key, "[REDACTED]");
        redacted = true;
      }
    }
    return redacted ? url.pathname + url.search : originalPath;
  } catch {
    return originalPath;
  }
}

/**
 * Structured access log middleware.
 * Records method, path, status code, and duration of requests.
 * Explicitly skips bodies and auth tokens for security.
 *
 * Reads `res.locals.requestId` set by {@link requestIdMiddleware}, which must
 * be mounted before this middleware.
 */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip noisy /health requests
  if (req.path === "/health") {
    return next();
  }

  // ID is set by requestIdMiddleware; fall back gracefully when used standalone
  const requestId: string = res.locals.requestId ?? "unknown";

  const startHrTime = process.hrtime.bigint();

  res.on("finish", () => {
    const endHrTime = process.hrtime.bigint();
    const durationMs = Number(endHrTime - startHrTime) / 1_000_000;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      method: req.method,
      path: redactQueryParams(req.originalUrl || req.path),
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      request_id: res.locals.requestId ?? requestId,
    };

    if (env.LOG_FORMAT === "json") {
      // The global logger override will handle JSON formatting and injecting request_id
      // eslint-disable-next-line no-console
      console.info({
        method: logEntry.method,
        path: logEntry.path,
        status: logEntry.status,
        duration_ms: logEntry.duration_ms,
      });
    } else {
      // eslint-disable-next-line no-console
      console.info(`${logEntry.method} ${logEntry.path} ${logEntry.status} ${logEntry.duration_ms}ms`);
    }
  });

  next();
}

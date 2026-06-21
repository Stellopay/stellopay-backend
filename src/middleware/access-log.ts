import { Request, Response, NextFunction } from "express";
import { env } from "../config.js";

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
      path: req.originalUrl || req.path,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      request_id: res.locals.requestId ?? requestId,
    };

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

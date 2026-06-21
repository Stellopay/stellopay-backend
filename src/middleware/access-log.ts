import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { env } from "../config.js";

declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

/**
 * Structured access log middleware.
 * Records method, path, status code, and duration of requests.
 * Explicitly skips bodies and auth tokens for security.
 */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip noisy /health requests
  if (req.path === "/health") {
    return next();
  }

  // Get existing request ID or generate a new one
  const requestId =
    (req.headers["x-request-id"] as string) ||
    (req.headers["x-correlation-id"] as string) ||
    crypto.randomUUID();

  // Attach for downstream use if needed
  req.id = requestId;

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
      request_id: requestId,
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

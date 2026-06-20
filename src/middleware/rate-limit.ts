import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response } from "express";

/**
 * Shared key generator for every rate limiter in the app.
 *
 * Keys requests by the resolved client IP. `req.ip` honours the Express
 * `trust proxy` setting configured in {@link ../index.ts}, so when the app
 * runs behind a known proxy (see `TRUST_PROXY`) the real client IP is taken
 * from `X-Forwarded-For`. When `trust proxy` is **not** set, `req.ip` is the
 * direct socket address and forwarded headers are ignored — this is what
 * prevents a client from spoofing the rate-limit key via a forged
 * `X-Forwarded-For` header.
 *
 * @param req - The incoming Express request.
 * @returns The client IP, or the string `"unknown"` when it cannot be resolved.
 */
export function keyByIp(req: Request): string {
  return req.ip || "unknown";
}

/**
 * Options accepted by {@link makeLimiter}.
 */
export interface MakeLimiterOptions {
  /** Length of the sliding window in milliseconds. */
  windowMs: number;
  /** Maximum number of requests permitted per window, per key. */
  max: number;
  /**
   * Human-readable name for the limiter. Used only for documentation and
   * debugging; it lets callers (and future shared-store backends) tell named
   * limiters apart (e.g. `"global"`, `"strict"`, `"admin"`).
   */
  name: string;
  /**
   * Message returned in the JSON 429 body and the `RateLimit`-style message.
   * Defaults to a generic throttling message.
   */
  message?: string;
  /**
   * Optional predicate to skip counting a request against the limit. Receives
   * the request and returns `true` to bypass the limiter (e.g. health checks).
   */
  skip?: (req: Request) => boolean;
}

/** Default message used when a caller does not supply one. */
const DEFAULT_MESSAGE = "Too many requests, please try again later.";

/**
 * Build a named, in-memory rate limiter with the app's shared key generator
 * and a JSON 429 handler consistent with the global error envelope
 * (`{ "error": string }`).
 *
 * Centralising limiter construction removes the duplicated
 * keyGenerator/handler/message wiring that previously lived inline, and gives
 * the app a single seam for per-route tuning and for swapping the backing
 * store.
 *
 * ## Store limitation
 *
 * This uses `express-rate-limit`'s **default in-memory store**. Counters live
 * in the process heap, which means:
 *
 *  - State is **not shared** across instances/replicas — each process enforces
 *    its own counts, so the effective limit scales with the number of
 *    instances behind a load balancer.
 *  - Counters **reset on restart/redeploy**, briefly relaxing enforcement.
 *
 * For multi-instance deployments, replace the store with a shared backend
 * (e.g. Redis via `rate-limit-redis`) by passing a `store` to `rateLimit`
 * below. The factory signature is intentionally the single place to wire that
 * up — see the `store` seam marked in the implementation.
 *
 * @param options - {@link MakeLimiterOptions} controlling window, max, name,
 *   message, and optional skip predicate.
 * @returns A configured Express {@link RateLimitRequestHandler} middleware.
 *
 * @example
 * ```ts
 * const adminLimiter = makeLimiter({
 *   name: "admin",
 *   windowMs: 60_000,
 *   max: 20,
 *   message: "Too many admin requests.",
 * });
 * app.use("/api/v1/admin", adminLimiter);
 * ```
 */
export function makeLimiter(options: MakeLimiterOptions): RateLimitRequestHandler {
  const { windowMs, max, message = DEFAULT_MESSAGE, skip } = options;

  return rateLimit({
    windowMs,
    max,
    message,
    // Disable legacy `X-RateLimit-*` headers; standard headers stay off too to
    // match the prior behaviour of the inline limiters.
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: keyByIp,
    ...(skip ? { skip } : {}),
    // ---- Shared-store seam --------------------------------------------------
    // To make limits consistent across instances, construct a shared store
    // (e.g. `new RedisStore({ sendCommand })`) and pass it here as `store`.
    // Leaving it unset uses the in-memory store documented above.
    // store: undefined,
    // -------------------------------------------------------------------------
    handler: (_req: Request, res: Response) => {
      res.status(429).json({ error: message });
    },
  });
}

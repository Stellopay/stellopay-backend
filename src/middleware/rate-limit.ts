import rateLimit, {
  type RateLimitRequestHandler,
  type Store,
  ipKeyGenerator,
} from "express-rate-limit";
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
 * When `req.ip` is unavailable (e.g. a misconfigured proxy chain), the key
 * falls back to `"unknown"`. All such requests share a single bucket, so a
 * misconfigured proxy can cause legitimate traffic to throttle each other.
 * The `console.warn` below makes this visible in logs so the operator can
 * correct the `trust proxy` setting.
 *
 * Inside `makeLimiter` this function is composed with `ipKeyGenerator` (from
 * `express-rate-limit`) which normalises IPv6 addresses — e.g. stripping the
 * `::ffff:` IPv4-mapped prefix — so IPv6 clients cannot bypass limits by
 * switching address representations.
 *
 * @param req - The incoming Express request.
 * @returns The client IP, or `"unknown"` when it cannot be resolved.
 */
export function keyByIp(req: Request): string {
  if (!req.ip) {
    console.warn(
      "[rate-limit] req.ip is undefined — all unresolved clients share the 'unknown' bucket. " +
        "Check your TRUST_PROXY setting.",
    );
    return "unknown";
  }
  // ipKeyGenerator normalises IPv6 addresses (e.g. strips the ::ffff: IPv4-mapped
  // prefix) so IPv6 clients cannot bypass limits by switching address representations.
  return ipKeyGenerator(req.ip);
}
/**
 * Computes the number of whole seconds until the current rate-limit window
 * resets, suitable for use as the `Retry-After` header value.
 *
 * Returns at least `1` to avoid sending `Retry-After: 0`, which some clients
 * interpret as "retry immediately".
 *
 * @param windowMs - The limiter's window length in milliseconds.
 * @returns Seconds until reset, clamped to a minimum of 1.
 */
export function retryAfterSeconds(windowMs: number): number {
  return Math.max(1, Math.ceil(windowMs / 1000));
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
   * Message returned in the JSON 429 body.
   * Defaults to a generic throttling message.
   */
  message?: string;
  /**
   * Optional predicate to skip counting a request against the limit. Receives
   * the request and returns `true` to bypass the limiter (e.g. health checks).
   */
  skip?: (req: Request) => boolean;
  /**
   * Optional backing store for distributed rate limiting (e.g. Redis via
   * `rate-limit-redis`). When omitted the default in-memory store is used —
   * see the store limitation note on {@link makeLimiter}.
   */
  store?: Store;
}

/** Default message used when a caller does not supply one. */
const DEFAULT_MESSAGE = "Too many requests, please try again later.";

/**
 * Build a named, in-memory rate limiter with the app's shared key generator,
 * a `Retry-After` header on every 429 response, and a JSON 429 body consistent
 * with the global error envelope (`{ "error": string }`).
 *
 * Centralising limiter construction removes duplicated
 * keyGenerator/handler/message wiring and gives the app a single seam for
 * per-route tuning and for swapping the backing store.
 *
 * ## Retry-After
 *
 * Every 429 response carries a `Retry-After` header set to the number of
 * whole seconds remaining in the current window. This lets clients and
 * intermediate infrastructure (CDNs, API gateways) back off safely without
 * polling or guessing.
 *
 * ## Store errors / fail-open behaviour
 *
 * `passOnStoreError: true` is set explicitly below so that when the backing
 * store throws (e.g. a Redis outage), the request is allowed through rather
 * than rejected — `express-rate-limit`'s own default is `passOnStoreError:
 * false`, which instead propagates the error to Express's error handling and
 * fails **closed**. Failing open is the correct trade-off for availability (a
 * Redis outage should not bring down the API), but it means distributed
 * enforcement silently degrades to no enforcement. The store error is logged
 * via `express-rate-limit`'s default logger (`console.error`) so the operator
 * can alert on it.
 *
 * ## Store limitation (in-memory default)
 *
 * When no `store` is provided this uses `express-rate-limit`'s default
 * in-memory store. Counters live in the process heap, which means:
 *
 *  - State is **not shared** across instances/replicas — each process enforces
 *    its own counts, so the effective limit scales with the number of
 *    instances behind a load balancer.
 *  - Counters **reset on restart/redeploy**, briefly relaxing enforcement.
 *
 * For multi-instance deployments, pass a shared `store` (e.g.
 * `new RedisStore({ sendCommand })` from `rate-limit-redis`). The `store`
 * option is the single place to wire that up.
 *
 * @param options - {@link MakeLimiterOptions} controlling window, max, name,
 *   message, optional skip predicate, and optional backing store.
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
  const { windowMs, max, message = DEFAULT_MESSAGE, skip, store, name } = options;

  // Pre-compute the Retry-After value; it is constant for the lifetime of the
  // limiter because the window length is fixed at construction time.
  const retryAfter = retryAfterSeconds(windowMs);

  return rateLimit({
    windowMs,
    max,
    message,
    // Disable legacy `X-RateLimit-*` headers and the draft standard
    // `RateLimit-*` headers. Clients should rely on `Retry-After` (set
    // explicitly in the handler below) rather than implementation-specific
    // count/remaining headers whose semantics vary across stores and versions.
    standardHeaders: false,
    legacyHeaders: false,
    // Delegate to keyByIp instead of re-implementing the same fallback/warn
    // logic inline. Keeping a single implementation means the "unknown"
    // fallback and its warning can't silently drift out of sync between the
    // exported helper and what limiters actually enforce at runtime.
    keyGenerator: keyByIp,
    ...(skip ? { skip } : {}),
    // ---- Shared-store seam --------------------------------------------------
    // Pass a `store` option to share counts across replicas:
    //   import { RedisStore } from "rate-limit-redis";
    //   store: new RedisStore({ sendCommand: (...a) => redisClient.sendCommand(a) })
    // When the store throws, fail open (allow the request) instead of the
    // library's default of propagating the error. See "Store errors /
    // fail-open behaviour" above.
    ...(store ? { store } : {}),
    passOnStoreError: true,
    // -------------------------------------------------------------------------
    handler: (_req: Request, res: Response) => {
      console.warn(`[rate-limit] limit reached for limiter="${name}"`);
      res.setHeader("Retry-After", retryAfter);
      res.status(429).json({ error: message });
    },
  });
}

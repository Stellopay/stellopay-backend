import rateLimit, {
  type RateLimitRequestHandler,
  type Store,
  ipKeyGenerator,
} from "express-rate-limit";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Idempotency-Key support
// ---------------------------------------------------------------------------

/** Canonical header name for the idempotency key. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** Response header set to `"true"` when a request was recognized as a replay. */
export const X_IDEMPOTENT_REPLAYED_HEADER = "X-Idempotent-Replayed";

/**
 * Extract an optional idempotency key from the request.
 *
 * Reads the `Idempotency-Key` header. Returns `undefined` when the header is
 * absent, empty, or longer than 255 characters (defensive bound against
 * unbounded storage growth).
 */
export function getIdempotencyKey(req: Request): string | undefined {
  const value = req.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > 255) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

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
  /**
   * Enable idempotency-key deduplication. When `true`, requests with the same
   * `Idempotency-Key` header **and** the same client IP are deduplicated:
   * only the first occurrence counts against the rate limit; subsequent
   * identical-key requests replay the first request's outcome.
   *
   * Idempotency state lives in an in-memory `Map` scoped to the limiter
   * instance and expires after `windowMs`. For distributed deployments you
   * should provide a shared `store` and extend the idempotency tracking to
   * use the same backend — see the out-of-scope note in
   * {@link makeLimiter}.
   *
   * @default false
   */
  idempotent?: boolean;
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
  const { windowMs, max, message = DEFAULT_MESSAGE, skip, store, name, idempotent } = options;

  // Pre-compute the Retry-After value; it is constant for the lifetime of the
  // limiter because the window length is fixed at construction time.
  const retryAfter = retryAfterSeconds(windowMs);

  const baseLimiter = rateLimit({
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

  if (!idempotent) {
    return baseLimiter;
  }

  // ---- Idempotency-key deduplication wrapper --------------------------------
  // Idempotency records are stored in an in-memory Map scoped to this limiter
  // instance. Entries are cleaned up after windowMs.
  const idempotencyCache = new Map<string, { outcome: "allowed" | "throttled" }>();

  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  function startCleanup(): void {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      idempotencyCache.clear();
    }, windowMs);
    if (cleanupTimer?.unref) cleanupTimer.unref();
  }

  function recordIdempotency(req: Request, outcome: "allowed" | "throttled"): void {
    const idKey = getIdempotencyKey(req);
    if (!idKey) return;
    startCleanup();
    idempotencyCache.set(`${name}:${keyByIp(req)}:${idKey}`, { outcome });
  }

  return (req: Request, res: Response, next: () => void) => {
    const idKey = getIdempotencyKey(req);
    if (!idKey) {
      baseLimiter(req, res, next);
      return;
    }

    const cacheKey = `${name}:${keyByIp(req)}:${idKey}`;
    const existing = idempotencyCache.get(cacheKey);

    // Known idempotency key: replay the previous outcome without touching the
    // rate-limit store (no increment, no double-counting).
    if (existing) {
      res.setHeader(X_IDEMPOTENT_REPLAYED_HEADER, "true");
      if (existing.outcome === "throttled") {
        res.setHeader("Retry-After", retryAfter);
        res.status(429).json({ error: message });
        return;
      }
      next();
      return;
    }

    // Track the outcome produced by the rate limiter.
    const wrappedNext = () => {
      recordIdempotency(req, "allowed");
      next();
    };

    // Intercept 429 responses from the base limiter's handler.
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      // The handler calls res.status(429).json(...) only when throttling.
      // Record the throttled outcome before sending the response.
      if (res.statusCode === 429) {
        recordIdempotency(req, "throttled");
      }
      return originalJson(body);
    };

    baseLimiter(req, res, wrappedNext);
  };
}

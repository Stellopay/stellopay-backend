import rateLimit, {
  type RateLimitRequestHandler,
  type Store,
  ipKeyGenerator,
} from "express-rate-limit";
import type { Request, Response } from "express";
import { IdempotencyKeySchema } from "../utils/validation.js";
import {
  IdempotencyStore,
  computeFingerprint,
  type ClaimResult,
} from "./idempotency-store.js";

// ---------------------------------------------------------------------------
// Idempotency-Key support
// ---------------------------------------------------------------------------

/** Canonical header name for the idempotency key. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
/** Header name for Retry-After on 429 responses */
export const RETRY_AFTER_HEADER = "Retry-After";
/** Shape of the JSON body returned on rate limit (429) */
export interface RateLimitErrorBody { error: string; }

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
  return IdempotencyKeySchema.safeParse(value).success ? value : undefined;
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
   * Optional cost function to determine the weight of the request.
   * Useful for batching or pagination where a single request consumes
   * multiple tokens. The limiter scales the effective max requests inversely
   * to the cost.
   *
   * Requests where the cost alone exceeds `max` are immediately throttled.
   */
  cost?: (req: Request) => number | Promise<number>;
  /**
   * Enable idempotency-key deduplication. When `true`, requests with the same
   * `Idempotency-Key` header **and** the same client IP are deduplicated:
   * only the first request runs the downstream operation; subsequent
   * identical-key requests replay the first request's stored response (or
   * receive a deterministic `409` when the request body differs or the
   * operation is still in flight).
   *
   * Idempotency state is persisted in the shared `idempotency_keys` database
   * table, so deduplication works across processes/replicas and survives
   * restarts. Records are retained for 24 hours (see
   * {@link ../middleware/idempotency-store.ts | idempotency-store}). The
   * persistence path fails **closed**: if the database is unreachable, the
   * request is rejected with `503` rather than silently proceeding without
   * idempotency protection. This is independent of the rate limiter's own
   * fail-open `passOnStoreError` behaviour, which is unchanged.
   *
   * Requests without an `Idempotency-Key` header bypass idempotency
   * entirely and behave exactly as if `idempotent` were `false`.
   *
   * @default false
   */
  idempotent?: boolean;
}

/** Default message used when a caller does not supply one. */
const DEFAULT_MESSAGE = "Too many requests, please try again later.";

// ---------------------------------------------------------------------------
// Environment-variable override helpers
// ---------------------------------------------------------------------------

const ABSURD_MAX_THRESHOLD = 1000;

function getEnvOverride(name: string, suffix: string): string | undefined {
  const safeName = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const value = process.env[`RATE_LIMIT_${safeName}_${suffix}`];
  return value ?? undefined;
}

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
 * ## Environment-variable overrides
 *
 * Each option can be overridden at runtime via the environment:
 *
 * | Variable | Overrides | Example |
 * |---|---|---|
 * | `RATE_LIMIT_<NAME>_MAX` | `max` | `RATE_LIMIT_GLOBAL_MAX=50` |
 * | `RATE_LIMIT_<NAME>_WINDOW_MS` | `windowMs` | `RATE_LIMIT_STRICT_WINDOW_MS=120000` |
 * | `RATE_LIMIT_<NAME>_MESSAGE` | `message` | `RATE_LIMIT_CONTACT_MESSAGE="Slow down"` |
 *
 * `<NAME>` is the limiter `name` uppercased with non-alphanumeric characters
 * replaced by `_`. Overrides apply at construction time only; they are read
 * once when `makeLimiter()` is called.
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
  let { windowMs, max, message = DEFAULT_MESSAGE, skip, store, name, idempotent } = options;

  // ---- Input validation ---------------------------------------------------
  if (!name || typeof name !== "string") {
    throw new TypeError(
      `[rate-limit] "name" is required and must be a non-empty string`,
    );
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError(
      `[rate-limit] limiter="${name}": windowMs must be a positive number`,
    );
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new TypeError(
      `[rate-limit] limiter="${name}": max must be a positive number`,
    );
  }

  // ---- Environment-variable overrides -------------------------------------
  const envWindowMs = getEnvOverride(name, "WINDOW_MS");
  if (envWindowMs !== undefined) {
    const parsed = parseInt(envWindowMs, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      windowMs = parsed;
    }
  }

  const envMax = getEnvOverride(name, "MAX");
  if (envMax !== undefined) {
    const parsed = parseInt(envMax, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      max = parsed;
    }
  }

  const envMessage = getEnvOverride(name, "MESSAGE");
  if (envMessage !== undefined) {
    message = envMessage;
  }

  // Warn if the effective max is absurdly high (likely a config mistake).
  if (max > ABSURD_MAX_THRESHOLD) {
    console.warn(
      `[rate-limit] limiter="${name}" has an absurdly high max of ${max}` +
        (envMax !== undefined
          ? ` (set via RATE_LIMIT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MAX)`
          : ""),
    );
  }

  // Pre-compute the Retry-After value; it is constant for the lifetime of the
  // limiter because the window length is fixed at construction time.
  const retryAfter = retryAfterSeconds(windowMs);

  const baseLimiter = rateLimit({
    windowMs,
    limit: options.cost
      ? async (req: Request, res: Response) => {
          const baseMax = max;
          try {
            const c = await options.cost!(req);
            if (c <= 0) return baseMax;
            if (c > baseMax) return 0;
            return Math.floor(baseMax / c);
          } catch (err) {
            console.error(`[rate-limit] cost function threw for limiter="${name}":`, err);
            return baseMax;
          }
        }
      : max,
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
      res.setHeader(RETRY_AFTER_HEADER, retryAfter);
      const body: RateLimitErrorBody = { error: message };
      res.status(429).json(body);
    },
  });

  if (!idempotent) {
    return baseLimiter;
  }

  // ---- Persistent idempotency-key deduplication wrapper ----------------------
  // Idempotency state lives in the shared `idempotency_keys` database table,
  // so duplicate requests are recognised across processes/replicas rather
  // than only within this limiter instance. The unique (route, key) primary
  // key decides the single winner under concurrency; every other request is
  // replayed the stored response or rejected deterministically. See
  // ./idempotency-store.ts for the lifecycle, retention, and fail-closed
  // semantics.
  const idempotencyStore = new IdempotencyStore();

  // express-rate-limit's handler type also carries resetKey/getKey helpers;
  // forward them so callers that manage keys programmatically keep working.
  const handler = (async (req: Request, res: Response, next: () => void) => {
    const idKey = getIdempotencyKey(req);
    if (!idKey) {
      baseLimiter(req, res, next);
      return;
    }

    // Idempotency scope: limiter name + resolved client IP. This preserves the
    // previous in-memory identity semantics — the same key from the same
    // client on the same limiter deduplicates, while unrelated clients (or
    // routes behind different limiters) can never collide on a key.
    const route = `${name}:${keyByIp(req)}`;
    const fingerprint = computeFingerprint(req.body);

    let claim: ClaimResult;
    try {
      claim = await idempotencyStore.claim(route, idKey, fingerprint);
    } catch (error) {
      // FAIL-CLOSED: if we cannot establish whether this key was already
      // processed, we must not run the downstream operation (it could
      // double-execute a payment-adjacent side effect). This is separate
      // from the rate limiter's own fail-open `passOnStoreError` behaviour,
      // which is unchanged.
      console.error(`[rate-limit] idempotency claim failed for limiter="${name}"`, {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({ error: "Idempotency store unavailable, please retry later." });
      return;
    }

    // Completed with an identical request: replay the stored response without
    // touching the rate-limit store (no increment, no double-counting).
    if (claim.outcome === "replay") {
      res.setHeader(X_IDEMPOTENT_REPLAYED_HEADER, "true");
      if (claim.statusCode === 429) {
        res.setHeader(RETRY_AFTER_HEADER, retryAfter);
      }
      res.status(claim.statusCode).json(claim.responseBody);
      return;
    }

    // Completed with a materially different request body: never silently
    // execute the new payload under an old key.
    if (claim.outcome === "conflict") {
      res.status(409).json({ error: "Idempotency key already used with a different request body" });
      return;
    }

    // Another request currently holds the key (or the store could not
    // establish a safe state): do not execute.
    if (claim.outcome === "in_progress") {
      res.status(409).json({ error: "Request with this idempotency key is already being processed" });
      return;
    }

    // This request won the claim — run the base limiter, then the downstream
    // handler, capturing the response so the record can be completed (or
    // marked failed when the operation returns a 5xx).
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let captured = false;

    const captureResponse = (body: unknown): void => {
      if (captured) return;
      captured = true;
      const statusCode = res.statusCode;
      // Fire-and-forget: the response is sent immediately; the record write
      // happens concurrently. If the write fails the record stays
      // in_progress and expires after the TTL, so a retry within the TTL
      // receives 409 rather than re-executing — no duplicate downstream
      // operation can occur.
      void (async () => {
        try {
          if (statusCode >= 500) {
            await idempotencyStore.fail(route, idKey);
          } else {
            await idempotencyStore.complete(route, idKey, statusCode, body ?? {});
          }
        } catch (error) {
          console.error(`[rate-limit] idempotency persistence failed for limiter="${name}"`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    };

    res.json = ((body: unknown) => {
      captureResponse(body);
      return originalJson(body);
    }) as typeof res.json;

    res.send = ((body: unknown) => {
      captureResponse(body);
      return originalSend(body);
    }) as typeof res.send;

    baseLimiter(req, res, next);
  }) as RateLimitRequestHandler;

  handler.resetKey = baseLimiter.resetKey.bind(baseLimiter);
  handler.getKey = baseLimiter.getKey.bind(baseLimiter);
  return handler;
}

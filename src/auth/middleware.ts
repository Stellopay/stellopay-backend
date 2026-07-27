import { Request, Response, NextFunction } from "express";
import { requireSession } from "./session.js";
import { env } from "../config.js";
import { normalizeStarknetAddress } from "../utils/address.js";

/**
 * The authenticated principal bound to `req.auth` by {@link requireAuth}.
 *
 * This type is the compatibility anchor for the whole module: the global
 * `Express.Request` augmentation below is declared in terms of it, so the
 * exported type and the actual runtime shape cannot drift apart. Callers that
 * need to name the principal should import this rather than re-declaring the
 * object literal.
 *
 * Adding an OPTIONAL field here is backward compatible. Adding a required
 * field, removing a field, or changing a field's type is not — see
 * `docs/auth/middleware.md`, "Compatibility guarantees".
 */
export type AuthPrincipal = {
  /**
   * The lowercased `x-user-address` header value — NOT the canonical
   * `0x + 64 hex` form. See {@link requireAuth} for why.
   */
  address: string;
  /** The trimmed bearer token, exactly as the client sent it. */
  token: string;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPrincipal;
    }
  }
}

/**
 * Express principal-resolution and route-authorization boundary.
 *
 * The contract is intentionally narrow so privilege checks cannot drift as
 * new routes are added. Every caller of `req.auth` MUST go through these two
 * middlewares — anything else is a bug. The full contract, including the
 * compatibility guarantees this module makes to existing callers, is
 * documented in `docs/auth/middleware.md`; the body of this file is the
 * implementation side of that contract.
 *
 * Idempotency contract (added in #335):
 *   - `requireAuth` is idempotent: once `req.auth` is set, subsequent calls
 *     are no-ops (skip session re-validation).
 *   - `requireAdmin` is idempotent: once the principal is authorized, the
 *     result is cached in `res.locals.adminAuthorized` and subsequent calls
 *     are no-ops.
 *
 * TL;DR status matrix:
 *   - `requireAuth` only fail path   -> 401 { error: "Unauthorized" }
 *   - `requireAdmin` no principal    -> 401 { error: "Unauthorized" }
 *   - `requireAdmin` wrong role      -> 403 { error: "Forbidden" }
 */

/** Header carrying the caller's Starknet wallet address. */
export const PRINCIPAL_HEADER = "x-user-address";

/** Header carrying the session token. */
export const AUTHORIZATION_HEADER = "authorization";

/** Required prefix on {@link AUTHORIZATION_HEADER}, including the space. */
export const BEARER_PREFIX = "Bearer ";

/**
 * The exact bodies and statuses this module responds with.
 *
 * Frozen and exported so tests, route handlers, and API clients can assert
 * against one definition instead of re-typing the literals. The bodies carry
 * no reason code on purpose: every `requireAuth` failure mode returns the
 * identical payload so the response cannot be used to probe which header was
 * wrong, whether a session exists, or who is on the admin allowlist.
 */
export const UNAUTHORIZED_STATUS = 401;
export const FORBIDDEN_STATUS = 403;
export const UNAUTHORIZED_BODY = Object.freeze({ error: "Unauthorized" });
export const FORBIDDEN_BODY = Object.freeze({ error: "Forbidden" });

/** Sends one of the two canonical denials. Never calls `next()`. */
function deny(res: Response, kind: "unauthorized" | "forbidden"): void {
  if (kind === "unauthorized") {
    res.status(UNAUTHORIZED_STATUS).json({ ...UNAUTHORIZED_BODY });
    return;
  }
  res.status(FORBIDDEN_STATUS).json({ ...FORBIDDEN_BODY });
}

/**
 * Reads the authenticated principal off a request, or `null` when there is
 * none.
 *
 * The supported way for a route handler to consume the principal. `req.auth`
 * remains readable and is not going away, but going through this accessor
 * means a caller does not have to re-implement the "present but blank
 * address" check that {@link requireAdmin} applies, and does not need a
 * non-null assertion (`req.auth!`) that would silently become wrong if the
 * route were ever mounted without {@link requireAuth}.
 *
 * "Absent" is the exact predicate {@link requireAdmin} has always used:
 * `req.auth` missing, or `req.auth.address` empty. A whitespace-only address
 * is NOT treated as absent — it falls through to the address parser and is
 * rejected there, which is the pre-existing behaviour and is preserved
 * deliberately. `requireAuth` cannot produce either case; they only arise if
 * a downstream middleware mutates `req.auth`.
 */
export function getPrincipal(req: Request): AuthPrincipal | null {
  const auth = req.auth;
  if (!auth || !auth.address) return null;
  return auth;
}

/**
 * Like {@link getPrincipal}, but throws when there is no principal.
 *
 * For handlers that are mounted behind {@link requireAuth} and want the
 * non-null type without writing `req.auth!`. The throw surfaces through
 * Express as a 5xx, which is the correct signal: a route reaching here
 * without a principal is a wiring mistake, not a client error.
 */
export function requirePrincipal(req: Request): AuthPrincipal {
  const principal = getPrincipal(req);
  if (principal === null) {
    throw new Error("requirePrincipal: no authenticated principal — is requireAuth mounted?");
  }
  return principal;
}

let cachedRawAdminAddresses: string[] | undefined = undefined;
let cachedNormalizedAdmins: string[] = [];

function getNormalizedAdminAddresses(): string[] {
  const currentAdmins = env.ADMIN_ADDRESSES;
  if (currentAdmins === cachedRawAdminAddresses) {
    return cachedNormalizedAdmins;
  }
  cachedRawAdminAddresses = currentAdmins;
  cachedNormalizedAdmins = currentAdmins
    .map((adminAddr) => {
      try {
        return normalizeStarknetAddress(adminAddr);
      } catch {
        return null;
      }
    })
    .filter((addr): addr is string => addr !== null);
  return cachedNormalizedAdmins;
}

/**
 * Whether `address` resolves to an entry in `env.ADMIN_ADDRESSES`.
 *
 * Both sides go through `normalizeStarknetAddress`, so numeric-equal
 * addresses with different padding/casing (e.g. `0x1` vs `0x000…01` vs a
 * valid mixed-case checksum for the same address) all resolve to one
 * canonical string. A malformed input — on either side — is "not a match":
 * it never throws and never accidentally grants access.
 *
 * Exported so a route can make the same decision `requireAdmin` makes
 * (for example, to vary a response for admins) without duplicating the
 * normalization rules and drifting from them later.
 */
export function isAdminPrincipal(address: string): boolean {
  let userCanonical: string;
  try {
    userCanonical = normalizeStarknetAddress(address);
  } catch {
    return false;
  }

  const normalizedAdmins = getNormalizedAdminAddresses();
  return normalizedAdmins.includes(userCanonical);
}

/**
 * Resolves the authenticated principal from request headers and binds it to
 * `req.auth`. Reads two headers verbatim:
 *
 *   - `x-user-address` — the Starknet wallet address
 *   - `authorization`  — `Bearer <session-token>` issued by /auth/verify
 *
 * On any failure path responds `401 { error: "Unauthorized" }` and does NOT
 * call `next()`. On success sets `req.auth = { address, token }` (address
 * preserved as the lowercased header value so it matches exactly what
 * `auth/session.ts` writes into the database) and calls `next()` outside
 * the try/catch so that downstream synchronous throws surface as a 5xx
 * rather than being silently relabeled as an auth failure.
 *
 * Note: `req.auth.address` is the RAW lowercase header value, NOT the
 * canonical `0x + 64 hex` form. `auth/session.ts` does an exact 1:1 match
 * against the lowercased value, so adding canonical padding here would
 * silently desync principal vs. session. `requireSession` itself is called
 * with the trimmed-but-not-lowercased header, because it does its own
 * normalization — changing either of those would be a breaking change for
 * existing sessions.
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  if (req.auth?.address && req.auth?.token) {
    next();
    return;
  }

  const addressHeader = req.headers[PRINCIPAL_HEADER];
  const authHeader = req.headers[AUTHORIZATION_HEADER];

  if (typeof addressHeader !== "string" || typeof authHeader !== "string") {
    deny(res, "unauthorized");
    return;
  }

  if (!authHeader.startsWith(BEARER_PREFIX)) {
    deny(res, "unauthorized");
    return;
  }

  const token = authHeader.substring(BEARER_PREFIX.length).trim();
  const address = addressHeader.trim();

  if (!token || !address) {
    deny(res, "unauthorized");
    return;
  }

  let isValid: boolean;
  try {
    isValid = await requireSession(address, token);
  } catch {
    isValid = false;
  }
  if (!isValid) {
    deny(res, "unauthorized");
    return;
  }

  req.auth = { address: address.toLowerCase(), token };
  next();
};

/**
 * Layered on top of {@link requireAuth}. Three possible outcomes:
 *
 *   1. `req.auth` missing or `req.auth.address` empty string -> 401.
 *      The caller never authenticated; "log in and retry" is the right
 *      signal.
 *
 *   2. `req.auth` present but address not in the admin allowlist -> 403.
 *      The caller IS authenticated, just not authorized. Returning 401
 *      here would tell the caller to log in, which they already did, and
 *      a client might keep trying credentials forever.
 *
 *   3. Address matches an allowlist entry -> `next()`.
 *
 * The allowlist comparison lives in {@link isAdminPrincipal}. A principal
 * that cannot be parsed as an address is treated as "not a match" and gets a
 * 403 — `requireSession` could not have surfaced such a value, so this only
 * fires if the principal was mutated by a downstream middleware.
 */
export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (res.locals.adminAuthorized === true) {
    next();
    return;
  }

  const principal = getPrincipal(req);
  if (principal === null) {
    deny(res, "unauthorized");
    return;
  }

  if (!isAdminPrincipal(principal.address)) {
    deny(res, "forbidden");
    return;
  }

  res.locals.adminAuthorized = true;
  next();
};

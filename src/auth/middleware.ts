import { Request, Response, NextFunction } from "express";
import { requireSession } from "./session.js";
import { env } from "../config.js";
import { normalizeStarknetAddress } from "../utils/address.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        address: string;
        token: string;
      };
    }
  }
}

/**
 * Express principal-resolution and route-authorization boundary.
 *
 * The contract is intentionally narrow so privilege checks cannot drift as
 * new routes are added. Every caller of `req.auth` MUST go through these two
 * middlewares — anything else is a bug. The full contract is documented in
 * `docs/auth/middleware.md`; the body of this file is the implementation
 * side of that contract.
 *
 * TL;DR status matrix:
 *   - `requireAuth` only fail path   -> 401 { error: "Unauthorized" }
 *   - `requireAdmin` no principal    -> 401 { error: "Unauthorized" }
 *   - `requireAdmin` wrong role      -> 403 { error: "Forbidden" }
 */
const PRINCIPAL_HEADER = "x-user-address";
const BEARER_PREFIX = "Bearer ";

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
 * silently desync principal vs. session.
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const addressHeader = req.headers[PRINCIPAL_HEADER];
  const authHeader = req.headers["authorization"];

  if (typeof addressHeader !== "string" || typeof authHeader !== "string") {
    // Either header missing, undefined, or a non-string (Node http can
    // deliver multi-value headers as an array; calling .startsWith on an
    // array throws). Same response for every shape so we cannot be used to
    // probe header types.
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!authHeader.startsWith(BEARER_PREFIX)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = authHeader.substring(BEARER_PREFIX.length).trim();
  const address = addressHeader.trim();

  // Empty after trim: token and principal are both user-controlled strings,
  // so a missing value is indistinguishable from an empty one and gets the
  // same response.
  if (!token || !address) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let isValid: boolean;
  try {
    isValid = await requireSession(address, token);
  } catch {
    // `requireSession` swallows DB errors but a future change could surface
    // them; treat any throw as a failed authentication so we never hand
    // back a half-validated principal.
    isValid = false;
  }
  if (!isValid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.auth = { address: address.toLowerCase(), token };
  // next() intentionally outside the try/catch so a synchronous throw from
  // a downstream route handler surfaces as a 5xx instead of being
  // silently relabeled as a 401.
  next();
};

/**
 * Layered on top of `requireAuth`. Three possible outcomes:
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
 * The allowlist compare goes through `normalizeStarknetAddress` on BOTH
 * sides so numeric-equal addresses with different padding/casing (e.g.
 * `0x1` vs `0x000...01` vs a valid mixed-case checksum for the same
 * address) all resolve to one canonical string. A malformed entry in
 * `env.ADMIN_ADDRESSES` does not crash the middleware and does not
 * accidentally grant access — it is treated as "not a match".
 */
export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.auth?.address) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let userCanonical: string | null = null;
  try {
    // Re-derive the canonical (0x + 64 hex, lowercase, no redundant zeros)
    // form before comparing against the allowlist so `0x1` and
    // `0x000...001` from different admin sources resolve to the same
    // principal.
    userCanonical = normalizeStarknetAddress(req.auth.address);
  } catch {
    // The authenticated address is malformed — `requireSession` could not
    // have surfaced such a value, so this only fires if the principal was
    // mutated by a downstream middleware. Treat as 403.
    userCanonical = null;
  }

  const isAdmin =
    userCanonical !== null &&
    env.ADMIN_ADDRESSES.some((adminAddr) => {
      try {
        return normalizeStarknetAddress(adminAddr) === userCanonical;
      } catch {
        // A broken env entry is "not a match" — never accidentally grant
        // access by skipping catastrophic validation.
        return false;
      }
    });

  if (!isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
};

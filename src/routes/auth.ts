import { Router } from "express";
import { z } from "zod";
import { provider, getCachedNetworkInfo } from "../starknet/client.js";
import {
  buildTypedChallenge,
  consumeChallenge,
  createChallenge,
  restoreChallenge,
} from "../auth/challenge.js";
import {
  createSession,
  requireSession,
  revokeSession,
  rotateSession,
  revokeAllSessionsForAddress,
  getSessionByHash,
  revokeSessionByHash,
} from "../auth/session.js";
import { requireAuth } from "../auth/middleware.js";
import { env } from "../config.js";
import { isLockedOut, recordFailure, clearFailures } from "../auth/lockout.js";
import {
  logAuthEvent,
  incAuthMetric,
  AUTH_METRICS,
} from "./auth-metrics.js";

/**
 * Authorization & session-issuance contract for `authRouter` (Issue #193).
 *
 * Privilege boundaries are locked by stack-inspection tests in
 * `src/routes/auth.test.ts` and documented in `docs/routes/auth.md`. Do not
 * add or drop `requireAuth` on a route without updating those three in lockstep.
 *
 * Public (no bearer session — wallet proof / token presentation only):
 *   POST /auth/challenge, /auth/verify, /auth/session/validate, /auth/refresh
 *
 * Session-bearer (`requireAuth` before any session mutation):
 *   POST /auth/logout, /auth/revoke, /auth/session/revoke
 *
 * Session issuance (`/auth/verify`) may only mint a token after a consumed
 * challenge has been signature-verified. If issuance fails after that proof,
 * the challenge is restored so the caller can retry without re-signing.
 * Signature failure leaves the challenge consumed (replay-closed).
 */
const AddressString = z.string().min(3).max(100);
const TokenString = z.string().min(10).max(1000);

const AddressBody = z.object({ address: AddressString }).strict();
const VerifyBody = z.object({
  address: AddressString,
  // Some Starknet accounts/wallets produce variable-length signatures (not always 2 felts)
  signature: z.array(z.string().min(1).max(255)).min(2).max(10),
}).strict();
const SessionBody = z.object({
  address: AddressString,
  session_token: TokenString,
}).strict();

const RefreshBody = z.object({
  address: AddressString,
  refresh_token: TokenString,
}).strict();

const RevokeSessionBody = z.object({
  token_hash: z.string().length(64).regex(/^[0-9a-fA-F]{64}$/i),
}).strict();

/**
 * Lowercased admin address set, built once at module load from
 * `env.ADMIN_ADDRESSES`. Using a Set gives O(1) membership checks and
 * avoids re-allocating and re-lowercasing the array on every request to
 * `/auth/session/revoke`.
 *
 * If `env.ADMIN_ADDRESSES` is mutated at runtime (e.g. in tests) use
 * {@link isAdminAddress} which reads the live set after any rebuild, or
 * call {@link rebuildAdminSet} to refresh the set from the current env value.
 */
let adminAddressSet: Set<string> = buildAdminSet();

function buildAdminSet(): Set<string> {
  return new Set(env.ADMIN_ADDRESSES.map((a) => a.toLowerCase()));
}

/**
 * Rebuilds the admin address set from the current value of
 * `env.ADMIN_ADDRESSES`. Call this in tests that mutate `env.ADMIN_ADDRESSES`
 * after module load so the set stays in sync.
 */
export function rebuildAdminSet(): void {
  adminAddressSet = buildAdminSet();
}

/**
 * Returns `true` when `address` (case-insensitive) is listed in
 * `env.ADMIN_ADDRESSES`. The check is O(1) against the pre-built Set.
 */
function isAdminAddress(address: string): boolean {
  return adminAddressSet.has(address.toLowerCase());
}

export const authRouter = Router();

// Debug logger for auth routes (helps track nonce/signature/RPC issues).
// The body is only cloned when it is a non-null object to avoid an
// unconditional spread on every request. Sensitive token fields are redacted.
authRouter.use((req, _res, next) => {
  incAuthMetric(AUTH_METRICS.DEBUG_REQUESTS);
  if (req.body && typeof req.body === "object") {
    const bodyLog: Record<string, unknown> = { ...req.body };
    if (bodyLog.session_token) bodyLog.session_token = "***";
    if (bodyLog.refresh_token) bodyLog.refresh_token = "***";
    if (bodyLog.signature) bodyLog.signature = "***";
    logAuthEvent("debug", "auth.debug.request", {
      method: req.method,
      path: req.originalUrl,
      body: bodyLog,
    });
  } else {
    logAuthEvent("debug", "auth.debug.request", {
      method: req.method,
      path: req.originalUrl,
    });
  }
  next();
});

// Step 1: backend issues a nonce for wallet ownership proof.
//
// IDEMPOTENCY: this endpoint is idempotent on retry within the active TTL window
// because `createChallenge` in src/auth/challenge.ts returns the existing nonce
// (and emits a `challenge_replayed` metric) rather than overwriting it. A retry
// therefore CANNOT invalidate an in-flight verify attempt for the same address.
// See docs/routes/auth.md for the per-endpoint idempotency contract.
authRouter.post("/auth/challenge", async (req, res, next) => {
  const startMs = Date.now();
  try {
    const { address } = AddressBody.parse(req.body);
    const { nonce, expires_in_ms } = createChallenge(address);
    const { chainId } = await getCachedNetworkInfo();

    const typedData = buildTypedChallenge(address, chainId, nonce);
    res.json({ address, nonce, expires_in_ms, chain_id: chainId, typed_data: typedData });

    // Retry (existing nonce replayed) vs fresh issuance can be distinguished
    // by the auth.challenge.retried vs auth.challenge.issued event.
    // createChallenge itself logs a "challenge_replayed" metric via
    // console.info in challenge.ts, but we add an auth-level event here for
    // consistent routing observability.
    if (expires_in_ms < CHALLENGE_TTL_MS) {
      // Remaining TTL < full TTL means the nonce was replayed.
      incAuthMetric(AUTH_METRICS.CHALLENGE_RETRIED);
      logAuthEvent("info", "auth.challenge.retried", {
        address: address.toLowerCase(),
        expires_in_ms,
      });
    } else {
      incAuthMetric(AUTH_METRICS.CHALLENGE_ISSUED);
      logAuthEvent("info", "auth.challenge.issued", {
        address: address.toLowerCase(),
        expires_in_ms,
      });
    }
  } catch (e) {
    incAuthMetric(AUTH_METRICS.CHALLENGE_FAILED);
    logAuthEvent("error", "auth.challenge.failed", {
      message: errorMessage(e),
      duration_ms: Date.now() - startMs,
    });
    next(e);
  }
});

// Step 2: backend verifies signature using account's isValidSignature (RPC verify).
//
// AUTHORIZATION BOUNDARY: a session token is issued only after (1) lockout
// check, (2) atomic challenge consume, and (3) successful signature verify.
// Session-store failure after (3) restores the challenge so the ownership
// proof is not stranded; signature failure leaves the challenge consumed.
authRouter.post("/auth/verify", async (req, res, next) => {
  const startMs = Date.now();
  try {
    const { address, signature } = VerifyBody.parse(req.body);

    if (await isLockedOut(address)) {
      incAuthMetric(AUTH_METRICS.VERIFY_LOCKED_OUT);
      logAuthEvent("warn", "auth.verify.locked_out", {
        address: address.toLowerCase(),
      });
      res.status(401).json({ error: "Invalid signature or account locked" });
      return;
    }

    // Consume (read + delete) the challenge atomically, before the async verify call,
    // so two concurrent requests can't both read it while it's still valid and both
    // pass verification off the same nonce.
    const ch = consumeChallenge(address);
    if (!ch) {
      incAuthMetric(AUTH_METRICS.VERIFY_NO_CHALLENGE);
      logAuthEvent("warn", "auth.verify.no_challenge", {
        address: address.toLowerCase(),
      });
      res
        .status(400)
        .json({ error: "No active challenge (or expired). Call /auth/challenge again." });
      return;
    }

    const { chainId } = await getCachedNetworkInfo();
    const typedData = buildTypedChallenge(address, chainId, ch.nonce);

    const ok = await provider.verifyMessageInStarknet(typedData, signature as any, address);
    if (!ok) {
      await recordFailure(address);
      incAuthMetric(AUTH_METRICS.VERIFY_SIGNATURE_INVALID);
      logAuthEvent("warn", "auth.verify.signature_invalid", {
        address: address.toLowerCase(),
      });
      res.status(401).json({ error: "Invalid signature or account locked" });
      return;
    }

    await clearFailures(address);
    try {
      const session = await createSession(address);
      res.json({
        ok: true,
        address,
        session_token: session.token,
        // The token returned as `session_token` is also valid as the initial
        // `refresh_token` for /auth/refresh (createSession issues a single,
        // dual-role token). Exposing both field names here means a caller
        // reading only this response can discover that contract without
        // needing to read /auth/refresh's response shape too.
        refresh_token: session.token,
        expires_in_ms: session.expires_in_ms,
      });
    } catch (sessionErr) {
      // Ownership was proven but the session store failed. Restore the same
      // nonce/TTL so a retry of /auth/verify can succeed without a new
      // challenge + re-sign. Never overwrite a challenge issued in between.
      restoreChallenge(address, ch);
      // eslint-disable-next-line no-console
      console.error("[auth] /auth/verify session issuance error", sessionErr);
      res.status(500).json({ error: "Unable to issue session" });
      return;
    }
  } catch (e) {
    incAuthMetric(AUTH_METRICS.VERIFY_FAILED);
    logAuthEvent("error", "auth.verify.failed", {
      message: errorMessage(e),
      duration_ms: Date.now() - startMs,
    });
    next(e);
  }
});

// Step 3 (optional): validate an existing session token (helps frontend detect backend restarts)
authRouter.post("/auth/session/validate", async (req, res, next) => {
  const startMs = Date.now();
  try {
    const { address, session_token } = SessionBody.parse(req.body);
    const ok = await requireSession(address, session_token);
    if (!ok) {
      incAuthMetric(AUTH_METRICS.SESSION_VALIDATE_REJECTED);
      logAuthEvent("warn", "auth.session.validate_rejected", {
        address: address.toLowerCase(),
      });
      res.status(401).json({ ok: false, error: "Invalid session" });
      return;
    }
    incAuthMetric(AUTH_METRICS.SESSION_VALIDATED);
    logAuthEvent("info", "auth.session.validate_success", {
      address: address.toLowerCase(),
      duration_ms: Date.now() - startMs,
    });
    res.json({ ok: true, address });
  } catch (e) {
    incAuthMetric(AUTH_METRICS.SESSION_VALIDATE_ERROR);
    logAuthEvent("error", "auth.session.validate_error", {
      message: errorMessage(e),
      duration_ms: Date.now() - startMs,
    });
    next(e);
  }
});

// Step 4: logout and revoke the session
authRouter.post("/auth/logout", requireAuth, async (req, res, next) => {
  const startMs = Date.now();
  try {
    const token = req.auth?.token;
    if (token) {
      await revokeSession(token);
    }
    res.json({ ok: true });

    incAuthMetric(AUTH_METRICS.LOGOUT_COMPLETED);
    logAuthEvent("info", "auth.logout.completed", {
      address: req.auth?.address?.toLowerCase(),
      duration_ms: Date.now() - startMs,
    });
  } catch (e) {
    incAuthMetric(AUTH_METRICS.LOGOUT_FAILED);
    logAuthEvent("error", "auth.logout.failed", {
      address: req.auth?.address?.toLowerCase(),
      message: errorMessage(e),
      duration_ms: Date.now() - startMs,
    });
    next(e);
  }
});

// Step 3.5: rotate a refresh token on every use. Detects reuse of an
// already-rotated (stale) token and revokes the whole token family — a
// possible token-theft signal, not just a normal auth failure. The
// reuse-detection log is emitted by `rotateSession` itself
// (event="session.reuse_detected"), so no extra console.warn here.
authRouter.post("/auth/refresh", async (req, res, next) => {
  const startMs = Date.now();
  try {
    const { address, refresh_token } = RefreshBody.parse(req.body);
    const result = await rotateSession(address, refresh_token);

    if (!result.ok) {
      incAuthMetric(AUTH_METRICS.REFRESH_REJECTED);
      logAuthEvent("warn", "auth.refresh.rejected", {
        address: address.toLowerCase(),
        reason: result.reason,
      });
      res.status(401).json({ ok: false, error: "Invalid refresh token" });
      return;
    }

    res.json({
      ok: true,
      address,
      refresh_token: result.token,
      // The rotated token is likewise dual-role: it is both the next
      // refresh_token and a valid bearer session_token for protected
      // routes / /auth/session/validate. See docs/routes/auth.md.
      session_token: result.token,
      expires_in_ms: result.expires_in_ms,
    });

    incAuthMetric(AUTH_METRICS.REFRESH_COMPLETED);
    logAuthEvent("info", "auth.refresh.completed", {
      address: address.toLowerCase(),
      expires_in_ms: result.expires_in_ms,
      duration_ms: Date.now() - startMs,
    });
  } catch (e) {
    incAuthMetric(AUTH_METRICS.REFRESH_FAILED);
    logAuthEvent("error", "auth.refresh.failed", {
      message: errorMessage(e),
      duration_ms: Date.now() - startMs,
    });
    next(e);
  }
});

// Step 5: revoke ALL outstanding tokens for the authenticated user.
authRouter.post("/auth/revoke", requireAuth, async (req, res, next) => {
  const startMs = Date.now();
  try {
    const address = req.auth?.address;
    if (!address) {
      incAuthMetric(AUTH_METRICS.REVOKE_MISSING_PRINCIPAL);
      logAuthEvent("warn", "auth.revoke.missing_principal", {});
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    await revokeAllSessionsForAddress(address);
    res.json({ ok: true });

    incAuthMetric(AUTH_METRICS.REVOKE_COMPLETED);
    logAuthEvent("info", "auth.revoke.completed", {
      address: address.toLowerCase(),
      duration_ms: Date.now() - startMs,
    });
  } catch (e) {
    incAuthMetric(AUTH_METRICS.REVOKE_FAILED);
    logAuthEvent("error", "auth.revoke.failed", {
      address: req.auth?.address?.toLowerCase(),
      message: errorMessage(e),
      duration_ms: Date.now() - startMs,
    });
    next(e);
  }
});

// Step 6: revoke a specific active session. Caller must be the session owner or an admin.
authRouter.post("/auth/session/revoke", requireAuth, async (req, res, next) => {
  const startMs = Date.now();
  try {
    const { token_hash } = RevokeSessionBody.parse(req.body);
    const callerAddress = req.auth?.address;
    if (!callerAddress) {
      incAuthMetric(AUTH_METRICS.SESSION_REVOKE_DENIED);
      logAuthEvent("warn", "auth.session_revoke.denied", {
        reason: "no_principal",
      });
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const session = await getSessionByHash(token_hash);
    if (!session) {
      incAuthMetric(AUTH_METRICS.SESSION_REVOKE_NOT_FOUND);
      logAuthEvent("warn", "auth.session_revoke.not_found", {
        token_hash_prefix: token_hash.slice(0, 8),
        caller: callerAddress.toLowerCase(),
      });
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const isOwner = session.address.toLowerCase() === callerAddress.toLowerCase();

    // isAdminAddress checks the pre-built Set — O(1), no per-request array allocation.
    if (!isOwner && !isAdminAddress(callerAddress)) {
      incAuthMetric(AUTH_METRICS.SESSION_REVOKE_DENIED);
      logAuthEvent("warn", "auth.session_revoke.denied", {
        reason: "not_owner",
        caller: callerAddress.toLowerCase(),
        owner: session.address,
      });
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    await revokeSessionByHash(token_hash);
    res.json({ ok: true });

    incAuthMetric(AUTH_METRICS.SESSION_REVOKE_COMPLETED);
    logAuthEvent("info", "auth.session_revoke.completed", {
      token_hash_prefix: token_hash.slice(0, 8),
      by_owner: isOwner,
      caller: callerAddress.toLowerCase(),
      duration_ms: Date.now() - startMs,
    });
  } catch (e) {
    incAuthMetric(AUTH_METRICS.SESSION_REVOKE_FAILED);
    logAuthEvent("error", "auth.session_revoke.failed", {
      message: errorMessage(e),
      duration_ms: Date.now() - startMs,
    });
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

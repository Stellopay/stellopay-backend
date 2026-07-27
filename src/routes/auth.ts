import { Router } from "express";
import { z } from "zod";
import { provider, getCachedNetworkInfo } from "../starknet/client.js";
import { buildTypedChallenge, consumeChallenge, createChallenge } from "../auth/challenge.js";
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

const AddressBody = z.object({ address: z.string().min(3) });
const VerifyBody = z.object({
  address: z.string().min(3),
  // Some Starknet accounts/wallets produce variable-length signatures (not always 2 felts)
  signature: z.array(z.string().min(1)).min(2),
});
const SessionBody = z.object({
  address: z.string().min(3),
  session_token: z.string().min(10),
});

const RefreshBody = z.object({
  address: z.string().min(3),
  refresh_token: z.string().min(10),
});

const RevokeSessionBody = z.object({
  token_hash: z.string().length(64),
});

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
// unconditional spread on every request.
authRouter.use((req, _res, next) => {
  if (req.body && typeof req.body === "object") {
    const bodyLog: Record<string, unknown> = { ...req.body };
    if (bodyLog.session_token) bodyLog.session_token = "***";
    if (bodyLog.signature) bodyLog.signature = "***";
    // eslint-disable-next-line no-console
    console.log(`[auth] ${req.method} ${req.originalUrl}`, { body: bodyLog });
  } else {
    // eslint-disable-next-line no-console
    console.log(`[auth] ${req.method} ${req.originalUrl}`);
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
  try {
    const { address } = AddressBody.parse(req.body);
    const { nonce, expires_in_ms } = createChallenge(address);
    const { chainId } = await getCachedNetworkInfo();

    const typedData = buildTypedChallenge(address, chainId, nonce);
    res.json({ address, nonce, expires_in_ms, chain_id: chainId, typed_data: typedData });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[auth] /auth/challenge error", e);
    next(e);
  }
});

// Step 2: backend verifies signature using account's isValidSignature (RPC verify)
authRouter.post("/auth/verify", async (req, res, next) => {
  try {
    const { address, signature } = VerifyBody.parse(req.body);

    if (isLockedOut(address)) {
      res.status(401).json({ error: "Invalid signature or account locked" });
      return;
    }

    // Consume (read + delete) the challenge atomically, before the async verify call,
    // so two concurrent requests can't both read it while it's still valid and both
    // pass verification off the same nonce.
    const ch = consumeChallenge(address);
    if (!ch) {
      res
        .status(400)
        .json({ error: "No active challenge (or expired). Call /auth/challenge again." });
      return;
    }
    const { chainId } = await getCachedNetworkInfo();

    const typedData = buildTypedChallenge(address, chainId, ch.nonce);

    const ok = await provider.verifyMessageInStarknet(typedData, signature as any, address);
    if (!ok) {
      recordFailure(address);
      res.status(401).json({ error: "Invalid signature or account locked" });
      return;
    }

    clearFailures(address);
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
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[auth] /auth/verify error", e);
    next(e);
  }
});

// Step 3 (optional): validate an existing session token (helps frontend detect backend restarts)
authRouter.post("/auth/session/validate", async (req, res, next) => {
  try {
    const { address, session_token } = SessionBody.parse(req.body);
    const ok = await requireSession(address, session_token);
    if (!ok) {
      res.status(401).json({ ok: false, error: "Invalid session" });
      return;
    }
    res.json({ ok: true, address });
  } catch (e) {
    next(e);
  }
});

// Step 4: logout and revoke the session
authRouter.post("/auth/logout", requireAuth, async (req, res, next) => {
  try {
    const token = req.auth?.token;
    if (token) {
      await revokeSession(token);
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Step 3.5: rotate a refresh token on every use. Detects reuse of an
// already-rotated (stale) token and revokes the whole token family — a
// possible token-theft signal, not just a normal auth failure. The
// reuse-detection log is emitted by `rotateSession` itself
// (event="session.reuse_detected"), so no extra console.warn here.
authRouter.post("/auth/refresh", async (req, res, next) => {
  try {
    const { address, refresh_token } = RefreshBody.parse(req.body);
    const result = await rotateSession(address, refresh_token);

    if (!result.ok) {
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
  } catch (e) {
    next(e);
  }
});

// Step 5: revoke ALL outstanding tokens for the authenticated user.
authRouter.post("/auth/revoke", requireAuth, async (req, res, next) => {
  try {
    const address = req.auth?.address;
    if (!address) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    await revokeAllSessionsForAddress(address);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Step 6: revoke a specific active session. Caller must be the session owner or an admin.
authRouter.post("/auth/session/revoke", requireAuth, async (req, res, next) => {
  try {
    const { token_hash } = RevokeSessionBody.parse(req.body);
    const callerAddress = req.auth?.address;
    if (!callerAddress) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const session = await getSessionByHash(token_hash);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const isOwner = session.address.toLowerCase() === callerAddress.toLowerCase();

    // isAdminAddress checks the pre-built Set — O(1), no per-request array allocation.
    if (!isOwner && !isAdminAddress(callerAddress)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    await revokeSessionByHash(token_hash);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

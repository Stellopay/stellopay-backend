import crypto from "node:crypto";
import { eq, or, lt, isNotNull } from "drizzle-orm";
import { env } from "../config.js";
import { db } from "../db/index.js";
import { sessions as sessionsTable } from "../db/schema.js";
import {
  incSessionMetric,
  setSessionGauge,
  logSessionEvent,
  SESSION_METRICS,
  SESSION_GAUGES,
  type SessionRejectionReason,
} from "./session-metrics.js";
import { withBoundedRetry } from "./session-retry.js";

const SESSION_TTL_MS = env.SESSION_TTL_MS;
const SESSION_MAX_TTL_MS = env.SESSION_MAX_TTL_MS;
// Do not write to DB to update lastSeen/expiresAt if it was updated less than 1 minute ago.
const SESSION_UPDATE_THRESHOLD_MS = 60 * 1000;
// How often the background sweeper purges expired/revoked sessions from the DB.
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// Session lifecycle contract in this module:
// - each row persists a hashed token, the normalized wallet address, and two expiry timestamps;
// - the sliding expiry (`expiresAt`) can move forward on successful use, but never past the
//   immutable absolute cap (`absoluteExpiresAt`);
// - the row is invalidated once it is revoked or rotated.
function normalizeSessionAddress(address: string): string {
  return address.trim().toLowerCase();
}

function getNextSlidingExpiryMs(nowMs: number, absoluteExpiresAt: Date): number {
  const slidingExpiryMs = nowMs + SESSION_TTL_MS;
  return Math.min(slidingExpiryMs, absoluteExpiresAt.getTime());
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `value` is a non-empty, non-whitespace-only string.
 * Used to reject blank or whitespace-padded inputs before they reach DB queries.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Creates a new session in PostgreSQL for the given wallet address.
 * Generates a random 24-byte hex token, hashes it with SHA-256 for database storage,
 * and sets sliding and absolute expiry timestamps.
 *
 * Throws a `TypeError` with message `"address must be a non-empty string"` when
 * `address` is empty or whitespace-only, so callers fail fast with a clear signal
 * instead of persisting a malformed row.
 *
 * Emits a `session.created` log line and bumps `session_created_total`.
 *
 * @param address - The Starknet wallet address
 * @returns The raw token (to return to the client) and the token expiry time
 */
export async function createSession(address: string) {
  if (!isNonEmptyString(address)) {
    logSessionEvent("error", "session.rejected", {
      reason: "missing_input" as SessionRejectionReason,
      operation: "create",
      address: undefined,
      message: "address must be a non-empty string",
    });
    incSessionMetric(SESSION_METRICS.REJECTED);
    throw new TypeError("address must be a non-empty string");
  }

  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const familyId = crypto.randomUUID();
  const now = Date.now();
  const normalizedAddress = normalizeSessionAddress(address);

  try {
    await db.insert(sessionsTable).values({
      tokenHash,
      address: normalizedAddress,
      familyId,
      expiresAt: new Date(now + SESSION_TTL_MS),
      absoluteExpiresAt: new Date(now + SESSION_MAX_TTL_MS),
    });
  } catch (error) {
    incSessionMetric(SESSION_METRICS.REJECTED);
    logSessionEvent("error", "session.rejected", {
      reason: "db_error" as SessionRejectionReason,
      operation: "create",
      address: normalizedAddress,
      message: errorMessage(error),
    });
    throw error;
  }

  incSessionMetric(SESSION_METRICS.CREATED);
  logSessionEvent("info", "session.created", {
    address: normalizedAddress,
    expires_in_ms: SESSION_TTL_MS,
    absolute_expires_in_ms: SESSION_MAX_TTL_MS,
  });

  return { token, expires_in_ms: SESSION_TTL_MS };
}

/**
 * Verifies that a given token is valid for a wallet address, checking database existence,
 * expiration, and revocation status. If valid, updates lastSeen and slides the expiry.
 *
 * Every false return path emits a `session.rejected` log line with a bounded reason
 * code and bumps the matching metric counter. Successful validation emits
 * `session.validated` (debug) and bumps `session_validated_total`.
 *
 * @param address - The Starknet wallet address
 * @param token - The raw session token
 * @returns A promise resolving to true if valid, false otherwise
 */
export async function requireSession(address: string, token: string): Promise<boolean> {
  if (!isNonEmptyString(token) || !isNonEmptyString(address)) {
    recordRejection("missing_input", isNonEmptyString(address) ? address : undefined);
    return false;
  }

  const normalizedToken = token.trim();
  const normalizedAddress = address.trim();

  const tokenHash = crypto.createHash("sha256").update(normalizedToken).digest("hex");
  const now = new Date();

  try {
    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.tokenHash, tokenHash))
      .limit(1);

    if (!session) {
      recordRejection("unknown_token", normalizedAddress);
      return false;
    }
    if (session.revokedAt !== null) {
      recordRejection("revoked", normalizedAddress);
      return false;
    }
    if (session.rotatedAt !== null) {
      recordRejection("revoked", normalizedAddress);
      return false;
    }
    if (session.expiresAt.getTime() < now.getTime()) {
      recordRejection("expired_sliding", normalizedAddress);
      return false;
    }
    if (session.absoluteExpiresAt.getTime() < now.getTime()) {
      recordRejection("expired_absolute", normalizedAddress);
      return false;
    }
    if (session.address !== normalizedAddress.toLowerCase()) {
      recordRejection("address_mismatch", normalizedAddress);
      return false;
    }

    const nextExpiresAtMs = getNextSlidingExpiryMs(now.getTime(), session.absoluteExpiresAt);

    // Only update database if lastSeen is not set or threshold has elapsed to reduce repeated write I/O
    const shouldUpdate =
      !session.lastSeen ||
      (now.getTime() - session.lastSeen.getTime() >= SESSION_UPDATE_THRESHOLD_MS);

    if (shouldUpdate) {
      await db
        .update(sessionsTable)
        .set({
          lastSeen: now,
          expiresAt: new Date(nextExpiresAtMs),
        })
        .where(eq(sessionsTable.tokenHash, tokenHash));
    }

    incSessionMetric(SESSION_METRICS.VALIDATED);
    logSessionEvent("debug", "session.validated", {
      address: normalizeSessionAddress(address),
      next_expires_at: new Date(nextExpiresAtMs).toISOString(),
    });

    return true;
  } catch (error) {
    logSessionEvent("error", "session.rejected", {
      reason: "db_error" as SessionRejectionReason,
      operation: "require",
      address: normalizeSessionAddress(address),
      message: errorMessage(error),
    });
    incSessionMetric(SESSION_METRICS.REJECTED);
    return false;
  }
}

/**
 * Revokes a session token by marking it as revoked in the database.
 *
 * Emits `session.revoked` and bumps `session_revoked_total`. An empty
 * token is treated as a no-op (no log, no metric) so callers can safely
 * invoke this from middleware that has already validated the token.
 *
 * RELIABILITY (issue #125):
 *   1. Idempotent re-revoke detection — if the row already has a non-null
 *      `revokedAt`, an extra `session.revoke_already` log + bump of
 *      `session_revoke_already_total` is emitted and the function
 *      returns early. The retry/update loop is skipped, so the
 *      `session_revoked_total` counter is NOT incremented on a
 *      re-call. This keeps dashboards from inflating the
 *      `session_revoked_total` counter when a chatty client retries the
 *      same logout.
 *   2. Bounded retry — the underlying update is wrapped in
 *      {@link withBoundedRetry} (3 attempts, 50ms delay) so transient
 *      Postgres blips don't surface as 5xx to the caller. Retrying
 *      UPDATE … SET revokedAt = now() is safe because the column write
 *      is idempotent (writing the same value twice produces the same
 *      final state). Each retry emits `session.revoke_retry` and bumps
 *      `session_revoke_retry_total`. After the final attempt, an
 *      `session.revoke_failed` error log + bump of
 *      `session_revoke_failed_total` is emitted and the error is
 *      rethrown so the route handler can return a 5xx.
 *
 * @param token - The raw session token to revoke
 */
export async function revokeSession(token: string): Promise<void> {
  if (!isNonEmptyString(token)) return;
  const trimmedToken = token.trim();
  // Hash for the address correlation in the log — we never log the raw token.
  const tokenHash = crypto.createHash("sha256").update(trimmedToken).digest("hex");
  const tokenHashShort = tokenHash.slice(0, 8);

  // Read first: classifies the call as "already revoked" vs "first revoke".
  // We only run this lookup once before the retry loop so that the same
  // idempotent re-revoke classification holds across retries.
  const [existing] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.tokenHash, tokenHash))
    .limit(1);
  if (existing && existing.revokedAt !== null) {
    incSessionMetric(SESSION_METRICS.REVOKED_ALREADY);
    logSessionEvent("info", "session.revoke_already", {
      kind: "single",
      token_hash_prefix: tokenHashShort,
    });
    // Already revoked — skip the retry/update loop AND the REVOKED bump
    // so that `session_revoked_total` reflects distinct revocations only.
    // The retry loop's UPDATE is redundant (the column is already non-null)
    // and would otherwise double-bump the success metrics on every re-call.
    return;
  }

  try {
    await withBoundedRetry(
      () =>
        db
          .update(sessionsTable)
          .set({ revokedAt: new Date() })
          .where(eq(sessionsTable.tokenHash, tokenHash)),
      {},
      (info) => {
        incSessionMetric(SESSION_METRICS.REVOKE_RETRY);
        logSessionEvent("warn", "session.revoke_retry", {
          kind: "single",
          attempt: info.attempt,
          max_attempts: info.maxAttempts,
          token_hash_prefix: tokenHashShort,
          message: errorMessage(info.error),
        });
      },
    );
  } catch (error) {
    incSessionMetric(SESSION_METRICS.REVOKE_FAILED);
    logSessionEvent("error", "session.revoke_failed", {
      kind: "single",
      token_hash_prefix: tokenHashShort,
      message: errorMessage(error),
    });
    throw error;
  }

  incSessionMetric(SESSION_METRICS.REVOKED);
  logSessionEvent("info", "session.revoked", {
    kind: "single",
    token_hash_prefix: tokenHashShort,
  });
}

export type RotateResult =
  | { ok: true; token: string; expires_in_ms: number }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "reused"; familyId: string };

/**
 * Rotates a refresh (session) token: validates the presented token, issues a
 * brand-new one in the same token family, and marks the old one as rotated
 * so it can never be used again.
 *
 * If the presented token has ALREADY been rotated out (or already revoked),
 * this is treated as a compromise signal — someone is replaying a stale
 * token — and the entire token family is revoked immediately.
 *
 * Emits one of:
 *  - `session.rotated` (info) on success + bumps `session_rotated_total`
 *  - `session.reuse_detected` (warn) on reuse + bumps `session_reuse_detected_total`
 *  - `session.rejected` (warn) on invalid input/expired token + bumps `session_rejected_total`
 *
 * @param address - The Starknet wallet address
 * @param token - The raw refresh token being presented
 */
export async function rotateSession(address: string, token: string): Promise<RotateResult> {
  if (!isNonEmptyString(token) || !isNonEmptyString(address)) {
    recordRejection("missing_input", isNonEmptyString(address) ? address.trim() : undefined);
    return { ok: false, reason: "invalid" };
  }
  const tokenHash = crypto.createHash("sha256").update(token.trim()).digest("hex");
  const now = new Date();
  const normalizedAddress = normalizeSessionAddress(address);

  try {
    return await db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.tokenHash, tokenHash))
        .for("update")
        .limit(1);

      if (!session || session.address !== normalizedAddress) {
        recordRejection(session ? "address_mismatch" : "unknown_token", address);
        return { ok: false, reason: "invalid" };
      }

      // Fallback for rows created before this migration: treat the token itself
      // as the root of its own family so future rotations still chain correctly.
      const familyId = session.familyId ?? session.tokenHash;

      if (session.rotatedAt !== null || session.revokedAt !== null) {
        // Inline family revocation for transaction safety, replicating revokeFamily telemetry
        await tx
          .update(sessionsTable)
          .set({ revokedAt: now })
          .where(eq(sessionsTable.familyId, familyId));
          
        incSessionMetric(SESSION_METRICS.FAMILY_REVOKED);
        logSessionEvent("warn", "session.family_revoked", {
          family_id: familyId,
        });

        incSessionMetric(SESSION_METRICS.REUSE_DETECTED);
        logSessionEvent("warn", "session.reuse_detected", {
          address: normalizedAddress,
          family_id: familyId,
          had_rotated_at: session.rotatedAt !== null,
          had_revoked_at: session.revokedAt !== null,
        });
        
        return { ok: false, reason: "reused", familyId };
      }

      if (
        session.expiresAt.getTime() < now.getTime() ||
        session.absoluteExpiresAt.getTime() < now.getTime()
      ) {
        recordRejection(
          session.absoluteExpiresAt.getTime() < now.getTime() ? "expired_absolute" : "expired_sliding",
          address,
        );
        return { ok: false, reason: "invalid" };
      }

      const newToken = crypto.randomBytes(24).toString("hex");
      const newTokenHash = crypto.createHash("sha256").update(newToken).digest("hex");
      const nowMs = now.getTime();
      let newExpiresAtMs = nowMs + SESSION_TTL_MS;
      if (newExpiresAtMs > session.absoluteExpiresAt.getTime()) {
        newExpiresAtMs = session.absoluteExpiresAt.getTime();
      }

      // Issue the replacement before marking the old one rotated, so a failure
      // here leaves the old token intact instead of orphaning the session.
      await tx.insert(sessionsTable).values({
        tokenHash: newTokenHash,
        address: session.address,
        familyId,
        expiresAt: new Date(newExpiresAtMs),
        absoluteExpiresAt: session.absoluteExpiresAt,
      });

      await tx
        .update(sessionsTable)
        .set({ rotatedAt: now })
        .where(eq(sessionsTable.tokenHash, tokenHash));

      incSessionMetric(SESSION_METRICS.ROTATED);
      logSessionEvent("info", "session.rotated", {
        address: normalizedAddress,
        family_id: familyId,
        expires_in_ms: newExpiresAtMs - nowMs,
      });

      return { ok: true, token: newToken, expires_in_ms: newExpiresAtMs - nowMs };
    });
  } catch (error) {
    incSessionMetric(SESSION_METRICS.REJECTED);
    logSessionEvent("error", "session.rejected", {
      reason: "db_error",
      operation: "rotate",
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "invalid" };
  }
}

/**
 * Revokes every token in a rotation family (used when reuse of a stale,
 * already-rotated token is detected — a likely token-theft signal).
 *
 * Emits `session.family_revoked` (warn) and bumps `session_family_revoked_total`.
 *
 * RELIABILITY (issue #125): see {@link revokeSession} — the same idempotent
 * re-revoke classification + bounded-retry policy applies here.
 *
 * @param familyId - The token family identifier
 */
export async function revokeFamily(familyId: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.familyId, familyId))
    .limit(1);
  if (existing && existing.revokedAt !== null) {
    incSessionMetric(SESSION_METRICS.FAMILY_REVOKED_ALREADY);
    logSessionEvent("info", "session.revoke_already", {
      kind: "family",
      family_id: familyId,
    });
    // Already revoked — skip the retry/update loop AND the FAMILY_REVOKED
    // bump so that `session_family_revoked_total` reflects distinct family
    // revocations only.
    return;
  }

  try {
    await withBoundedRetry(
      () =>
        db
          .update(sessionsTable)
          .set({ revokedAt: new Date() })
          .where(eq(sessionsTable.familyId, familyId)),
      {},
      (info) => {
        incSessionMetric(SESSION_METRICS.REVOKE_RETRY);
        logSessionEvent("warn", "session.revoke_retry", {
          kind: "family",
          family_id: familyId,
          attempt: info.attempt,
          max_attempts: info.maxAttempts,
          message: errorMessage(info.error),
        });
      },
    );
  } catch (error) {
    incSessionMetric(SESSION_METRICS.REVOKE_FAILED);
    logSessionEvent("error", "session.revoke_failed", {
      kind: "family",
      family_id: familyId,
      message: errorMessage(error),
    });
    throw error;
  }

  incSessionMetric(SESSION_METRICS.FAMILY_REVOKED);
  logSessionEvent("warn", "session.family_revoked", {
    family_id: familyId,
  });
}

/**
 * Revokes every outstanding session/refresh token belonging to a user,
 * regardless of family. Used by the /auth/revoke endpoint (e.g. "sign out
 * everywhere" or an admin-triggered account lockdown).
 *
 * Emits `session.all_revoked` (info) and bumps `session_all_revoked_total`.
 *
 * RELIABILITY (issue #125): see {@link revokeSession} — the same idempotent
 * re-revoke classification + bounded-retry policy applies here.
 *
 * Empty or whitespace-only addresses are a no-op (mirrors the
 * `isNonEmptyString` guard on `createSession`/`requireSession`/`rotateSession`):
 * no DB write happens and `session.rejected` (reason `missing_input`) is
 * logged instead of `session.all_revoked`.
 *
 * @param address - The Starknet wallet address
 */
export async function revokeAllSessionsForAddress(address: string): Promise<void> {
  if (!isNonEmptyString(address)) {
    recordRejection("missing_input", undefined);
    return;
  }
  const normalizedAddress = normalizeSessionAddress(address);
  const [existing] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.address, normalizedAddress))
    .limit(1);
  if (existing && existing.revokedAt !== null) {
    incSessionMetric(SESSION_METRICS.ALL_REVOKED_ALREADY);
    logSessionEvent("info", "session.revoke_already", {
      kind: "all",
      address: normalizedAddress,
    });
    // Already revoked — skip the retry/update loop AND the ALL_REVOKED
    // bump so that `session_all_revoked_total` reflects distinct address
    // revocations only.
    return;
  }

  try {
    await withBoundedRetry(
      () =>
        db
          .update(sessionsTable)
          .set({ revokedAt: new Date() })
          .where(eq(sessionsTable.address, normalizedAddress)),
      {},
      (info) => {
        incSessionMetric(SESSION_METRICS.REVOKE_RETRY);
        logSessionEvent("warn", "session.revoke_retry", {
          kind: "all",
          address: normalizedAddress,
          attempt: info.attempt,
          max_attempts: info.maxAttempts,
          message: errorMessage(info.error),
        });
      },
    );
  } catch (error) {
    incSessionMetric(SESSION_METRICS.REVOKE_FAILED);
    logSessionEvent("error", "session.revoke_failed", {
      kind: "all",
      address: normalizedAddress,
      message: errorMessage(error),
    });
    throw error;
  }

  incSessionMetric(SESSION_METRICS.ALL_REVOKED);
  logSessionEvent("info", "session.all_revoked", {
    address: normalizedAddress,
  });
}

/**
 * Retrieves a session from the database by its token hash.
 *
 * @param tokenHash - The SHA-256 hash of the session token
 */
export async function getSessionByHash(
  tokenHash: string,
): Promise<typeof sessionsTable.$inferSelect | null> {
  if (!tokenHash) return null;
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.tokenHash, tokenHash))
    .limit(1);
  return session || null;
}

/**
 * Revokes a session by its token hash.
 *
 * @param tokenHash - The SHA-256 hash of the session token to revoke
 */
export async function revokeSessionByHash(tokenHash: string): Promise<void> {
  if (!tokenHash) return;
  const tokenHashShort = tokenHash.slice(0, 8);

  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(sessionsTable.tokenHash, tokenHash));

  incSessionMetric(SESSION_METRICS.REVOKED);
  logSessionEvent("info", "session.revoked", {
    kind: "single",
    token_hash_prefix: tokenHashShort,
  });
}

/**
 * Removes every session whose TTL has elapsed or has been explicitly revoked.
 *
 * Emits `session.sweep_completed` (info) on success and bumps both
 * `session_sweep_runs_total` and `session_sweep_deleted_total`; emits
 * `session.sweep_failed` (error) on DB error and bumps
 * `session_sweeper_errors_total`.
 *
 * RELIABILITY (issue #125): the DELETE is wrapped in
 * {@link withBoundedRetry} (3 attempts, 50ms delay) so a single transient
 * Postgres blip doesn't leave the sweeper running on an empty result set.
 * Retrying DELETE … WHERE … with the same predicate is idempotent at the
 * SQL level — the second attempt just deletes fewer rows. Each retry
 * emits `session.sweep_retry` (warn) and bumps
 * `session_sweep_retry_total`. If all attempts fail, the existing
 * `session.sweep_failed` path keeps running so the periodic sweeper
 * stays self-healing on the next tick.
 *
 * @param now - Optional timestamp override (default Date.now())
 * @returns A promise resolving to the number of rows deleted
 */
export async function sweepExpiredSessions(now: number = Date.now()): Promise<number> {
  const nowDate = new Date(now);
  try {
    const deleted = await withBoundedRetry(
      () =>
        db
          .delete(sessionsTable)
          .where(
            or(
              lt(sessionsTable.expiresAt, nowDate),
              lt(sessionsTable.absoluteExpiresAt, nowDate),
              isNotNull(sessionsTable.revokedAt),
            ),
          )
          .returning({ tokenHash: sessionsTable.tokenHash }),
      {},
      (info) => {
        incSessionMetric(SESSION_METRICS.SWEEP_RETRY);
        logSessionEvent("warn", "session.sweep_retry", {
          attempt: info.attempt,
          max_attempts: info.maxAttempts,
          message: errorMessage(info.error),
        });
      },
    );
    const count = deleted.length;
    incSessionMetric(SESSION_METRICS.SWEEP_RUNS);
    incSessionMetric(SESSION_METRICS.SWEEP_DELETED, count);
    setSessionGauge(SESSION_GAUGES.LAST_SWEEP_DELETED, count);
    setSessionGauge(SESSION_GAUGES.LAST_SWEEP_AT_MS, now);
    logSessionEvent("info", "session.sweep_completed", {
      deleted: count,
      now: nowDate.toISOString(),
    });
    return count;
  } catch (error) {
    incSessionMetric(SESSION_METRICS.SWEEPER_ERRORS);
    logSessionEvent("error", "session.sweep_failed", {
      message: errorMessage(error),
    });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recordRejection(reason: SessionRejectionReason, address: string | undefined): void {
  incSessionMetric(SESSION_METRICS.REJECTED);
  switch (reason) {
    case "unknown_token":
      incSessionMetric(SESSION_METRICS.REJECTED_UNKNOWN);
      break;
    case "address_mismatch":
      incSessionMetric(SESSION_METRICS.REJECTED_ADDRESS_MISMATCH);
      break;
    case "revoked":
      incSessionMetric(SESSION_METRICS.REJECTED_REVOKED);
      break;
    case "expired_sliding":
    case "expired_absolute":
      incSessionMetric(SESSION_METRICS.REJECTED_EXPIRED);
      break;
    // "missing_input" and "db_error" are bucketed only under the global
    // REJECTED counter; no per-reason counter to keep cardinality bounded.
  }
  logSessionEvent("warn", "session.rejected", {
    reason,
    address: address?.toLowerCase(),
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Periodically purge expired or revoked sessions so they do not accumulate in PostgreSQL.
// Unref'd so it never keeps the process alive; skipped under test.
/* v8 ignore start */
if (env.NODE_ENV !== "test") {
  setInterval(() => {
    sweepExpiredSessions().catch((err) => {
      incSessionMetric(SESSION_METRICS.SWEEPER_ERRORS);
      logSessionEvent("error", "session.sweeper_crashed", {
        message: errorMessage(err),
      });
    });
  }, SESSION_SWEEP_INTERVAL_MS).unref();
}
/* v8 ignore stop */

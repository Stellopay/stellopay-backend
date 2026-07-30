import { env } from "../config.js";

/**
 * Auth route observability helpers.
 *
 * This module owns two side-channels for `src/routes/auth.ts`:
 *
 *  1. `logAuthEvent` — emits a single structured log entry per auth
 *     decision (challenge issuance, signature verification, session
 *     issuance, validation, refresh, logout, revocation). Output format
 *     mirrors `src/auth/session-metrics.ts`: JSON when `LOG_FORMAT=json`,
 *     otherwise a single human-readable line. The `LOG_LEVEL` env var
 *     controls the minimum level emitted.
 *
 *  2. Auth metric counters — process-local, monotonically increasing
 *     counters. Snapshot via {@link getAuthMetricsSnapshot} for
 *     diagnostics or for an `/admin/metrics` endpoint if/when one is
 *     added. No external metrics library is introduced here on purpose:
 *     the scope is "telemetry for auth.ts" and adding Prometheus/OTel is
 *     intentionally deferred.
 *
 * SECURITY: callers MUST NOT pass raw session tokens, signatures, or
 * token hashes. Allowed fields are addresses (already lower-cased by
 * callers), bounded reason codes, IDs, and durations.
 */

export type AuthLogLevel = "error" | "warn" | "info" | "debug";

export type AuthEventName =
  | "auth.challenge.issued"
  | "auth.challenge.retried"
  | "auth.challenge.failed"
  | "auth.verify.locked_out"
  | "auth.verify.no_challenge"
  | "auth.verify.signature_invalid"
  | "auth.verify.session_issued"
  | "auth.verify.failed"
  | "auth.session.validate_success"
  | "auth.session.validate_rejected"
  | "auth.session.validate_error"
  | "auth.refresh.completed"
  | "auth.refresh.rejected"
  | "auth.refresh.failed"
  | "auth.logout.completed"
  | "auth.logout.failed"
  | "auth.revoke.completed"
  | "auth.revoke.missing_principal"
  | "auth.revoke.failed"
  | "auth.session_revoke.completed"
  | "auth.session_revoke.not_found"
  | "auth.session_revoke.denied"
  | "auth.session_revoke.failed"
  | "auth.debug.request";

/**
 * Bounded set of reason codes used for auth verify rejections. The set is
 * intentionally closed so caller-supplied addresses never widen log
 * cardinality through the reason field.
 */
export type AuthVerifyRejectionReason = "locked_out" | "no_challenge" | "signature_invalid";

/**
 * Bounded set of reason codes for session validate rejections.
 */
export type AuthValidateRejectionReason = "invalid_session" | "unknown_token" | "expired" | "revoked" | "address_mismatch";

/**
 * Bounded set of reason codes for session revoke denials.
 */
export type AuthSessionRevokeDenialReason = "not_owner" | "not_admin";

const LEVEL_RANK: Record<AuthLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const _rawLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
const configuredLevel: AuthLogLevel =
  _rawLevel in LEVEL_RANK ? (_rawLevel as AuthLogLevel) : "info";

function isLevelEnabled(level: AuthLogLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[configuredLevel];
}

// ---------------------------------------------------------------------------
// Metric counters
// ---------------------------------------------------------------------------

const counters: Record<string, number> = {};

/** Increment a counter by `by` (default 1). Creates it on first write. */
export function incAuthMetric(name: string, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

/**
 * Point-in-time snapshot of every auth counter. Suitable for exposing via
 * an admin endpoint. Returns a shallow copy so callers cannot mutate the
 * internal state.
 */
export function getAuthMetricsSnapshot(): { counters: Record<string, number> } {
  return { counters: { ...counters } };
}

/**
 * Reset every counter. Tests call this in `beforeEach` so each case starts
 * from a clean slate. Not intended for production use.
 */
export function resetAuthMetrics(): void {
  for (const k of Object.keys(counters)) delete counters[k];
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

/**
 * Emit exactly one structured log line for an auth route event.
 *
 * The payload is merged with `{ timestamp, level, event }` and serialised
 * according to `env.LOG_FORMAT`. Levels below `env.LOG_LEVEL` are dropped
 * before serialization.
 *
 * Callers must keep `data` free of sensitive auth material. See the
 * SECURITY note at the top of this module.
 */
export function logAuthEvent(
  level: AuthLogLevel,
  event: AuthEventName,
  data: Record<string, unknown> = {},
): void {
  if (!isLevelEnabled(level)) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  };

  if (env.LOG_FORMAT === "json") {
    console[level](JSON.stringify(entry));
    return;
  }

  const flat = Object.entries(data)
    .map(([k, v]) => `${k}=${formatScalar(v)}`)
    .join(" ");
  console[level](`[auth] ${entry.timestamp} ${level.toUpperCase()} ${event} ${flat}`);
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserializable>";
  }
}

// ---------------------------------------------------------------------------
// Metric name constants (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Counter names — stable across releases. Use these constants (not raw
 * strings) at every call site so renames stay in lock-step with dashboards.
 */
export const AUTH_METRICS = {
  CHALLENGE_ISSUED: "auth_challenge_issued_total",
  CHALLENGE_RETRIED: "auth_challenge_retried_total",
  CHALLENGE_FAILED: "auth_challenge_failed_total",
  VERIFY_LOCKED_OUT: "auth_verify_locked_out_total",
  VERIFY_NO_CHALLENGE: "auth_verify_no_challenge_total",
  VERIFY_SIGNATURE_INVALID: "auth_verify_signature_invalid_total",
  VERIFY_SESSION_ISSUED: "auth_verify_session_issued_total",
  VERIFY_FAILED: "auth_verify_failed_total",
  SESSION_VALIDATED: "auth_session_validated_total",
  SESSION_VALIDATE_REJECTED: "auth_session_validate_rejected_total",
  SESSION_VALIDATE_ERROR: "auth_session_validate_error_total",
  REFRESH_COMPLETED: "auth_refresh_completed_total",
  REFRESH_REJECTED: "auth_refresh_rejected_total",
  REFRESH_FAILED: "auth_refresh_failed_total",
  LOGOUT_COMPLETED: "auth_logout_completed_total",
  LOGOUT_FAILED: "auth_logout_failed_total",
  REVOKE_COMPLETED: "auth_revoke_completed_total",
  REVOKE_MISSING_PRINCIPAL: "auth_revoke_missing_principal_total",
  REVOKE_FAILED: "auth_revoke_failed_total",
  SESSION_REVOKE_COMPLETED: "auth_session_revoke_completed_total",
  SESSION_REVOKE_NOT_FOUND: "auth_session_revoke_not_found_total",
  SESSION_REVOKE_DENIED: "auth_session_revoke_denied_total",
  SESSION_REVOKE_FAILED: "auth_session_revoke_failed_total",
  /** Total auth request events (debug). */
  DEBUG_REQUESTS: "auth_debug_requests_total",
} as const;

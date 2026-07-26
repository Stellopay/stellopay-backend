import { env } from "../config.js";

/**
 * Session lifecycle observability helpers.
 *
 * This module owns two side-channels for the rest of `src/auth/session.ts`:
 *
 *  1. `logSessionEvent` — emits a single structured log entry per state
 *     transition. Output format mirrors `src/middleware/access-log.ts`:
 *     JSON when `LOG_FORMAT=json`, otherwise a single human-readable line.
 *     The `LOG_LEVEL` env var (existing in `src/config.ts`) controls the
 *     minimum level emitted.
 *
 *  2. Session metric counters — process-local, monotonically increasing
 *     counters plus a small set of gauges. Snapshot via
 *     {@link getSessionMetricsSnapshot} for diagnostics or for an
 *     `/admin/metrics` endpoint if/when one is added. No external metrics
 *     library is introduced here on purpose: the PR scope is "telemetry for
 *     session.ts" and adding Prometheus/OTel is intentionally deferred.
 *
 * SECURITY: callers MUST NOT pass raw session tokens, raw token hashes, or
 * signatures. Allowed fields are addresses (already lower-cased by callers),
 * family IDs, expiry timestamps, and bounded reason codes.
 */

export type SessionLogLevel = "error" | "warn" | "info" | "debug";

export type SessionEventName =
  | "session.created"
  | "session.validated"
  | "session.rejected"
  | "session.revoked"
  | "session.rotated"
  | "session.reuse_detected"
  | "session.family_revoked"
  | "session.all_revoked"
  | "session.sweep_completed"
  | "session.sweep_failed"
  | "session.sweeper_crashed"
  | "session.revoke_retry"
  | "session.revoke_failed"
  | "session.sweep_retry"
  | "session.revoke_already";

/**
 * Bounded set of reason codes used for `session.rejected` log events. The
 * set is intentionally closed so we never blow up log cardinality with
 * attacker-controlled values.
 */
export type SessionRejectionReason =
  | "missing_input"
  | "unknown_token"
  | "address_mismatch"
  | "revoked"
  | "expired_sliding"
  | "expired_absolute"
  | "db_error";

const LEVEL_RANK: Record<SessionLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const _rawLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
const configuredLevel: SessionLogLevel =
  _rawLevel in LEVEL_RANK ? (_rawLevel as SessionLogLevel) : "info";

function isLevelEnabled(level: SessionLogLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[configuredLevel];
}

// ---------------------------------------------------------------------------
// Metric counters / gauges
// ---------------------------------------------------------------------------

const counters: Record<string, number> = {};
const gauges: Record<string, number> = {};

/** Increment a counter by `by` (default 1). Creates it on first write. */
export function incSessionMetric(name: string, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

/** Set a gauge to an absolute value. */
export function setSessionGauge(name: string, value: number): void {
  gauges[name] = value;
}

/**
 * Point-in-time snapshot of every session counter and gauge. Suitable for
 * exposing via an admin endpoint. Returns shallow copies so callers cannot
 * mutate the internal state.
 */
export function getSessionMetricsSnapshot(): {
  counters: Record<string, number>;
  gauges: Record<string, number>;
} {
  return {
    counters: { ...counters },
    gauges: { ...gauges },
  };
}

/**
 * Reset every counter and gauge. Tests call this in `beforeEach` so each
 * case starts from a clean slate. Not intended for production use.
 */
export function resetSessionMetrics(): void {
  for (const k of Object.keys(counters)) delete counters[k];
  for (const k of Object.keys(gauges)) delete gauges[k];
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

/**
 * Emit exactly one structured log line for a session lifecycle event.
 *
 * The payload is merged with `{ timestamp, level, event }` and serialised
 * according to `env.LOG_FORMAT`. Levels below `env.LOG_LEVEL` are dropped
 * before serialization.
 *
 * Callers must keep `data` free of raw tokens / token hashes. See the
 * SECURITY note at the top of this module.
 */
export function logSessionEvent(
  level: SessionLogLevel,
  event: SessionEventName,
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
  const stamp = entry.timestamp;
  console[level](`[session] ${stamp} ${level.toUpperCase()} ${event} ${flat}`);
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
export const SESSION_METRICS = {
  CREATED: "session_created_total",
  VALIDATED: "session_validated_total",
  REJECTED: "session_rejected_total",
  REJECTED_UNKNOWN: "session_rejected_unknown_token_total",
  REJECTED_ADDRESS_MISMATCH: "session_rejected_address_mismatch_total",
  REJECTED_REVOKED: "session_rejected_revoked_total",
  REJECTED_EXPIRED: "session_rejected_expired_total",
  REVOKED: "session_revoked_total",
  ROTATED: "session_rotated_total",
  REUSE_DETECTED: "session_reuse_detected_total",
  FAMILY_REVOKED: "session_family_revoked_total",
  ALL_REVOKED: "session_all_revoked_total",
  SWEEP_RUNS: "session_sweep_runs_total",
  SWEEP_DELETED: "session_sweep_deleted_total",
  SWEEPER_ERRORS: "session_sweeper_errors_total",
  // Reliability: retry counters and idempotency counters for revoke-family
  // style operations. Separate names so dashboards can split "we retried a
  // write because of a transient blip" from "we wrote it once and it stuck".
  REVOKE_RETRY: "session_revoke_retry_total",
  REVOKE_FAILED: "session_revoke_failed_total",
  SWEEP_RETRY: "session_sweep_retry_total",
  REVOKED_ALREADY: "session_revoke_already_total",
  FAMILY_REVOKED_ALREADY: "session_family_revoke_already_total",
  ALL_REVOKED_ALREADY: "session_all_revoke_already_total",
} as const;

export const SESSION_GAUGES = {
  LAST_SWEEP_DELETED: "session_sweeper_last_deleted_count",
  LAST_SWEEP_AT_MS: "session_sweeper_last_run_at_ms",
} as const;

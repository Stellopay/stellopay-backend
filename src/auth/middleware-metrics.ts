import { env } from "../config.js";

/**
 * Auth Middleware observability helpers.
 *
 * Provides telemetry for principal resolution (`requireAuth`) and route
 * authorization (`requireAdmin`):
 *
 *  1. `logAuthMiddlewareEvent` — emits structured JSON or text logs depending on
 *     `LOG_FORMAT`, filtered by `LOG_LEVEL`.
 *  2. `incAuthMetric` / `getAuthMetricsSnapshot` — process-local metric counters
 *     for monitoring authentication resolutions, denials, and authorization gates.
 *
 * SECURITY: NEVER log raw bearer tokens or authorization headers. Only lowercased
 * addresses (which are public on Starknet) and bounded reason codes may be logged.
 */

export type AuthMiddlewareLogLevel = "error" | "warn" | "info" | "debug";

export type AuthMiddlewareEventName =
  | "auth.principal.resolved"
  | "auth.principal.denied"
  | "auth.principal.cached"
  | "auth.principal.missing_error"
  | "auth.admin.authorized"
  | "auth.admin.unauthorized"
  | "auth.admin.forbidden"
  | "auth.admin.cached";

export type AuthMiddlewareDenialReason =
  | "missing_header"
  | "invalid_bearer"
  | "empty_credentials"
  | "invalid_session"
  | "session_error"
  | "no_principal";

const LEVEL_RANK: Record<AuthMiddlewareLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function isLevelEnabled(level: AuthMiddlewareLogLevel): boolean {
  const rawLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  const configuredLevel: AuthMiddlewareLogLevel =
    rawLevel in LEVEL_RANK ? (rawLevel as AuthMiddlewareLogLevel) : "info";
  return LEVEL_RANK[level] <= LEVEL_RANK[configuredLevel];
}

const counters: Record<string, number> = {};
const gauges: Record<string, number> = {};

/** Increment a process-local counter by `by` (default 1). */
export function incAuthMetric(name: string, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

/** Set a gauge to an absolute value. */
export function setAuthGauge(name: string, value: number): void {
  gauges[name] = value;
}

/**
 * Point-in-time snapshot of auth middleware counters and gauges.
 */
export function getAuthMetricsSnapshot(): {
  counters: Record<string, number>;
  gauges: Record<string, number>;
} {
  return {
    counters: { ...counters },
    gauges: { ...gauges },
  };
}

/**
 * Resets all auth middleware metric counters. Used by tests in `beforeEach`.
 */
export function resetAuthMetrics(): void {
  for (const k of Object.keys(counters)) delete counters[k];
  for (const k of Object.keys(gauges)) delete gauges[k];
}

/**
 * Emit exactly one structured log line for an auth middleware event.
 */
export function logAuthMiddlewareEvent(
  level: AuthMiddlewareLogLevel,
  event: AuthMiddlewareEventName,
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
  console[level](`[auth-middleware] ${stamp} ${level.toUpperCase()} ${event} ${flat}`);
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

/**
 * Metric counter name constants.
 */
export const AUTH_METRICS = {
  AUTH_REQUESTS: "auth_middleware_auth_requests_total",
  AUTH_RESOLVED: "auth_middleware_auth_resolved_total",
  AUTH_DENIED: "auth_middleware_auth_denied_total",
  AUTH_DENIED_MISSING_HEADER: "auth_middleware_auth_denied_missing_header_total",
  AUTH_DENIED_INVALID_BEARER: "auth_middleware_auth_denied_invalid_bearer_total",
  AUTH_DENIED_EMPTY_CREDENTIALS: "auth_middleware_auth_denied_empty_credentials_total",
  AUTH_DENIED_INVALID_SESSION: "auth_middleware_auth_denied_invalid_session_total",
  AUTH_IDEMPOTENT_HITS: "auth_middleware_auth_idempotent_hits_total",
  ADMIN_REQUESTS: "auth_middleware_admin_requests_total",
  ADMIN_AUTHORIZED: "auth_middleware_admin_authorized_total",
  ADMIN_UNAUTHORIZED: "auth_middleware_admin_unauthorized_total",
  ADMIN_FORBIDDEN: "auth_middleware_admin_forbidden_total",
  ADMIN_IDEMPOTENT_HITS: "auth_middleware_admin_idempotent_hits_total",
  REQUIRE_PRINCIPAL_MISSING: "auth_middleware_require_principal_missing_total",
} as const;

import { env } from "../config.js";

/**
 * Diagnostics route observability helpers.
 *
 * This module owns two side-channels for `src/routes/diagnostics.ts`:
 *
 *  1. `logDiagnosticsEvent` — emits structured JSON or text logs depending on
 *     `LOG_FORMAT`, filtered by `LOG_LEVEL`. Mirrors the pattern established
 *     by `src/starknet/client-metrics.ts`, `src/auth/session-metrics.ts`, and
 *     `src/auth/middleware-metrics.ts`.
 *
 *  2. Diagnostic metric counters — process-local, monotonically increasing
 *     counters. Snapshot via {@link getDiagnosticsMetricsSnapshot} for
 *     inclusion in the diagnostics response or for external monitoring.
 *     Reset via {@link resetDiagnosticsMetrics} for test isolation.
 *
 * SECURITY: Callers MUST NOT pass raw session tokens, authorization headers,
 * or PII. Only lowercased Starknet addresses (which are public), bounded
 * query parameter values, and timing data may be logged.
 */

export type DiagnosticsLogLevel = "error" | "warn" | "info" | "debug";

export type DiagnosticsEventName =
  | "diagnostics.request"
  | "diagnostics.success"
  | "diagnostics.error"
  | "diagnostics.query_timing";

const LEVEL_RANK: Record<DiagnosticsLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function getConfiguredLogLevel(): DiagnosticsLogLevel {
  const rawLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  return rawLevel in LEVEL_RANK
    ? (rawLevel as DiagnosticsLogLevel)
    : "info";
}

function isLevelEnabled(level: DiagnosticsLogLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[getConfiguredLogLevel()];
}

// ---------------------------------------------------------------------------
// Metric counters & gauges
// ---------------------------------------------------------------------------

const counters: Record<string, number> = {};
const gauges: Record<string, number> = {};

/** Increment a counter by `by` (default 1). Creates it on first write. */
export function incDiagnosticsMetric(name: string, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

/** Set a gauge to an absolute value. */
export function setDiagnosticsGauge(name: string, value: number): void {
  gauges[name] = value;
}

/**
 * Point-in-time snapshot of every diagnostics metric counter and gauge.
 * Returns shallow copies so callers cannot mutate the internal state.
 */
export function getDiagnosticsMetricsSnapshot(): {
  counters: Record<string, number>;
  gauges: Record<string, number>;
} {
  return {
    counters: { ...counters },
    gauges: { ...gauges },
  };
}

/**
 * Reset every counter and gauge. Primary use is in tests to ensure isolation.
 */
export function resetDiagnosticsMetrics(): void {
  for (const k of Object.keys(counters)) delete counters[k];
  for (const k of Object.keys(gauges)) delete gauges[k];
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

/**
 * Emit exactly one structured log line for a diagnostics event.
 *
 * The payload is merged with `{ timestamp, level, event }` and serialised
 * according to `env.LOG_FORMAT`. Levels below `env.LOG_LEVEL` are dropped
 * before serialisation.
 *
 * Callers must keep `data` free of raw tokens, authorization headers, or
 * other PII. See the SECURITY note at the top of this module.
 */
export function logDiagnosticsEvent(
  level: DiagnosticsLogLevel,
  event: DiagnosticsEventName,
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
  console[level](
    `[diagnostics] ${entry.timestamp} ${level.toUpperCase()} ${event} ${flat}`,
  );
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  )
    return String(v);
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
export const DIAGNOSTICS_METRICS = {
  REQUESTS: "diagnostics_requests_total",
  SUCCESS: "diagnostics_success_total",
  ERRORS: "diagnostics_errors_total",
  QUERY_DURATION_MS: "diagnostics_query_duration_ms_total",
  LAST_QUERY_DURATION_MS: "diagnostics_last_query_duration_ms",
} as const;

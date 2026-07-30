import { env } from "../config.js";

/**
 * Starknet client observability and telemetry helpers.
 *
 * This module provides telemetry side-channels for `src/starknet/client.ts`:
 *
 *  1. `logStarknetEvent` — emits structured log entries for RPC calls, fee quotes,
 *     failovers, and network info caching. Output format mirrors other modules:
 *     JSON when `LOG_FORMAT=json`, otherwise a single human-readable line.
 *     The `LOG_LEVEL` env var controls the minimum level emitted.
 *
 *  2. Starknet metric counters — process-local, monotonically increasing counters.
 *     Snapshot via {@link getStarknetMetricsSnapshot} for diagnostics or admin
 *     endpoints. Reset via {@link resetStarknetMetrics} for test isolation.
 *
 * SECURITY: Callers MUST NOT pass private keys, account secrets, or unredacted user payload secrets.
 */

export type StarknetLogLevel = "error" | "warn" | "info" | "debug";

export type StarknetEventName =
  | "starknet.rpc.request"
  | "starknet.rpc.failover"
  | "starknet.rpc.error"
  | "starknet.rpc.success"
  | "starknet.fee_quote.requested"
  | "starknet.fee_quote.success"
  | "starknet.fee_quote.error"
  | "starknet.network_info.cache_hit"
  | "starknet.network_info.fetched"
  | "starknet.network_info.deduplicated"
  | "starknet.network_info.failed";

const LEVEL_RANK: Record<StarknetLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function getConfiguredLogLevel(): StarknetLogLevel {
  const rawLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  return rawLevel in LEVEL_RANK ? (rawLevel as StarknetLogLevel) : "info";
}

function isLevelEnabled(level: StarknetLogLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[getConfiguredLogLevel()];
}

// ---------------------------------------------------------------------------
// Metric counters & gauges
// ---------------------------------------------------------------------------

const counters: Record<string, number> = {};
const gauges: Record<string, number> = {};

/** Increment a counter by `by` (default 1). Creates it on first write. */
export function incStarknetMetric(name: string, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

/** Set a gauge to an absolute value. */
export function setStarknetGauge(name: string, value: number): void {
  gauges[name] = value;
}

/** Return a Prometheus-style metric key with safely escaped label values. */
export function labeledStarknetMetric(name: string, labels: Record<string, string>): string {
  const encoded = Object.entries(labels)
    .map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(",");
  return `${name}{${encoded}}`;
}

/**
 * Point-in-time snapshot of every Starknet metric counter and gauge.
 * Returns shallow copies so callers cannot mutate the internal state.
 */
export function getStarknetMetricsSnapshot(): {
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
export function resetStarknetMetrics(): void {
  for (const k of Object.keys(counters)) delete counters[k];
  for (const k of Object.keys(gauges)) delete gauges[k];
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

/**
 * Emit exactly one structured log line for a Starknet client event.
 */
export function logStarknetEvent(
  level: StarknetLogLevel,
  event: StarknetEventName,
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
  console[level](`[starknet] ${entry.timestamp} ${level.toUpperCase()} ${event} ${flat}`);
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

export const STARKNET_METRICS = {
  RPC_REQUESTS: "starknet_rpc_requests_total",
  RPC_FAILOVERS: "starknet_rpc_failover_total",
  RPC_ERRORS: "starknet_rpc_errors_total",
  RPC_DURATION_MS: "starknet_rpc_duration_ms_total",
  FEE_QUOTE_REQUESTS: "starknet_fee_quote_requests_total",
  FEE_QUOTE_SUCCESS: "starknet_fee_quote_success_total",
  FEE_QUOTE_ERRORS: "starknet_fee_quote_errors_total",
  NETWORK_INFO_CACHE_HITS: "starknet_network_info_cache_hits_total",
  NETWORK_INFO_FETCHES: "starknet_network_info_fetches_total",
  NETWORK_INFO_DEDUPED: "starknet_network_info_deduped_total",
  NETWORK_INFO_ERRORS: "starknet_network_info_errors_total",
} as const;

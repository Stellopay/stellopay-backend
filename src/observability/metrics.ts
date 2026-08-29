import { Counter, Gauge, Registry } from "prom-client";
import {
  getAuthMetricsSnapshot as getAuthMiddlewareMetricsSnapshot,
  AUTH_METRICS as AUTH_MIDDLEWARE_METRICS,
} from "../auth/middleware-metrics.js";
import {
  getSessionMetricsSnapshot,
  SESSION_GAUGES,
} from "../auth/session-metrics.js";
import {
  getAuthMetricsSnapshot as getAuthRouteMetricsSnapshot,
  AUTH_METRICS as AUTH_ROUTE_METRICS,
} from "../routes/auth-metrics.js";
import { getBillingMetricsSnapshot, BILLING_METRICS } from "../routes/billing-metrics.js";
import { getDiagnosticsMetricsSnapshot, DIAGNOSTICS_METRICS } from "../routes/diagnostics-metrics.js";
import { getStarknetMetricsSnapshot, STARKNET_METRICS } from "../starknet/client-metrics.js";

type Snapshot = { counters: Record<string, number>; gauges?: Record<string, number> };
type Metric = Counter<string> | Gauge<string>;

export const metricsRegistry = new Registry();
const metrics = new Map<string, Metric>();

const ALLOWED_COUNTER_NAMES = new Set<string>([
  ...Object.values(AUTH_MIDDLEWARE_METRICS),
  ...Object.values(AUTH_ROUTE_METRICS),
  ...Object.values(BILLING_METRICS),
  ...Object.values(DIAGNOSTICS_METRICS),
  ...Object.values(STARKNET_METRICS),
]);

const ALLOWED_GAUGE_NAMES = new Set<string>([
  ...Object.values(SESSION_GAUGES),
  STARKNET_METRICS.CIRCUIT_BREAKER_STATE,
  DIAGNOSTICS_METRICS.LAST_QUERY_DURATION_MS,
  "backfill_lag_blocks",
]);

const previousCounterValues = new Map<string, number>();

function parseLabeledKey(key: string): { baseName: string; labels: Record<string, string> } | null {
  const braceIndex = key.indexOf("{");
  if (braceIndex === -1) return null;

  const baseName = key.slice(0, braceIndex);
  const labelStr = key.slice(braceIndex + 1, key.lastIndexOf("}"));
  const labels: Record<string, string> = {};

  for (const pair of labelStr.split(",")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) continue;
    const k = pair.slice(0, eqIndex).trim();
    let v = pair.slice(eqIndex + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    v = v.replace(/\\/g, "\\").replace(/"/g, '"');
    labels[k] = v;
  }

  return { baseName, labels };
}

function isAllowedCounter(name: string): boolean {
  if (ALLOWED_COUNTER_NAMES.has(name)) return true;
  const parsed = parseLabeledKey(name);
  return parsed !== null && ALLOWED_COUNTER_NAMES.has(parsed.baseName);
}

function isAllowedGauge(name: string): boolean {
  if (ALLOWED_GAUGE_NAMES.has(name)) return true;
  const parsed = parseLabeledKey(name);
  return parsed !== null && ALLOWED_GAUGE_NAMES.has(parsed.baseName);
}

function metricName(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9_:]/g, "_");
  return normalized.endsWith("_total") ? normalized.slice(0, -6) : normalized;
}

function updateSnapshot(snapshot: Snapshot): void {
  for (const [name, value] of Object.entries(snapshot.counters)) {
    if (!isAllowedCounter(name)) continue;

    const key = `counter:${name}`;
    let metric = metrics.get(key) as Counter<string> | undefined;

    if (!metric) {
      const parsed = parseLabeledKey(name);
      const promName = metricName(parsed?.baseName ?? name);

      if (parsed) {
        metric = new Counter({
          name: promName,
          help: `${parsed.baseName} counter`,
          labelNames: Object.keys(parsed.labels),
          registers: [metricsRegistry],
        });
      } else {
        metric = new Counter({
          name: promName,
          help: `${name} counter`,
          registers: [metricsRegistry],
        });
      }
      metrics.set(key, metric);
    }

    const prev = previousCounterValues.get(name) ?? 0;
    const delta = value - prev;

    if (delta > 0) {
      const parsed = parseLabeledKey(name);
      if (parsed) {
        (metric as Counter<string>).inc(parsed.labels, delta);
      } else {
        metric.inc(delta);
      }
    }
    // delta === 0: no change, skip
    // delta < 0: should never happen for monotonic counters; skip to preserve
    // the existing value. A negative delta indicates the snapshot producer has
    // a bug — the monotonicity test below will catch this.

    previousCounterValues.set(name, value);
  }

  for (const [name, value] of Object.entries(snapshot.gauges ?? {})) {
    if (!isAllowedGauge(name)) continue;

    const key = `gauge:${name}`;
    let metric = metrics.get(key) as Gauge<string> | undefined;

    if (!metric) {
      const parsed = parseLabeledKey(name);
      const promName = metricName(parsed?.baseName ?? name);

      if (parsed) {
        metric = new Gauge({
          name: promName,
          help: `${parsed.baseName} gauge`,
          labelNames: Object.keys(parsed.labels),
          registers: [metricsRegistry],
        });
      } else {
        metric = new Gauge({
          name: promName,
          help: `${name} gauge`,
          registers: [metricsRegistry],
        });
      }
      metrics.set(key, metric);
    }

    const parsed = parseLabeledKey(name);
    if (parsed) {
      (metric as Gauge<string>).set(parsed.labels, value);
    } else {
      metric.set(value);
    }
  }
}

/** Refreshes the shared registry from the existing snapshot-based metrics API. */
export function refreshMetrics(): void {
  updateSnapshot(getAuthMiddlewareMetricsSnapshot());
  updateSnapshot(getSessionMetricsSnapshot());
  updateSnapshot(getAuthRouteMetricsSnapshot());
  updateSnapshot(getBillingMetricsSnapshot());
  updateSnapshot(getDiagnosticsMetricsSnapshot());
  updateSnapshot(getStarknetMetricsSnapshot());
}

export async function renderMetrics(): Promise<string> {
  refreshMetrics();
  return metricsRegistry.metrics();
}

/** Reset internal state. Intended for test isolation only. */
export function resetMetricsForTesting(): void {
  metricsRegistry.clear();
  previousCounterValues.clear();
  metrics.clear();
}
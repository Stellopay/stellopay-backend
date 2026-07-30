import { Counter, Gauge, Registry } from "prom-client";
import { getAuthMetricsSnapshot as getAuthMiddlewareMetricsSnapshot } from "../auth/middleware-metrics.js";
import { getSessionMetricsSnapshot } from "../auth/session-metrics.js";
import { getAuthMetricsSnapshot as getAuthRouteMetricsSnapshot } from "../routes/auth-metrics.js";
import { getBillingMetricsSnapshot } from "../routes/billing-metrics.js";
import { getDiagnosticsMetricsSnapshot } from "../routes/diagnostics-metrics.js";
import { getStarknetMetricsSnapshot } from "../starknet/client-metrics.js";

type Snapshot = { counters: Record<string, number>; gauges?: Record<string, number> };
type Metric = Counter<string> | Gauge<string>;

export const metricsRegistry = new Registry();
const metrics = new Map<string, Metric>();

function metricName(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9_:]/g, "_");
  return normalized.endsWith("_total") ? normalized.slice(0, -6) : normalized;
}

function updateSnapshot(snapshot: Snapshot): void {
  for (const [name, value] of Object.entries(snapshot.counters)) {
    const key = `counter:${name}`;
    let metric = metrics.get(key) as Counter<string> | undefined;
    if (!metric) {
      metric = new Counter({
        name: metricName(name),
        help: `${name} counter`,
        registers: [metricsRegistry],
      });
      metrics.set(key, metric);
    }
    metric.reset();
    metric.inc(value);
  }

  for (const [name, value] of Object.entries(snapshot.gauges ?? {})) {
    const key = `gauge:${name}`;
    let metric = metrics.get(key) as Gauge<string> | undefined;
    if (!metric) {
      metric = new Gauge({
        name: metricName(name),
        help: `${name} gauge`,
        registers: [metricsRegistry],
      });
      metrics.set(key, metric);
    }
    metric.set(value);
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

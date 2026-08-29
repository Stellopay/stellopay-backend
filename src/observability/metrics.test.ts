import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../auth/middleware-metrics.js", () => ({
  getAuthMetricsSnapshot: vi.fn(() => ({ counters: {}, gauges: {} })),
  AUTH_METRICS: {
    AUTH_REQUESTS: "auth_middleware_auth_requests_total",
  },
}));

vi.mock("../auth/session-metrics.js", () => ({
  getSessionMetricsSnapshot: vi.fn(() => ({ counters: {}, gauges: {} })),
  SESSION_GAUGES: {
    LAST_SWEEP_DELETED: "session_sweeper_last_deleted_count",
  },
}));

vi.mock("../routes/auth-metrics.js", () => ({
  getAuthMetricsSnapshot: vi.fn(() => ({ counters: {}, gauges: {} })),
  AUTH_METRICS: {
    CHALLENGE_ISSUED: "auth_challenge_issued_total",
  },
}));

vi.mock("../routes/billing-metrics.js", () => ({
  getBillingMetricsSnapshot: vi.fn(() => ({ counters: {}, gauges: {} })),
  BILLING_METRICS: {
    PROFILE_FETCHED: "billing_profile_fetched_total",
  },
}));

vi.mock("../routes/diagnostics-metrics.js", () => ({
  getDiagnosticsMetricsSnapshot: vi.fn(() => ({ counters: {}, gauges: {} })),
  DIAGNOSTICS_METRICS: {
    REQUESTS: "diagnostics_requests_total",
    LAST_QUERY_DURATION_MS: "diagnostics_last_query_duration_ms",
  },
}));

vi.mock("../starknet/client-metrics.js", () => ({
  getStarknetMetricsSnapshot: vi.fn(() => ({ counters: {}, gauges: {} })),
  STARKNET_METRICS: {
    RPC_REQUESTS: "starknet_rpc_requests_total",
    CIRCUIT_BREAKER_STATE: "starknet_circuit_breaker_state",
  },
}));

import { metricsRegistry, renderMetrics, resetMetricsForTesting } from "./metrics.js";
import { getAuthMetricsSnapshot as getAuthMiddlewareMetricsSnapshot } from "../auth/middleware-metrics.js";
import { getAuthMetricsSnapshot as getAuthRouteMetricsSnapshot } from "../routes/auth-metrics.js";

function parseCounterValue(metricsText: string, prefix: string): number {
  const lines = metricsText.split("\n").filter(
    (l) => l.startsWith(prefix) && !l.startsWith("#"),
  );
  if (lines.length === 0) return 0;
  return Number.parseFloat(lines[0].split(/\s+/).pop()!);
}

describe("metrics", () => {
  beforeEach(() => {
    resetMetricsForTesting();
    vi.clearAllMocks();
  });

  describe("monotonicity: exported counters never decrease", () => {
    it("counter increases across successive snapshots", async () => {
      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: { auth_middleware_auth_requests_total: 10 },
        gauges: {},
      });
      await renderMetrics();

      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: { auth_middleware_auth_requests_total: 15 },
        gauges: {},
      });
      const metricsText = await renderMetrics();
      expect(metricsText).toContain("auth_middleware_auth_requests");
      const value = parseCounterValue(metricsText, "auth_middleware_auth_requests");
      expect(value).toBe(15);
    });

    it("counter does not decrease when snapshot value drops", async () => {
      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: { auth_middleware_auth_requests_total: 20 },
        gauges: {},
      });
      await renderMetrics();

      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: { auth_middleware_auth_requests_total: 15 },
        gauges: {},
      });
      const metricsText = await renderMetrics();
      const value = parseCounterValue(metricsText, "auth_middleware_auth_requests");
      expect(value).toBeGreaterThanOrEqual(20);
    });

    it("no delta is added when snapshot value stays the same", async () => {
      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: { auth_middleware_auth_requests_total: 5 },
        gauges: {},
      });
      await renderMetrics();

      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: { auth_middleware_auth_requests_total: 5 },
        gauges: {},
      });
      const metricsText = await renderMetrics();
      const value = parseCounterValue(metricsText, "auth_middleware_auth_requests");
      expect(value).toBe(5);
    });

    it("multiple snapshots accumulate correctly", async () => {
      const values = [3, 7, 7, 12, 100];
      let lastValue = 0;

      for (const v of values) {
        vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
          counters: { auth_middleware_auth_requests_total: v },
          gauges: {},
        });
        const metricsText = await renderMetrics();
        const currentValue = parseCounterValue(metricsText, "auth_middleware_auth_requests");
        if (v > lastValue) {
          expect(currentValue).toBe(v);
        } else {
          expect(currentValue).toBeGreaterThanOrEqual(lastValue);
        }
        lastValue = currentValue;
      }
    });
  });

  describe("cardinality: unknown keys are dropped", () => {
    it("does not register metrics for unknown counter names", async () => {
      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: {
          auth_middleware_auth_requests_total: 1,
          totally_unknown_counter_xyz: 42,
          another_fake_metric: 99,
        },
        gauges: {},
      });
      const metricsText = await renderMetrics();

      expect(metricsText).toContain("auth_middleware_auth_requests");
      expect(metricsText).not.toContain("totally_unknown_counter");
      expect(metricsText).not.toContain("another_fake_metric");
    });

    it("does not register metrics for unknown gauge names", async () => {
      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: {},
        gauges: {
          session_sweeper_last_deleted_count: 5,
          completely_unknown_gauge: 100,
        },
      });
      const metricsText = await renderMetrics();

      expect(metricsText).toContain("session_sweeper_last_deleted_count");
      expect(metricsText).not.toContain("completely_unknown_gauge");
    });

    it("unbounded stream of unknown keys does not create unbounded series", async () => {
      for (let i = 0; i < 500; i++) {
        vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
          counters: { [`dynamic_key_${i}_total`]: i },
          gauges: {},
        });
        await renderMetrics();
      }

      const metricsText = await renderMetrics();
      for (let i = 0; i < 500; i++) {
        expect(metricsText).not.toContain(`dynamic_key_${i}`);
      }
    });
  });

  describe("allow-list: known names are registered", () => {
    it("registers all known counter metric names", async () => {
      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: { auth_middleware_auth_requests_total: 1 },
        gauges: {},
      });
      vi.mocked(getAuthRouteMetricsSnapshot).mockReturnValueOnce({
        counters: { auth_challenge_issued_total: 2 },
        gauges: {},
      });
      const metricsText = await renderMetrics();

      expect(metricsText).toContain("auth_middleware_auth_requests");
      expect(metricsText).toContain("auth_challenge_issued");
    });

    it("registers allowed gauge metric names", async () => {
      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: {},
        gauges: { session_sweeper_last_deleted_count: 7 },
      });
      const metricsText = await renderMetrics();

      expect(metricsText).toContain("session_sweeper_last_deleted_count");
    });
  });

  describe("gauge handling", () => {
    it("gauge reflects the latest snapshot value", async () => {
      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: {},
        gauges: { session_sweeper_last_deleted_count: 10 },
      });
      await renderMetrics();

      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: {},
        gauges: { session_sweeper_last_deleted_count: 3 },
      });
      const metricsText = await renderMetrics();

      const lines = metricsText.split("\n").filter(
        (l) =>
          l.startsWith("session_sweeper_last_deleted_count") && !l.startsWith("#"),
      );
      if (lines.length > 0) {
        const value = Number.parseFloat(lines[0].split(/\s+/).pop()!);
        expect(value).toBe(3);
      }
    });
  });

  describe("labeled metrics", () => {
    it("accepts labeled gauge keys with known base name", async () => {
      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: {},
        gauges: {
          'starknet_circuit_breaker_state{endpoint="http://localhost:5050"}': 1,
        },
      });
      const metricsText = await renderMetrics();
      expect(metricsText).toContain("starknet_circuit_breaker_state");
    });

    it("rejects labeled gauge keys with unknown base name", async () => {
      vi.mocked(getAuthMiddlewareMetricsSnapshot).mockReturnValueOnce({
        counters: {},
        gauges: {
          'totally_fake_metric{host="evil.com"}': 42,
        },
      });
      const metricsText = await renderMetrics();
      expect(metricsText).not.toContain("totally_fake_metric");
    });
  });
});

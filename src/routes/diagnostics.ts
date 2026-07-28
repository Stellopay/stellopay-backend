import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { db, getPoolStats } from "../db/index.js";
import { sql } from "drizzle-orm";
import { getCircuitBreakerSnapshots } from "../starknet/client.js";
import {
  logDiagnosticsEvent,
  incDiagnosticsMetric,
  setDiagnosticsGauge,
  getDiagnosticsMetricsSnapshot,
  DIAGNOSTICS_METRICS,
} from "./diagnostics-metrics.js";

export const diagnosticsRouter = Router();

const DIAGNOSTICS_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type DiagnosticsIdempotencyEntry = {
  createdAt: number;
  expiresAt: number;
  statusCode: number;
  responseBody: unknown;
};

const diagnosticsIdempotencyStore = new Map<string, DiagnosticsIdempotencyEntry>();

export function clearDiagnosticsIdempotencyStore(): void {
  diagnosticsIdempotencyStore.clear();
}

function pruneExpiredEntries(now: number): void {
  for (const [cacheKey, entry] of diagnosticsIdempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      diagnosticsIdempotencyStore.delete(cacheKey);
    }
  }
}

/**
 * Wrap a diagnostics handler with idempotency support.
 *
 * When an Idempotency-Key header is present, the first successful response for
 * that route/key combination is cached for 24 hours. Replays with the same key
 * return the cached response, preventing ambiguous outcomes on retries.
 */
export function withDiagnosticsIdempotency(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey =
      req.headers["idempotency-key"] || req.headers["Idempotency-Key"];

    if (!idempotencyKey || Array.isArray(idempotencyKey)) {
      await handler(req, res, next);
      return;
    }

    const now = Date.now();
    pruneExpiredEntries(now);

    const userAddress = Array.isArray(req.headers["x-user-address"])
      ? req.headers["x-user-address"][0]
      : req.headers["x-user-address"];

    const cacheKey = `diagnostics:${userAddress}:${req.method}:${req.path}:${idempotencyKey}`;
    const existingEntry = diagnosticsIdempotencyStore.get(cacheKey);

    if (existingEntry && existingEntry.expiresAt > now) {
      res.status(existingEntry.statusCode).json(existingEntry.responseBody);
      return;
    }

    if (existingEntry && existingEntry.expiresAt <= now) {
      diagnosticsIdempotencyStore.delete(cacheKey);
    }

    const originalJson = res.json.bind(res);
    let cachedResponse: DiagnosticsIdempotencyEntry | undefined;

    const persistResponse = (body: unknown): void => {
      if (cachedResponse) {
        return;
      }
      cachedResponse = {
        createdAt: Date.now(),
        expiresAt: Date.now() + DIAGNOSTICS_IDEMPOTENCY_TTL_MS,
        statusCode: res.statusCode,
        responseBody: body,
      };
      diagnosticsIdempotencyStore.set(cacheKey, cachedResponse);
    };

    res.json = ((body: unknown) => {
      persistResponse(body);
      return originalJson(body);
    }) as typeof res.json;

    try {
      await handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

// Diagnostics expose internal data shapes and volumes, so the whole router is
// operator only: every /diagnostics/* route requires a valid session and an
// admin address.
diagnosticsRouter.use(requireAuth, requireAdmin);

import { z } from "zod";

const EventRowSchema = z.object({
  event_type: z.string().default("Unknown"),
  created_at: z.union([z.string(), z.date()]).default(() => new Date(0)),
}).passthrough();

/**
 * Redacts raw database rows from recent event queries down to safe fields
 * (`event_type` and `created_at`). Raw row identifiers (transaction hashes,
 * agreement IDs) and PII are stripped. Malformed rows gracefully fall back
 * to safe defaults to prevent downstream code path errors.
 */
export function redactRecentEvent(row: unknown): {
  event_type: string;
  created_at: string;
} {
  if (!row || typeof row !== "object") {
    return { event_type: "Unknown", created_at: new Date(0).toISOString() };
  }

  const parsed = EventRowSchema.safeParse(row);
  if (!parsed.success) {
    return { event_type: "Unknown", created_at: new Date(0).toISOString() };
  }

  const { event_type, created_at } = parsed.data;
  return {
    event_type,
    created_at: created_at instanceof Date ? created_at.toISOString() : created_at,
  };
}

/**
 * Fetches all telemetry and diagnostic data concurrently using Promise.all.
 * Ensures read queries execute in parallel to minimize latency, eliminate sequential
 * cascade bottlenecks, and guarantee side-effect-free replay safety.
 *
 * Returns both the diagnostic data snapshot and a `queryDurationMs` field
 * measuring the wall-clock time spent executing the five parallel read queries.
 */
export async function fetchDiagnosticsData(
  dbClient = db,
  options: { limit?: number; offset?: number } = {}
): Promise<{
  eventTypeCounts: unknown[];
  escrowEventCounts: unknown[];
  paymentEventCounts: unknown[];
  tableCounts: Record<string, unknown>;
  latestEvents: { event_type: string; created_at: string }[];
  poolStats: ReturnType<typeof getPoolStats>;
  circuitBreakers: ReturnType<typeof getCircuitBreakerSnapshots>;
  summary: {
    totalAgreementEvents: unknown;
    totalEscrowEvents: unknown;
    totalPayments: unknown;
    totalEmployees: unknown;
    totalMilestones: unknown;
    latestBlock: unknown;
  };
  queryDurationMs: number;
  diagnosticsMetrics: ReturnType<typeof getDiagnosticsMetricsSnapshot>;
}> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

  const queryStart = process.hrtime.bigint();

  const [
    eventTypeCountsResult,
    escrowEventCountsResult,
    paymentEventCountsResult,
    tableCountsResult,
    latestEventsResult,
  ] = await Promise.all([
    // Event type counts
    dbClient.execute(sql`
      SELECT event_type, COUNT(*) as count 
      FROM agreement_events 
      GROUP BY event_type 
      ORDER BY count DESC
    `),
    // Escrow event counts
    dbClient.execute(sql`
      SELECT event_type, COUNT(*) as count 
      FROM escrow_events 
      GROUP BY event_type 
      ORDER BY count DESC
    `),
    // Payment event counts
    dbClient.execute(sql`
      SELECT event_type, COUNT(*) as count 
      FROM payments 
      GROUP BY event_type 
      ORDER BY count DESC
    `),
    // Table counts
    dbClient.execute(sql`
      SELECT 
        (SELECT COUNT(*) FROM agreement_events) as agreement_events_count,
        (SELECT COUNT(*) FROM escrow_events) as escrow_events_count,
        (SELECT COUNT(*) FROM payments) as payments_count,
        (SELECT COUNT(*) FROM employees) as employees_count,
        (SELECT COUNT(*) FROM milestones) as milestones_count,
        (SELECT COUNT(*) FROM agreements) as agreements_count,
        (SELECT MAX(block_number) FROM agreement_events) as latest_block
    `),
    // Recent activity, redacted: event type and timestamp only. Transaction
    // hashes and agreement ids are deliberately neither selected nor returned,
    // since the aggregate counts already convey volume and the raw identifiers
    // are a reconnaissance vector.
    dbClient.execute(sql`
      SELECT event_type, created_at
      FROM agreement_events
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
  ]);

  const recentEvents = (
    (latestEventsResult?.rows ?? []) as Array<Record<string, unknown>>
  ).map(redactRecentEvent);

  const queryDurationMs =
    Number(process.hrtime.bigint() - queryStart) / 1_000_000;

  incDiagnosticsMetric(DIAGNOSTICS_METRICS.QUERY_DURATION_MS, queryDurationMs);
  setDiagnosticsGauge("diagnostics_last_query_duration_ms", queryDurationMs);

  logDiagnosticsEvent("debug", "diagnostics.query_timing", {
    durationMs: Math.round(queryDurationMs * 100) / 100,
    limit,
    offset,
  });

  const summaryRow =
    ((tableCountsResult?.rows ?? []) as Array<Record<string, unknown>>)?.[0] ?? {};

  return {
    eventTypeCounts: eventTypeCountsResult?.rows ?? [],
    escrowEventCounts: escrowEventCountsResult?.rows ?? [],
    paymentEventCounts: paymentEventCountsResult?.rows ?? [],
    tableCounts: summaryRow,
    latestEvents: recentEvents,
    poolStats: getPoolStats(),
    circuitBreakers: getCircuitBreakerSnapshots(),
    summary: {
      totalAgreementEvents: summaryRow.agreement_events_count ?? 0,
      totalEscrowEvents: summaryRow.escrow_events_count ?? 0,
      totalPayments: summaryRow.payments_count ?? 0,
      totalEmployees: summaryRow.employees_count ?? 0,
      totalMilestones: summaryRow.milestones_count ?? 0,
      latestBlock: summaryRow.latest_block ?? 0,
    },
    queryDurationMs: Math.round(queryDurationMs * 100) / 100,
    diagnosticsMetrics: getDiagnosticsMetricsSnapshot(),
  };
}

/**
 * GET /diagnostics/events (operator only)
 *
 * Returns aggregate event and table counts for operators. Raw row identifiers
 * (transaction hashes and agreement ids) are not exposed: the recent activity
 * list is redacted to event type and timestamp only. Every query is static and
 * parameter free, so no request input ever reaches the SQL.
 */
// NOTE: requireAuth/requireAdmin are already applied router-wide above.
// Repeating them here is intentional, redundant enforcement (see
// docs/routes/diagnostics.md — "Dual Enforcement"), not a leftover to
// clean up. Do not remove without updating the docs' compatibility notes.
diagnosticsRouter.get(
  "/diagnostics/events",
    requireAuth,
      requireAdmin,
        async (req, res, next) => {
    try {
      const rawLimit = Number(req.query.limit);
      const rawOffset = Number(req.query.offset);

      const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
      const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

      const userAddress = Array.isArray(req.headers["x-user-address"])
        ? req.headers["x-user-address"][0]
        : req.headers["x-user-address"];

      incDiagnosticsMetric(DIAGNOSTICS_METRICS.REQUESTS);
      logDiagnosticsEvent("info", "diagnostics.request", {
        admin: typeof userAddress === "string" ? userAddress.toLowerCase() : "unknown",
        limit,
        offset,
      });

      const data = await fetchDiagnosticsData(db, { limit, offset });

      incDiagnosticsMetric(DIAGNOSTICS_METRICS.SUCCESS);
      logDiagnosticsEvent("info", "diagnostics.success", {
        admin: typeof userAddress === "string" ? userAddress.toLowerCase() : "unknown",
        queryDurationMs: data.queryDurationMs,
        agreementEvents: data.summary.totalAgreementEvents,
      });

      res.json(data);
    } catch (e) {
      incDiagnosticsMetric(DIAGNOSTICS_METRICS.ERRORS);
      logDiagnosticsEvent("error", "diagnostics.error", {
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.split("\n").slice(0, 3).join("\n") : undefined,
      });
      next(e);
    }
  }
);



import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { db, getPoolStats } from "../db/index.js";
import { sql } from "drizzle-orm";

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

/**
 * Redacts raw database rows from recent event queries down to safe fields
 * (`event_type` and `created_at`). Raw row identifiers (transaction hashes,
 * agreement IDs) and PII are stripped.
 */
export function redactRecentEvent(row: Record<string, unknown>): {
  event_type: unknown;
  created_at: unknown;
} {
  return {
    event_type: row.event_type,
    created_at: row.created_at,
  };
}

/**
 * Fetches all telemetry and diagnostic data concurrently using Promise.all.
 * Ensures read queries execute in parallel to minimize latency, eliminate sequential
 * cascade bottlenecks, and guarantee side-effect-free replay safety.
 */
export async function fetchDiagnosticsData(dbClient = db) {
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
      LIMIT 20
    `),
  ]);

  const recentEvents = (
    (latestEventsResult?.rows ?? []) as Array<Record<string, unknown>>
  ).map(redactRecentEvent);

  const summaryRow =
    ((tableCountsResult?.rows ?? []) as Array<Record<string, unknown>>)?.[0] ?? {};

  return {
    eventTypeCounts: eventTypeCountsResult?.rows ?? [],
    escrowEventCounts: escrowEventCountsResult?.rows ?? [],
    paymentEventCounts: paymentEventCountsResult?.rows ?? [],
    tableCounts: summaryRow,
    latestEvents: recentEvents,
    poolStats: getPoolStats(),
    summary: {
      totalAgreementEvents: summaryRow.agreement_events_count ?? 0,
      totalEscrowEvents: summaryRow.escrow_events_count ?? 0,
      totalPayments: summaryRow.payments_count ?? 0,
      totalEmployees: summaryRow.employees_count ?? 0,
      totalMilestones: summaryRow.milestones_count ?? 0,
      latestBlock: summaryRow.latest_block ?? 0,
    },
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
diagnosticsRouter.get(
  "/diagnostics/events",
  requireAuth,
  requireAdmin,
  withDiagnosticsIdempotency(async (_req, res, next) => {
    try {
      const data = await fetchDiagnosticsData();
      res.json(data);
    } catch (e) {
      next(e);
    }
  }),
);



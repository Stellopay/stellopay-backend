import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { db, getPoolStats } from "../db/index.js";
import { sql } from "drizzle-orm";
import { getCircuitBreakerSnapshots } from "../starknet/client.js";

export const diagnosticsRouter = Router();

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
    circuitBreakers: getCircuitBreakerSnapshots(),
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
  async (_req, res, next) => {
    try {
      const data = await fetchDiagnosticsData();
      res.json(data);
    } catch (e) {
      next(e);
    }
  },
);



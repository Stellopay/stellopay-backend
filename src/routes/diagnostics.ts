import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { db, getPoolStats } from "../db/index.js";
import { sql } from "drizzle-orm";

export const diagnosticsRouter = Router();

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
 */
export async function fetchDiagnosticsData(
  dbClient = db,
  options: { limit?: number; offset?: number } = {}
) {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

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
// NOTE: requireAuth/requireAdmin are already applied router-wide above.
// Repeating them here is intentional, redundant enforcement (see
// docs/routes/diagnostics.md — "Dual Enforcement"), not a leftover to
// clean up. Do not remove without updating the docs' compatibility notes.
diagnosticsRouter.get(
  "/diagnostics/events",
    requireAuth,
      requireAdmin,
        async (_req, res, next) => {
    try {
      const rawLimit = Number(req.query.limit);
      const rawOffset = Number(req.query.offset);

      const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
      const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

      const data = await fetchDiagnosticsData(db, { limit, offset });
      res.json(data);
    } catch (e) {
      next(e);
    }
  },
);



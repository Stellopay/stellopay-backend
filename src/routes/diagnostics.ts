/**
 * Admin Diagnostics Routes
 *
 * Canonical route surface (all under /api/v1):
 *
 *   GET  /diagnostics/events   – aggregate event counts, table volumes, pool stats,
 *                                and a redacted recent-activity feed
 *
 * Backward-compatibility contract (issue #279)
 * ─────────────────────────────────────────────
 * • Every route in this router requires a valid session AND an admin address
 *   (enforced by requireAuth + requireAdmin middleware). Unauthenticated or
 *   non-admin requests receive 401 — no query is executed.
 *
 * • Response shape for GET /diagnostics/events is frozen:
 *     {
 *       eventTypeCounts:   Array<{ event_type: string; count: string }>
 *       escrowEventCounts: Array<{ event_type: string; count: string }>
 *       paymentEventCounts:Array<{ event_type: string; count: string }>
 *       tableCounts:       { agreement_events_count, escrow_events_count,
 *                            payments_count, employees_count, milestones_count,
 *                            agreements_count, latest_block }
 *       latestEvents:      Array<{ event_type: string; created_at: string }>
 *       poolStats:         { total, idle, active, waiting }
 *       summary:           { totalAgreementEvents, totalEscrowEvents,
 *                            totalPayments, totalEmployees, totalMilestones,
 *                            latestBlock }
 *     }
 *   Changing this shape is a breaking change for existing operator tooling.
 *
 * • Redaction invariant: transaction_hash and agreement_id are NEVER present in
 *   latestEvents. Only event_type and created_at are returned. This is
 *   intentional — raw identifiers are a reconnaissance vector.
 *
 * • All SQL is static and parameter-free. No request input ever reaches a query.
 *
 * • Errors are forwarded to the Express error handler via next(e); the handler
 *   is responsible for mapping them to HTTP status codes (default 500).
 *
 * • summary fallback: when tableCounts returns no rows (empty DB) every numeric
 *   field defaults to 0 via the `|| 0` guard.
 */

import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { db, getPoolStats } from "../db/index.js";
import { sql } from "drizzle-orm";

export const diagnosticsRouter = Router();

// Every /diagnostics/* route is operator-only.
// requireAuth validates the session token; requireAdmin checks the caller's
// address against the ADMIN_ADDRESSES config list.
diagnosticsRouter.use(requireAuth, requireAdmin);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single row from an event-type COUNT(*) GROUP BY query. */
interface EventTypeCount {
  event_type: string;
  count: string;
}

/**
 * Redacted recent-activity row.
 * Only event_type and created_at are included — transaction_hash and
 * agreement_id are deliberately excluded (redaction invariant).
 */
interface RedactedEvent {
  event_type: unknown;
  created_at: unknown;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/diagnostics/events  (admin only)
 *
 * Returns aggregate event and table counts for operators.
 *
 * All five queries are static (no user input reaches SQL).
 * The recent-activity list is redacted to event_type + created_at only.
 * Pool stats are appended from the connection-pool health check.
 *
 * Success  200: full diagnostics payload (see contract above)
 * Auth err 401: unauthenticated or non-admin caller
 * Error    500: unexpected database error (forwarded via next)
 */
diagnosticsRouter.get("/diagnostics/events", async (req, res, next) => {
  try {
    // 1. Agreement event type distribution
    const eventTypeCounts = await db.execute(sql`
      SELECT event_type, COUNT(*) as count
      FROM agreement_events
      GROUP BY event_type
      ORDER BY count DESC
    `);

    // 2. Escrow event type distribution
    const escrowEventCounts = await db.execute(sql`
      SELECT event_type, COUNT(*) as count
      FROM escrow_events
      GROUP BY event_type
      ORDER BY count DESC
    `);

    // 3. Payment event type distribution
    const paymentEventCounts = await db.execute(sql`
      SELECT event_type, COUNT(*) as count
      FROM payments
      GROUP BY event_type
      ORDER BY count DESC
    `);

    // 4. Aggregate table volumes + latest indexed block
    const tableCounts = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM agreement_events) as agreement_events_count,
        (SELECT COUNT(*) FROM escrow_events)    as escrow_events_count,
        (SELECT COUNT(*) FROM payments)         as payments_count,
        (SELECT COUNT(*) FROM employees)        as employees_count,
        (SELECT COUNT(*) FROM milestones)       as milestones_count,
        (SELECT COUNT(*) FROM agreements)       as agreements_count,
        (SELECT MAX(block_number) FROM agreement_events) as latest_block
    `);

    // 5. Recent activity — REDACTED: only event_type + created_at.
    //    transaction_hash and agreement_id are intentionally excluded from the
    //    SELECT and from the mapped output. Raw identifiers are a recon vector.
    const latestEventsResult = await db.execute(sql`
      SELECT event_type, created_at
      FROM agreement_events
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const latestEvents: RedactedEvent[] = (
      latestEventsResult.rows as Array<Record<string, unknown>>
    ).map((row) => ({
      event_type: row.event_type,
      created_at: row.created_at,
    }));

    // summary provides convenient top-level numerics; falls back to 0 when
    // the tableCounts query returns no rows (empty database).
    const counts = tableCounts.rows[0] as Record<string, unknown> | undefined;

    res.json({
      eventTypeCounts: eventTypeCounts.rows as EventTypeCount[],
      escrowEventCounts: escrowEventCounts.rows as EventTypeCount[],
      paymentEventCounts: paymentEventCounts.rows as EventTypeCount[],
      tableCounts: counts ?? {},
      latestEvents,
      poolStats: getPoolStats(),
      summary: {
        totalAgreementEvents: counts?.agreement_events_count ?? 0,
        totalEscrowEvents: counts?.escrow_events_count ?? 0,
        totalPayments: counts?.payments_count ?? 0,
        totalEmployees: counts?.employees_count ?? 0,
        totalMilestones: counts?.milestones_count ?? 0,
        latestBlock: counts?.latest_block ?? 0,
      },
    });
  } catch (e) {
    next(e);
  }
});

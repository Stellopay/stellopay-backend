import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { db, getPoolStats } from "../db/index.js";
import { sql } from "drizzle-orm";

export const diagnosticsRouter = Router();

// Diagnostics expose internal data shapes and volumes, so the whole router is
// operator only: every /diagnostics/* route requires a valid session and an
// admin address.
diagnosticsRouter.use(requireAuth, requireAdmin);

/**
 * GET /diagnostics/events (operator only)
 *
 * Returns aggregate event and table counts for operators. Raw row identifiers
 * (transaction hashes and agreement ids) are not exposed: the recent activity
 * list is redacted to event type and timestamp only. Every query is static and
 * parameter free, so no request input ever reaches the SQL.
 */
diagnosticsRouter.get("/diagnostics/events", async (req, res, next) => {
  try {
    // Get event type counts
    const eventTypeCounts = await db.execute(sql`
      SELECT event_type, COUNT(*) as count 
      FROM agreement_events 
      GROUP BY event_type 
      ORDER BY count DESC
    `);

    // Get escrow event counts
    const escrowEventCounts = await db.execute(sql`
      SELECT event_type, COUNT(*) as count 
      FROM escrow_events 
      GROUP BY event_type 
      ORDER BY count DESC
    `);

    // Get payment event counts
    const paymentEventCounts = await db.execute(sql`
      SELECT event_type, COUNT(*) as count 
      FROM payments 
      GROUP BY event_type 
      ORDER BY count DESC
    `);

    // Get table counts
    const tableCounts = await db.execute(sql`
      SELECT 
        (SELECT COUNT(*) FROM agreement_events) as agreement_events_count,
        (SELECT COUNT(*) FROM escrow_events) as escrow_events_count,
        (SELECT COUNT(*) FROM payments) as payments_count,
        (SELECT COUNT(*) FROM employees) as employees_count,
        (SELECT COUNT(*) FROM milestones) as milestones_count,
        (SELECT COUNT(*) FROM agreements) as agreements_count,
        (SELECT MAX(block_number) FROM agreement_events) as latest_block
    `);

    // Recent activity, redacted: event type and timestamp only. Transaction
    // hashes and agreement ids are deliberately neither selected nor returned,
    // since the aggregate counts already convey volume and the raw identifiers
    // are a reconnaissance vector.
    const latestEvents = await db.execute(sql`
      SELECT event_type, created_at
      FROM agreement_events
      ORDER BY created_at DESC
      LIMIT 20
    `);
    const recentEvents = (latestEvents.rows as Array<Record<string, unknown>>).map((row) => ({
      event_type: row.event_type,
      created_at: row.created_at,
    }));

    res.json({
      eventTypeCounts: eventTypeCounts.rows,
      escrowEventCounts: escrowEventCounts.rows,
      paymentEventCounts: paymentEventCounts.rows,
      tableCounts: tableCounts.rows[0],
      latestEvents: recentEvents,
      poolStats: getPoolStats(),
      summary: {
        totalAgreementEvents: tableCounts.rows[0]?.agreement_events_count || 0,
        totalEscrowEvents: tableCounts.rows[0]?.escrow_events_count || 0,
        totalPayments: tableCounts.rows[0]?.payments_count || 0,
        totalEmployees: tableCounts.rows[0]?.employees_count || 0,
        totalMilestones: tableCounts.rows[0]?.milestones_count || 0,
        latestBlock: tableCounts.rows[0]?.latest_block || 0,
      },
    });
  } catch (e) {
    next(e);
  }
});

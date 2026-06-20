import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { db, schema } from "../db/index.js";
import { sql } from "drizzle-orm";

export const diagnosticsRouter = Router();

// Comprehensive diagnostic endpoint
diagnosticsRouter.get("/diagnostics/events", requireAuth, requireAdmin, async (req, res, next) => {
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

    // Get latest events by type
    const latestEvents = await db.execute(sql`
      SELECT event_type, transaction_hash, agreement_id, created_at
      FROM agreement_events
      ORDER BY created_at DESC
      LIMIT 20
    `);

    res.json({
      eventTypeCounts: eventTypeCounts.rows,
      escrowEventCounts: escrowEventCounts.rows,
      paymentEventCounts: paymentEventCounts.rows,
      tableCounts: tableCounts.rows[0],
      latestEvents: latestEvents.rows,
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








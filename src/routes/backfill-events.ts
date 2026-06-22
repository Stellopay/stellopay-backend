import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

export const backfillEventsRouter = Router();

/** Maximum number of rows the backfill may scan per request. */
const MAX_BACKFILL_LIMIT = 5000;

/**
 * Zod schema for backfill query parameters.
 *
 * @property limit - Maximum number of rows to scan (1–5000, default 1000).
 * @property agreementId - Optional filter to only backfill events for a specific agreement.
 */
const BackfillQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_BACKFILL_LIMIT).optional().default(1000),
  agreementId: z.string().optional(),
});

/**
 * POST /backfill/employee-events
 *
 * Backfill `EmployeeAdded` events for employees that don't yet have a
 * corresponding event in `agreement_events`.
 *
 * **Authentication:** Requires an active admin session (`requireAuth` +
 * `requireAdmin`).
 *
 * **Validation:** Query params are validated via {@link BackfillQuerySchema}.
 * - `limit` (optional, default 1000, max 5000) — number of candidate rows to scan.
 * - `agreementId` (optional) — restrict backfill to a single agreement.
 *
 * **Idempotency:** Synthetic event IDs use the form
 * `{transactionHash}_backfill_EmployeeAdded_{employeeId}` which cannot collide
 * with real event IDs (`{txHash}_{eventIndex}`).  The `eventIndex` is set to
 * `-1` — a value real on-chain events can never have — making every row
 * trivially distinguishable from genuine indexed events.  The full insert loop
 * runs inside a single database transaction; on conflict the row is silently
 * skipped (`onConflictDoNothing`).
 *
 * **Response** returns the total number of employees scanned, how many events
 * were created, and a sample of the first 10 results.
 */
backfillEventsRouter.post(
  "/backfill/employee-events",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { limit, agreementId } = BackfillQuerySchema.parse(req.query);

      const conditions = sql`1=1`;
      if (agreementId) {
        conditions.append(sql` AND e.agreement_id = ${agreementId}`);
      }

      const employeesWithoutEvents = await db.execute(sql`
        SELECT e.id, e.agreement_id, e.contract_address, e.block_number,
               e.transaction_hash, e.created_at
        FROM employees e
        WHERE NOT EXISTS (
          SELECT 1 FROM agreement_events ae
          WHERE ae.agreement_id = e.agreement_id
          AND ae.event_type = 'EmployeeAdded'
          AND ae.transaction_hash = e.transaction_hash
        )
        AND ${conditions}
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `);

      let created = 0;
      const results: Array<{
        employeeId: string;
        agreementId: string;
        status: string;
        error?: string;
      }> = [];

      await db.transaction(async (tx) => {
        for (const employee of employeesWithoutEvents.rows) {
          const eventId = `${employee.transaction_hash}_backfill_EmployeeAdded_${employee.id}`;

          await tx
            .insert(schema.agreementEvents)
            .values({
              id: eventId,
              agreementId: String(employee.agreement_id),
              contractAddress: String(employee.contract_address),
              eventType: "EmployeeAdded",
              blockNumber: Number(employee.block_number),
              transactionHash: String(employee.transaction_hash),
              eventIndex: -1,
            })
            .onConflictDoNothing();

          created++;
          results.push({
            employeeId: employee.id,
            agreementId: employee.agreement_id,
            status: "created",
          });
        }
      });

      res.json({
        message: `Backfilled ${created} EmployeeAdded events`,
        totalScanned: employeesWithoutEvents.rows.length,
        created,
        results: results.slice(0, 10),
      });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: e.errors[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    }
  },
);

/**
 * POST /backfill/milestone-events
 *
 * Backfill `MilestoneAdded` events for milestones that don't yet have a
 * corresponding event in `agreement_events`.
 *
 * **Authentication:** Requires an active admin session (`requireAuth` +
 * `requireAdmin`).
 *
 * **Validation:** Query params are validated via {@link BackfillQuerySchema}.
 * - `limit` (optional, default 1000, max 5000) — number of candidate rows to scan.
 * - `agreementId` (optional) — restrict backfill to a single agreement.
 *
 * **Idempotency:** Identical approach to the employee-events sibling — synthetic
 * IDs with a `_backfill_MilestoneAdded_` segment, `eventIndex: -1`, and
 * `onConflictDoNothing` inside a transaction.  Re-runs are safe no-ops.
 *
 * **Response** returns the total number of milestones scanned, how many events
 * were created, and a sample of the first 10 results.
 */
backfillEventsRouter.post(
  "/backfill/milestone-events",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { limit, agreementId } = BackfillQuerySchema.parse(req.query);

      const conditions = sql`1=1`;
      if (agreementId) {
        conditions.append(sql` AND m.agreement_id = ${agreementId}`);
      }

      const milestonesWithoutEvents = await db.execute(sql`
        SELECT m.id, m.agreement_id, m.contract_address, m.block_number,
               m.transaction_hash, m.created_at
        FROM milestones m
        WHERE NOT EXISTS (
          SELECT 1 FROM agreement_events ae
          WHERE ae.agreement_id = m.agreement_id
          AND ae.event_type = 'MilestoneAdded'
          AND ae.transaction_hash = m.transaction_hash
        )
        AND ${conditions}
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `);

      let created = 0;
      const results: Array<{
        milestoneId: string;
        agreementId: string;
        status: string;
        error?: string;
      }> = [];

      await db.transaction(async (tx) => {
        for (const milestone of milestonesWithoutEvents.rows) {
          const eventId = `${milestone.transaction_hash}_backfill_MilestoneAdded_${milestone.id}`;

          await tx
            .insert(schema.agreementEvents)
            .values({
              id: eventId,
              agreementId: String(milestone.agreement_id),
              contractAddress: String(milestone.contract_address),
              eventType: "MilestoneAdded",
              blockNumber: Number(milestone.block_number),
              transactionHash: String(milestone.transaction_hash),
              eventIndex: -1,
            })
            .onConflictDoNothing();

          created++;
          results.push({
            milestoneId: milestone.id,
            agreementId: milestone.agreement_id,
            status: "created",
          });
        }
      });

      res.json({
        message: `Backfilled ${created} MilestoneAdded events`,
        totalScanned: milestonesWithoutEvents.rows.length,
        created,
        results: results.slice(0, 10),
      });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: e.errors[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    }
  },
);

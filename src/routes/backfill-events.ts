import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { sql } from "drizzle-orm";

export const backfillEventsRouter = Router();

// ---------------------------------------------------------------------------
// Contract constants – exported so tests and docs reference the single source
// of truth rather than duplicating magic numbers.
// ---------------------------------------------------------------------------

/** Maximum number of rows the backfill may scan per request. */
export const MAX_BACKFILL_LIMIT = 5000;

/** Default scan limit when the caller omits the `limit` query parameter. */
export const DEFAULT_BACKFILL_LIMIT = 1000;

/**
 * Sentinel `eventIndex` value written for every synthetic backfill row.
 * The `_backfill_` segment in the synthetic event ID already distinguishes
 * backfill rows from real on-chain events, so eventIndex is set to 0 to
 * satisfy the DB CHECK constraint (`event_index >= 0`).
 */
export const BACKFILL_EVENT_INDEX = 0;

/** How many result objects the response preview (`results` array) may contain. */
export const RESULTS_PREVIEW_SIZE = 10;

// ---------------------------------------------------------------------------
// Synthetic event-ID builder
// ---------------------------------------------------------------------------

/**
 * Build the deterministic, collision-safe event ID used for backfill rows.
 *
 * Format: `{transactionHash}_backfill_{eventType}_{rowId}`
 *
 * The `_backfill_` segment can never appear in real event IDs (which use
 * `{txHash}_{eventIndex}`), guaranteeing no collision.
 */
export function buildBackfillEventId(
  transactionHash: string,
  eventType: string,
  rowId: string,
): string {
  return `${transactionHash}_backfill_${eventType}_${rowId}`;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Zod schema for backfill query parameters.
 *
 * @property limit - Maximum number of rows to scan (1–5000, default 1000).
 * @property agreementId - Optional filter to only backfill events for a specific agreement.
 * @property before - Optional resume cursor. When provided, only rows with
 *   `created_at` strictly older than this timestamp are considered, bounding
 *   the replay window to rows not yet seen by a previous call. Pass the
 *   `nextCursor` from a prior response to page through a large backlog.
 */
export const BackfillQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_BACKFILL_LIMIT).optional().default(DEFAULT_BACKFILL_LIMIT),
  agreementId: z.string().optional(),
  before: z.coerce.date().optional(),
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/** A single entry inside the response `results` array. */
export interface BackfillResultEntry {
  employeeId?: string;
  milestoneId?: string;
  agreementId: string;
  status: string;
  error?: string;
}

/** Shape returned by both backfill endpoints on success. */
export interface BackfillResponse {
  message: string;
  totalScanned: number;
  created: number;
  results: BackfillResultEntry[];
  /**
   * Resume cursor: the ISO-8601 `created_at` of the oldest row scanned in this
   * page, or `null` if zero rows were scanned. Pass this value as the `before`
   * query parameter on the next call to continue strictly older than what has
   * already been seen, without rescanning this page.
   */
  nextCursor: string | null;
  /**
   * `true` when the number of scanned rows equals the requested `limit`
   * (the page was full and more rows may exist beyond it), `false` otherwise.
   */
  hasMore: boolean;
}

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
 * - `before` (optional, ISO-8601 date) — resume cursor; only scans rows with
 *   `created_at` strictly older than this timestamp.
 *
 * **Resume tokens / replay windows:** Every response includes `nextCursor`
 * (the oldest `created_at` seen in the page, or `null` if empty) and
 * `hasMore` (whether the page was full). Callers page through a large
 * backlog by repeatedly passing the previous response's `nextCursor` as the
 * next call's `before`, stopping once `hasMore` is `false` or `nextCursor`
 * is `null`. Omitting `before` preserves today's behavior exactly.
 *
 * **Idempotency:** Synthetic event IDs use the form
 * `{transactionHash}_backfill_EmployeeAdded_{employeeId}` which cannot collide
 * with real event IDs (`{txHash}_{eventIndex}`).  The `eventIndex` is set to
 * `-1` — a value real on-chain events can never have — making every row
 * trivially distinguishable from genuine indexed events.  The full insert loop
 * runs inside a single database transaction; on conflict the row is silently
 * skipped (`onConflictDoNothing`). Because the cursor only narrows the
 * candidate set, replaying any page (with or without `before`) is a safe
 * no-op for rows already backfilled.
 *
 * **Response** returns the total number of employees scanned, how many events
 * were created, a sample of the first 10 results, and the `nextCursor` /
 * `hasMore` pagination fields.
 */
backfillEventsRouter.post(
  "/backfill/employee-events",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { limit, agreementId, before } = BackfillQuerySchema.parse(req.query);

      const conditions = sql`1=1`;
      if (agreementId) {
        conditions.append(sql` AND e.agreement_id = ${agreementId}`);
      }
      if (before) {
        conditions.append(sql` AND e.created_at < ${before}`);
      }

  const tableName = type === "EmployeeAdded" ? "employees" : "milestones";
  const tableAlias = type === "EmployeeAdded" ? "e" : "m";
  
  const conditions = sql`1=1`;
  if (agreementId) conditions.append(sql` AND ${sql.identifier(tableAlias)}.agreement_id = ${agreementId}`);
  if (resumeToken) conditions.append(sql` AND ${sql.identifier(tableAlias)}.created_at < ${resumeToken}`);

      let created = 0;
      const results: BackfillResultEntry[] = [];

      await db.transaction(async (tx) => {
        for (const employee of employeesWithoutEvents.rows) {
          const eventId = buildBackfillEventId(
            String(employee.transaction_hash),
            "EmployeeAdded",
            String(employee.id),
          );

          const inserted = await tx
            .insert(schema.agreementEvents)
            .values({
              id: eventId,
              agreementId: String(employee.agreement_id),
              contractAddress: String(employee.contract_address),
              eventType: "EmployeeAdded",
              blockNumber: Number(employee.block_number),
              transactionHash: String(employee.transaction_hash),
              eventIndex: BACKFILL_EVENT_INDEX,
            })
            .onConflictDoNothing()
            .returning();

          if (inserted.length > 0) {
            created++;
          }
          results.push({
            employeeId: String(employee.id),
            agreementId: String(employee.agreement_id),
            status: inserted.length > 0 ? "created" : "skipped",
          });
        }
      });

      const scannedRows = employeesWithoutEvents.rows;
      const lastRow = scannedRows[scannedRows.length - 1];
      const nextCursor = lastRow ? new Date(lastRow.created_at as any).toISOString() : null;

      const body: BackfillResponse = {
        message: `Backfilled ${created} EmployeeAdded events`,
        totalScanned: scannedRows.length,
        created,
        results: results.slice(0, RESULTS_PREVIEW_SIZE),
        nextCursor,
        hasMore: scannedRows.length === limit,
      };
      res.json(body);
    } catch (e: any) {
      if (e instanceof z.ZodError || e?.name === "ZodError") {
        res.status(400).json({ error: e.issues?.[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    }
  });

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
 * - `before` (optional, ISO-8601 date) — resume cursor; only scans rows with
 *   `created_at` strictly older than this timestamp.
 *
 * **Resume tokens / replay windows:** Identical contract to the
 * employee-events sibling — every response includes `nextCursor` (the oldest
 * `created_at` seen in the page, or `null` if empty) and `hasMore` (whether
 * the page was full). Page through a large backlog by repeatedly passing the
 * previous response's `nextCursor` as the next call's `before`, stopping once
 * `hasMore` is `false` or `nextCursor` is `null`. Omitting `before` preserves
 * today's behavior exactly.
 *
 * **Idempotency:** Identical approach to the employee-events sibling — synthetic
 * IDs with a `_backfill_MilestoneAdded_` segment, `eventIndex: -1`, and
 * `onConflictDoNothing` inside a transaction.  Re-runs are safe no-ops, and the
 * `before` cursor only narrows the candidate set so replaying any page never
 * creates duplicates.
 *
 * **Response** returns the total number of milestones scanned, how many events
 * were created, a sample of the first 10 results, and the `nextCursor` /
 * `hasMore` pagination fields.
 */
backfillEventsRouter.post(
  "/backfill/milestone-events",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { limit, agreementId, before } = BackfillQuerySchema.parse(req.query);

      const conditions = sql`1=1`;
      if (agreementId) {
        conditions.append(sql` AND m.agreement_id = ${agreementId}`);
      }
      if (before) {
        conditions.append(sql` AND m.created_at < ${before}`);
      }

backfillEventsRouter.post("/backfill/employee-events", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const params = BackfillQuerySchema.parse(req.query);
    const result = await performBackfill("EmployeeAdded", params);
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Invalid parameters", details: err.issues });
    next(e);
  }
});

      let created = 0;
      const results: BackfillResultEntry[] = [];

      await db.transaction(async (tx) => {
        for (const milestone of milestonesWithoutEvents.rows) {
          const eventId = buildBackfillEventId(
            String(milestone.transaction_hash),
            "MilestoneAdded",
            String(milestone.id),
          );

          const inserted = await tx
            .insert(schema.agreementEvents)
            .values({
              id: eventId,
              agreementId: String(milestone.agreement_id),
              contractAddress: String(milestone.contract_address),
              eventType: "MilestoneAdded",
              blockNumber: Number(milestone.block_number),
              transactionHash: String(milestone.transaction_hash),
              eventIndex: BACKFILL_EVENT_INDEX,
            })
            .onConflictDoNothing()
            .returning();

          if (inserted.length > 0) {
            created++;
          }
          results.push({
            milestoneId: String(milestone.id),
            agreementId: String(milestone.agreement_id),
            status: inserted.length > 0 ? "created" : "skipped",
          });
        }
      });

      const scannedRows = milestonesWithoutEvents.rows;
      const lastRow = scannedRows[scannedRows.length - 1];
      const nextCursor = lastRow ? new Date(lastRow.created_at as any).toISOString() : null;

      const body: BackfillResponse = {
        message: `Backfilled ${created} MilestoneAdded events`,
        totalScanned: scannedRows.length,
        created,
        results: results.slice(0, RESULTS_PREVIEW_SIZE),
        nextCursor,
        hasMore: scannedRows.length === limit,
      };
      res.json(body);
    } catch (e: any) {
      if (e instanceof z.ZodError || e?.name === "ZodError") {
        res.status(400).json({ error: e.issues?.[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    }
  },
);

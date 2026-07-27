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

const optionalDateSchema = z.preprocess((val) => {
  if (val === undefined || val === null || val === "") return undefined;
  const d = new Date(val as string);
  if (isNaN(d.getTime())) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        message: "Invalid date format for cursor/resume token",
        path: [],
      },
    ]);
  }
  return d;
}, z.date().optional());

/**
 * Zod schema for backfill query parameters.
 *
 * @property limit - Maximum number of rows to scan (1–5000, default 1000).
 * @property agreementId - Optional filter to only backfill events for a specific agreement.
 * @property before - Optional resume cursor / replay window boundary.
 * @property resumeToken - Alias for before.
 * @property cursor - Alias for before.
 */
export const BackfillQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int({ message: "Limit must be an integer" })
    .positive({ message: "Limit must be positive" })
    .max(MAX_BACKFILL_LIMIT, { message: `Limit cannot exceed ${MAX_BACKFILL_LIMIT}` })
    .optional()
    .default(DEFAULT_BACKFILL_LIMIT),
  agreementId: z.string().optional(),
  before: optionalDateSchema,
  resumeToken: optionalDateSchema,
  cursor: optionalDateSchema,
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
   * page, or `null` if zero rows were scanned. Pass this value as `before`,
   * `resumeToken`, or `cursor` on the next call to continue paging.
   */
  nextCursor: string | null;
  /** Compatibility alias for nextCursor. */
  nextResumeToken: string | null;
  /** Compatibility alias for nextCursor. */
  cursor: string | null;
  /**
   * `true` when the number of scanned rows equals the requested `limit`
   * (the page was full and more rows may exist beyond it), `false` otherwise.
   */
  hasMore: boolean;
  /** Performance metric: execution duration in milliseconds. */
  durationMs: number;
}

export type BackfillEventType = "EmployeeAdded" | "MilestoneAdded";

export type BackfillQueryParams = z.infer<typeof BackfillQuerySchema>;

// ---------------------------------------------------------------------------
// Shared performance-optimized backfill executor
// ---------------------------------------------------------------------------

/**
 * Perform event backfilling for a given event type with batching and performance metrics.
 */
export async function performBackfill(
  eventType: BackfillEventType,
  params: BackfillQueryParams,
): Promise<BackfillResponse> {
  const startTime = performance.now();
  const { limit, agreementId, before, resumeToken, cursor } = params;

  // Prefer before, then resumeToken, then cursor
  const resumeDate = before ?? resumeToken ?? cursor;

  const isEmployee = eventType === "EmployeeAdded";
  const tableAlias = isEmployee ? "e" : "m";

  const conditions = sql`1=1`;
  if (agreementId) {
    conditions.append(sql` AND ${sql.identifier(tableAlias)}.agreement_id = ${agreementId}`);
  }
  if (resumeDate) {
    conditions.append(sql` AND ${sql.identifier(tableAlias)}.created_at < ${resumeDate}`);
  }

  const candidateQuery = isEmployee
    ? sql`
        SELECT e.id, e.agreement_id, e.contract_address, e.block_number,
               e.transaction_hash, e.created_at
        FROM employees e
        LEFT JOIN agreement_events ae
          ON ae.transaction_hash = e.transaction_hash
         AND ae.event_type = 'EmployeeAdded'
        WHERE ae.id IS NULL AND ${conditions}
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `
    : sql`
        SELECT m.id, m.agreement_id, m.contract_address, m.block_number,
               m.transaction_hash, m.created_at
        FROM milestones m
        LEFT JOIN agreement_events ae
          ON ae.transaction_hash = m.transaction_hash
         AND ae.event_type = 'MilestoneAdded'
        WHERE ae.id IS NULL AND ${conditions}
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `;

  const queryResult = await db.execute(candidateQuery);
  const scannedRows = (queryResult.rows || []) as any[];

  let createdCount = 0;
  const results: BackfillResultEntry[] = [];

  if (scannedRows.length > 0) {
    const insertValues = scannedRows.map((row) => {
      const eventId = buildBackfillEventId(
        String(row.transaction_hash),
        eventType,
        String(row.id),
      );
      return {
        id: eventId,
        agreementId: String(row.agreement_id),
        contractAddress: String(row.contract_address),
        eventType,
        blockNumber: Number(row.block_number),
        transactionHash: String(row.transaction_hash),
        eventIndex: BACKFILL_EVENT_INDEX,
      };
    });

    let insertedRows: any[] = [];
    await db.transaction(async (tx) => {
      insertedRows = await tx
        .insert(schema.agreementEvents)
        .values(insertValues)
        .onConflictDoNothing()
        .returning();
    });

    const insertedIds = new Set(insertedRows.map((r) => String(r.id)));

    for (const row of scannedRows) {
      const eventId = buildBackfillEventId(
        String(row.transaction_hash),
        eventType,
        String(row.id),
      );
      const isCreated = insertedIds.has(eventId);
      if (isCreated) {
        createdCount++;
      }

      const entry: BackfillResultEntry = {
        agreementId: String(row.agreement_id),
        status: isCreated ? "created" : "skipped",
      };
      if (isEmployee) {
        entry.employeeId = String(row.id);
      } else {
        entry.milestoneId = String(row.id);
      }
      results.push(entry);
    }
  }

  const lastRow = scannedRows[scannedRows.length - 1];
  const nextCursorIso = lastRow ? new Date(lastRow.created_at).toISOString() : null;
  const durationMs = Math.round(performance.now() - startTime);

  const op = isEmployee ? "backfill_employee_events" : "backfill_milestone_events";
  console.info({
    op,
    scanned: scannedRows.length,
    created: createdCount,
    durationMs,
    nextResumeToken: nextCursorIso,
  });

  return {
    message: `Backfilled ${createdCount} ${eventType} events`,
    totalScanned: scannedRows.length,
    created: createdCount,
    results: results.slice(0, RESULTS_PREVIEW_SIZE),
    nextCursor: nextCursorIso,
    nextResumeToken: nextCursorIso,
    cursor: nextCursorIso,
    hasMore: scannedRows.length === limit,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

/**
 * POST /backfill/employee-events
 *
 * Backfill `EmployeeAdded` events for employees that don't yet have a
 * corresponding event in `agreement_events`.
 */
backfillEventsRouter.post(
  "/backfill/employee-events",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const params = BackfillQuerySchema.parse(req.query);
      const response = await performBackfill("EmployeeAdded", params);
      res.json(response);
    } catch (e: any) {
      if (e instanceof z.ZodError || e?.name === "ZodError") {
        res.status(400).json({ error: e.issues?.[0]?.message || "Invalid request parameters" });
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
 */
backfillEventsRouter.post(
  "/backfill/milestone-events",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const params = BackfillQuerySchema.parse(req.query);
      const response = await performBackfill("MilestoneAdded", params);
      res.json(response);
    } catch (e: any) {
      if (e instanceof z.ZodError || e?.name === "ZodError") {
        res.status(400).json({ error: e.issues?.[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    }
  },
);

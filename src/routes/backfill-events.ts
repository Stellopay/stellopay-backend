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

export interface BackfillResultEntry {
  employeeId?: string;
  milestoneId?: string;
  agreementId: string;
  status: string;
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

// ---------------------------------------------------------------------------
// Shared backfill logic
// ---------------------------------------------------------------------------

type BackfillKind = "employees" | "milestones";
type BackfillEventType = "EmployeeAdded" | "MilestoneAdded";

interface BackfillRow {
  id: string;
  agreement_id: string;
  contract_address: string;
  block_number: number;
  transaction_hash: string;
  created_at: Date;
}

async function performBackfill(
  kind: BackfillKind,
  eventType: BackfillEventType,
  params: z.infer<typeof BackfillQuerySchema>,
): Promise<BackfillResponse> {
  const { limit, agreementId, before } = params;

  const result = await db.execute<BackfillRow>(sql`
    SELECT ${sql.identifier(kind)}.id,
           ${sql.identifier(kind)}.agreement_id,
           ${sql.identifier(kind)}.contract_address,
           ${sql.identifier(kind)}.block_number,
           ${sql.identifier(kind)}.transaction_hash,
           ${sql.identifier(kind)}.created_at
    FROM ${sql.identifier(kind)}
    LEFT JOIN agreement_events ae
      ON ae.transaction_hash = ${sql.identifier(kind)}.transaction_hash
      AND ae.event_type = ${eventType}
    WHERE ae.id IS NULL
    ${agreementId ? sql`AND ${sql.identifier(kind)}.agreement_id = ${agreementId}` : sql``}
    ${before ? sql`AND ${sql.identifier(kind)}.created_at < ${before}` : sql``}
    ORDER BY ${sql.identifier(kind)}.created_at DESC
    LIMIT ${limit}
  `);

  const scannedRows = result.rows ?? [];
  let created = 0;
  const results: BackfillResultEntry[] = [];

  const startMs = Date.now();

  await db.transaction(async (tx) => {
    for (const row of scannedRows) {
      const eventId = buildBackfillEventId(
        String(row.transaction_hash),
        eventType,
        String(row.id),
      );

      const inserted = await tx
        .insert(schema.agreementEvents)
        .values({
          id: eventId,
          agreementId: String(row.agreement_id),
          contractAddress: String(row.contract_address),
          eventType,
          blockNumber: Number(row.block_number),
          transactionHash: String(row.transaction_hash),
          eventIndex: BACKFILL_EVENT_INDEX,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length > 0) {
        created++;
      }

      const entry: BackfillResultEntry = {
        agreementId: String(row.agreement_id),
        status: inserted.length > 0 ? "created" : "skipped",
      };
      if (kind === "employees") {
        entry.employeeId = String(row.id);
      } else {
        entry.milestoneId = String(row.id);
      }
      results.push(entry);
    }
  });

  const durationMs = Date.now() - startMs;
  const lastRow = scannedRows[scannedRows.length - 1];
  const nextCursor = lastRow ? new Date(lastRow.created_at).toISOString() : null;

  const idLabel = kind === "employees" ? "employee" : "milestone";
  console.info({
    op: `backfill_${idLabel}_events`,
    kind,
    scanned: scannedRows.length,
    created,
    durationMs,
    nextCursor,
    hasMore: scannedRows.length === limit,
  });

  return {
    message: `Backfilled ${created} ${eventType} events`,
    totalScanned: scannedRows.length,
    created,
    results: results.slice(0, RESULTS_PREVIEW_SIZE),
    nextCursor,
    hasMore: scannedRows.length === limit,
  };
}

// ---------------------------------------------------------------------------
// Route: POST /backfill/employee-events
// ---------------------------------------------------------------------------

backfillEventsRouter.post(
  "/backfill/employee-events",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const params = BackfillQuerySchema.parse(req.query);
      const body = await performBackfill("employees", "EmployeeAdded", params);
      res.json(body);
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: e.issues?.[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Route: POST /backfill/milestone-events
// ---------------------------------------------------------------------------

backfillEventsRouter.post(
  "/backfill/milestone-events",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const params = BackfillQuerySchema.parse(req.query);
      const body = await performBackfill("milestones", "MilestoneAdded", params);
      res.json(body);
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: e.issues?.[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    }
  },
);

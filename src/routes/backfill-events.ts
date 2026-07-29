import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { sql, eq } from "drizzle-orm";

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

/**
 * Number of rows inserted per checkpoint. Each batch runs in its own DB
 * transaction that also persists {@link schema.backfillProgress} for the job,
 * so a batch's inserts and its checkpoint commit atomically together — if the
 * process crashes between batches, the last persisted checkpoint always
 * matches what is actually durable in `agreement_events`.
 */
export const BACKFILL_CHECKPOINT_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Resume token freshness bounds (Issue #263)
// ---------------------------------------------------------------------------

/**
 * Clock-skew tolerance when checking whether a resume token is in the
 * future.  Tokens up to this far ahead of `Date.now()` are accepted so
 * that minor differences between client and server clocks don't cause
 * spurious rejections.
 *
 * Tokens beyond this tolerance are rejected with 400 to prevent an
 * attacker from specifying a token that scans the entire table unbounded.
 * The replay window itself is intentionally unbounded in the past —
 * since synthetic event IDs use `ON CONFLICT DO NOTHING`, replaying
 * old tokens is idempotent and harmless.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000; // 60 seconds

// ---------------------------------------------------------------------------
// Job identity
// ---------------------------------------------------------------------------

export type BackfillJobName = "employee-events" | "milestone-events";

export const EMPLOYEE_BACKFILL_JOB: BackfillJobName = "employee-events";
export const MILESTONE_BACKFILL_JOB: BackfillJobName = "milestone-events";
export const BACKFILL_JOB_NAMES: readonly BackfillJobName[] = [
  EMPLOYEE_BACKFILL_JOB,
  MILESTONE_BACKFILL_JOB,
];

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
// Resume cursor normalisation – backward-compatible alias resolution
// ---------------------------------------------------------------------------

/**
 * Normalise the three input aliases (`before`, `resumeToken`, `cursor`)
 * into a single cursor value according to the documented precedence:
 *
 *   `before` → `resumeToken` → `cursor`
 *
 * **Backward-compatibility contract** (Issue #264):
 *
 * 1. Any caller that supplies **one** of the three parameter names will
 *    continue to work unchanged forever.
 * 2. If a caller supplies **more than one**, `before` wins, then
 *    `resumeToken`, then `cursor`.  This is a tiebreaker, not a validation
 *    error — old callers that happen to send both `before` and `resumeToken`
 *    (e.g. a client migrating between parameter names) still get a
 *    deterministic result.
 * 3. `undefined` / `null` / empty-string values are treated as "not
 *    provided" so callers that unconditionally include a cursor parameter
 *    with a blank value do not break.
 * 4. The return value is a `Date` (when a valid cursor was supplied) or
 *    `undefined` (when none was supplied).  Callers should treat
 *    `undefined` as "scan from the beginning / use the persisted
 *    checkpoint".
 *
 * The same three-output-alias contract applies on the response shape:
 * `nextCursor`, `nextResumeToken`, and `cursor` are always identical, so
 * callers may read whichever field they were written against.
 */
export function normalizeResumeCursor(
  before: Date | undefined,
  resumeToken: Date | undefined,
  cursor: Date | undefined,
): Date | undefined {
  return before ?? resumeToken ?? cursor;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validate a resume-token date for freshness bounds.
 *
 * Rejects:
 *  - Future dates beyond {@link CLOCK_SKEW_TOLERANCE_MS} from `Date.now()`
 *    (to prevent an attacker from specifying a token that scans the entire
 *    table unbounded).
 *
 * Past dates are intentionally accepted without bound — since synthetic
 * event IDs use `ON CONFLICT DO NOTHING`, replaying old tokens is
 * idempotent and harmless.  The `_backfill_` segment in the event ID
 * guarantees no collision with real on-chain events.
 *
 * This is the single validation entry-point for `before`, `resumeToken`,
 * and `cursor` — the three aliases that all feed the same replay-window
 * boundary.
 */
export function validateResumeTokenFreshness(date: Date): void {
  const now = Date.now();
  const tokenTime = date.getTime();

  if (tokenTime > now + CLOCK_SKEW_TOLERANCE_MS) {
    console.warn({ event: "backfill_resume_token_future", tokenTime, now, tolerance: CLOCK_SKEW_TOLERANCE_MS });
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        message: "Resume token is in the future beyond clock-skew tolerance",
        path: [],
      },
    ]);
  }
}

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
  validateResumeTokenFreshness(d);
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
// Progress persistence helpers
// ---------------------------------------------------------------------------

/**
 * Upsert backfill progress for a given job. Creates a new row if none exists,
 * or updates the existing row with the provided fields.
 *
 * @param tx - Database transaction to use for the upsert
 * @param jobName - The backfill job name
 * @param fields - Fields to upsert (partial update)
 */
export async function upsertBackfillProgress(
  tx: typeof db,
  jobName: BackfillJobName,
  fields: {
    status?: string;
    lastCursor?: Date | null;
    totalScanned?: number;
    totalCreated?: number;
    lastError?: string | null;
    startedAt?: Date | null;
    completedAt?: Date | null;
  },
): Promise<void> {
  const now = new Date();
  const existing = await tx
    .select()
    .from(schema.backfillProgress)
    .where(eq(schema.backfillProgress.jobName, jobName))
    .then((rows) => rows[0] ?? null);

  if (!existing) {
    await tx.insert(schema.backfillProgress).values({
      jobName,
      status: fields.status ?? "idle",
      lastCursor: fields.lastCursor ?? null,
      totalScanned: fields.totalScanned ?? 0,
      totalCreated: fields.totalCreated ?? 0,
      lastError: fields.lastError ?? null,
      startedAt: fields.startedAt ?? null,
      completedAt: fields.completedAt ?? null,
      updatedAt: now,
    });
  } else {
    await tx
      .update(schema.backfillProgress)
      .set({
        ...fields,
        updatedAt: now,
      })
      .where(eq(schema.backfillProgress.jobName, jobName));
  }
}

/**
 * Get backfill progress for a given job. Returns null if no progress exists.
 *
 * @param jobName - The backfill job name
 * @returns The progress row or null
 */
export async function getBackfillProgress(
  jobName: BackfillJobName,
): Promise<{
  status: string;
  lastCursor: Date | null;
  totalScanned: number;
  totalCreated: number;
  lastError: string | null;
} | null> {
  const rows = await db
    .select()
    .from(schema.backfillProgress)
    .where(eq(schema.backfillProgress.jobName, jobName));

  const row = rows[0] ?? null;
  if (!row) return null;

  return {
    status: row.status,
    lastCursor: row.lastCursor,
    totalScanned: row.totalScanned,
    totalCreated: row.totalCreated,
    lastError: row.lastError,
  };
}

// ---------------------------------------------------------------------------
// Shared performance-optimized backfill executor
// ---------------------------------------------------------------------------

/**
 * Perform event backfilling for a given event type with batching and performance metrics.
 *
 * ## Checkpoint batching
 *
 * When the number of scanned rows exceeds {@link BACKFILL_CHECKPOINT_BATCH_SIZE},
 * rows are inserted in batches of that size. Each batch runs in its own DB
 * transaction that also persists the progress checkpoint (totalScanned,
 * totalCreated, lastCursor). This guarantees that a crash between batches
 * never loses committed work — the next call resumes from the last persisted
 * checkpoint.
 *
 * ## Auto-resume
 *
 * If the caller omits the `before`, `resumeToken`, and `cursor` parameters,
 * the function loads the persisted checkpoint for the job and uses its
 * `lastCursor` as the resume boundary. An explicit parameter always takes
 * precedence over the persisted checkpoint.
 */
export async function performBackfill(
  eventType: BackfillEventType,
  params: BackfillQueryParams,
): Promise<BackfillResponse> {
  const startTime = performance.now();
  const { limit, agreementId, before, resumeToken, cursor } = params;

  // Normalise the three input aliases into one cursor
  const explicitCursor = normalizeResumeCursor(before, resumeToken, cursor);

  // Auto-resume: if no explicit cursor provided, load persisted checkpoint
  const jobName: BackfillJobName = eventType === "EmployeeAdded"
    ? EMPLOYEE_BACKFILL_JOB
    : MILESTONE_BACKFILL_JOB;

  const isEmployee = eventType === "EmployeeAdded";
  const tableAlias = isEmployee ? "e" : "m";

  // If no explicit cursor, load the persisted checkpoint
  let resumeDate: Date | null = explicitCursor ?? null;
  let persistedTotalScanned = 0;
  let persistedTotalCreated = 0;
  if (!resumeDate) {
    const progress = await getBackfillProgress(jobName);
    if (progress?.lastCursor) {
      resumeDate = progress.lastCursor;
    }
    if (progress) {
      persistedTotalScanned = progress.totalScanned;
      persistedTotalCreated = progress.totalCreated;
    }
  }

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

  // Mark job as running at the start
  await db.transaction(async (tx) => {
    await upsertBackfillProgress(tx, jobName, {
      status: "running",
      startedAt: new Date(),
      lastError: null,
    });
  });

  if (scannedRows.length > 0) {
    // Process in batches of BACKFILL_CHECKPOINT_BATCH_SIZE
    const batchSize = BACKFILL_CHECKPOINT_BATCH_SIZE;
    const batches = [];
    for (let i = 0; i < scannedRows.length; i += batchSize) {
      batches.push(scannedRows.slice(i, i + batchSize));
    }

    // Start from persisted totals when resuming, otherwise start from 0
    let batchCreatedCount = persistedTotalCreated;
    let batchTotalScanned = persistedTotalScanned;

    for (const batch of batches) {
      const insertValues = batch.map((row) => {
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

        // Count created rows in this batch
        const batchCreated = insertedRows.length;

        // Update progress checkpoint atomically with the inserts
        const lastRow = batch[batch.length - 1];
        const batchCursor = new Date(lastRow.created_at);

        await upsertBackfillProgress(tx, jobName, {
          status: "running",
          totalScanned: batchTotalScanned + batch.length,
          totalCreated: batchCreatedCount + batchCreated,
          lastCursor: batchCursor,
        });

        batchCreatedCount += batchCreated;
        batchTotalScanned += batch.length;
      });

      const insertedIds = new Set(insertedRows.map((r) => String(r.id)));

      for (const row of batch) {
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
  }

  // Determine final status
  const hasMore = scannedRows.length === limit;
  const finalStatus = hasMore ? "idle" : "completed";
  const completedAt = hasMore ? null : new Date();

  // Update final progress status
  await db.transaction(async (tx) => {
    await upsertBackfillProgress(tx, jobName, {
      status: finalStatus,
      completedAt,
    });
  });

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
    hasMore,
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
      try {
        await upsertBackfillProgress(db, EMPLOYEE_BACKFILL_JOB, {
          status: "failed",
          lastError: e?.message ? String(e.message) : String(e),
        });
      } catch {
        // Best-effort: don't let a failed checkpoint write mask the original error.
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
      try {
        await upsertBackfillProgress(db, MILESTONE_BACKFILL_JOB, {
          status: "failed",
          lastError: e?.message ? String(e.message) : String(e),
        });
      } catch {
        // Best-effort: don't let a failed checkpoint write mask the original error.
      }
      next(e);
    }
  },
);

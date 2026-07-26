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
 *   When omitted, the persisted checkpoint (see `GET /backfill/status`) is
 *   used automatically if one exists, so restarting a call after a crash
 *   resumes from the last checkpoint rather than rescanning from scratch.
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

/** Shape of a single job entry returned by `GET /backfill/status`. */
export interface BackfillJobStatus {
  jobName: BackfillJobName;
  status: "idle" | "running" | "completed" | "failed";
  lastCursor: string | null;
  totalScanned: number;
  totalCreated: number;
  lastError: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Progress persistence
// ---------------------------------------------------------------------------

/** DB client type accepted by {@link upsertBackfillProgress}: either the module-level `db` or a `db.transaction` callback's `tx`. */
type BackfillDbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

interface BackfillProgressPatch {
  status?: "idle" | "running" | "completed" | "failed";
  /** Absolute resume cursor to persist. Omit to leave the stored cursor unchanged. */
  lastCursor?: Date;
  /**
   * Absolute cumulative scanned-row count to persist (the caller computes
   * this from the previously-read progress plus rows processed so far — batches
   * within a single request are sequential, never concurrent, so a
   * read-then-write here is safe and keeps checkpoint writes plain values
   * instead of DB-level increment expressions).
   */
  totalScanned?: number;
  /** Absolute cumulative created-row count to persist. See {@link totalScanned}. */
  totalCreated?: number;
  lastError?: string | null;
  startedAt?: Date;
  completedAt?: Date;
}

/** Reads the persisted checkpoint row for a backfill job, or `null` if the job has never run. */
async function getBackfillProgress(jobName: BackfillJobName) {
  const [row] = await db
    .select()
    .from(schema.backfillProgress)
    .where(eq(schema.backfillProgress.jobName, jobName));
  return row ?? null;
}

/**
 * Insert-or-update the checkpoint row for a backfill job. Fields omitted from
 * `patch` are left unchanged on an existing row (increments are additive, not
 * overwrites). Pass `tx` (a `db.transaction` callback argument) to make the
 * write commit atomically with the batch of inserts it checkpoints;
 * otherwise pass the module-level `db` for standalone writes (marking the job
 * running at the start of a request, or failed/completed at the end).
 */
async function upsertBackfillProgress(
  dbClient: BackfillDbClient,
  jobName: BackfillJobName,
  patch: BackfillProgressPatch,
): Promise<void> {
  const now = new Date();
  await dbClient
    .insert(schema.backfillProgress)
    .values({
      jobName,
      status: patch.status ?? "idle",
      lastCursor: patch.lastCursor ?? null,
      totalScanned: patch.totalScanned ?? 0,
      totalCreated: patch.totalCreated ?? 0,
      lastError: patch.lastError ?? null,
      startedAt: patch.startedAt ?? null,
      completedAt: patch.completedAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.backfillProgress.jobName,
      set: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.lastCursor !== undefined ? { lastCursor: patch.lastCursor } : {}),
        ...(patch.totalScanned !== undefined ? { totalScanned: patch.totalScanned } : {}),
        ...(patch.totalCreated !== undefined ? { totalCreated: patch.totalCreated } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        updatedAt: now,
      },
    });
}

/**
 * GET /backfill/status
 *
 * Reports persisted checkpoint state for both backfill jobs
 * (`employee-events`, `milestone-events`) so operators can tell whether a
 * backfill is running, idle, completed, or failed without guessing — and, if
 * it crashed, where it will resume from on the next call.
 *
 * **Authentication:** Requires an active admin session (`requireAuth` +
 * `requireAdmin`) — deliberately gated, unlike `indexer-status.ts`'s routes,
 * since checkpoint state (row counts, error messages, timing) is an internal
 * indexing detail that shouldn't be exposed publicly.
 *
 * A job that has never run is still reported, with `status: "idle"` and
 * zeroed/null fields, so operators always see both job names.
 */
backfillEventsRouter.get(
  "/backfill/status",
  requireAuth,
  requireAdmin,
  async (_req, res, next) => {
    try {
      const rows = await db.select().from(schema.backfillProgress);
      const byJob = new Map(rows.map((row) => [row.jobName, row]));

      const jobs: BackfillJobStatus[] = BACKFILL_JOB_NAMES.map((jobName) => {
        const row = byJob.get(jobName);
        return {
          jobName,
          status: (row?.status as BackfillJobStatus["status"]) ?? "idle",
          lastCursor: row?.lastCursor ? new Date(row.lastCursor).toISOString() : null,
          totalScanned: row?.totalScanned ?? 0,
          totalCreated: row?.totalCreated ?? 0,
          lastError: row?.lastError ?? null,
          startedAt: row?.startedAt ? new Date(row.startedAt).toISOString() : null,
          updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
          completedAt: row?.completedAt ? new Date(row.completedAt).toISOString() : null,
        };
      });

      res.json({ jobs });
    } catch (e) {
      next(e);
    }
  },
);

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
 * **Checkpointing and resumability:** Rows are inserted in batches of
 * {@link BACKFILL_CHECKPOINT_BATCH_SIZE}. Each batch commits inside its own
 * transaction alongside a `backfill_progress` checkpoint update, so progress
 * is durable and queryable (`GET /backfill/status`) even while a request is
 * still in flight. Omitting `before` uses the persisted checkpoint
 * automatically, so restarting after a crash resumes from the last committed
 * batch instead of rescanning from scratch. Passing `before` explicitly
 * still overrides the checkpoint for manual paging, exactly as before.
 *
 * **Idempotency:** Synthetic event IDs use the form
 * `{transactionHash}_backfill_EmployeeAdded_{employeeId}` which cannot collide
 * with real event IDs (`{txHash}_{eventIndex}`). The `eventIndex` is set to
 * {@link BACKFILL_EVENT_INDEX} (`0`) — real on-chain events for this contract
 * only ever use positive indexes for a synthesized row's position, and the
 * `_backfill_` ID segment is what actually guarantees no collision. On
 * conflict the row is silently skipped (`onConflictDoNothing`). Because the
 * cursor only narrows the candidate set, replaying any page (with or without
 * `before`) is a safe no-op for rows already backfilled.
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

      const progress = await getBackfillProgress(EMPLOYEE_BACKFILL_JOB);
      const effectiveBefore = before ?? (progress?.lastCursor ? new Date(progress.lastCursor) : undefined);

      await upsertBackfillProgress(db, EMPLOYEE_BACKFILL_JOB, {
        status: "running",
        startedAt: progress?.startedAt ? new Date(progress.startedAt) : new Date(),
      });

      const conditions = sql`1=1`;
      if (agreementId) {
        conditions.append(sql` AND e.agreement_id = ${agreementId}`);
      }
      if (effectiveBefore) {
        conditions.append(sql` AND e.created_at < ${effectiveBefore}`);
      }

      const employeesWithoutEvents = await db.execute(sql`
        SELECT e.* FROM employees e
        LEFT JOIN agreement_events ae
          ON ae.transaction_hash = e.transaction_hash
         AND ae.event_type = 'EmployeeAdded'
         AND ae.agreement_id = e.agreement_id
        WHERE ae.id IS NULL AND ${conditions}
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `);

      const scannedRows = employeesWithoutEvents.rows as Record<string, unknown>[];
      let created = 0;
      const results: BackfillResultEntry[] = [];
      let totalScannedSoFar = progress?.totalScanned ?? 0;
      let totalCreatedSoFar = progress?.totalCreated ?? 0;

      for (let i = 0; i < scannedRows.length; i += BACKFILL_CHECKPOINT_BATCH_SIZE) {
        const batch = scannedRows.slice(i, i + BACKFILL_CHECKPOINT_BATCH_SIZE);
        let batchCreated = 0;

        await db.transaction(async (tx) => {
          for (const employee of batch) {
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
              batchCreated++;
            }
            results.push({
              employeeId: String(employee.id),
              agreementId: String(employee.agreement_id),
              status: inserted.length > 0 ? "created" : "skipped",
            });
          }

          totalScannedSoFar += batch.length;
          totalCreatedSoFar += batchCreated;
          const lastInBatch = batch[batch.length - 1];
          await upsertBackfillProgress(tx, EMPLOYEE_BACKFILL_JOB, {
            status: "running",
            lastCursor: new Date(lastInBatch.created_at as any),
            totalScanned: totalScannedSoFar,
            totalCreated: totalCreatedSoFar,
          });
        });
      }

      const lastRow = scannedRows[scannedRows.length - 1];
      const nextCursor = lastRow ? new Date(lastRow.created_at as any).toISOString() : null;
      const hasMore = scannedRows.length === limit;

      await upsertBackfillProgress(db, EMPLOYEE_BACKFILL_JOB, {
        status: hasMore ? "idle" : "completed",
        ...(hasMore ? {} : { completedAt: new Date() }),
        lastError: null,
      });

      const body: BackfillResponse = {
        message: `Backfilled ${created} EmployeeAdded events`,
        totalScanned: scannedRows.length,
        created,
        results: results.slice(0, RESULTS_PREVIEW_SIZE),
        nextCursor,
        hasMore,
      };
      res.json(body);
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
 * **Checkpointing and resumability:** Identical contract to the
 * employee-events sibling — see its JSDoc for details. Checkpoints are
 * tracked independently under the `milestone-events` job name.
 *
 * **Idempotency:** Identical approach to the employee-events sibling — synthetic
 * IDs with a `_backfill_MilestoneAdded_` segment, `eventIndex:
 * BACKFILL_EVENT_INDEX`, and `onConflictDoNothing` inside a transaction.
 * Re-runs are safe no-ops, and the `before` cursor only narrows the candidate
 * set so replaying any page never creates duplicates.
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

      const progress = await getBackfillProgress(MILESTONE_BACKFILL_JOB);
      const effectiveBefore = before ?? (progress?.lastCursor ? new Date(progress.lastCursor) : undefined);

      await upsertBackfillProgress(db, MILESTONE_BACKFILL_JOB, {
        status: "running",
        startedAt: progress?.startedAt ? new Date(progress.startedAt) : new Date(),
      });

      const conditions = sql`1=1`;
      if (agreementId) {
        conditions.append(sql` AND m.agreement_id = ${agreementId}`);
      }
      if (effectiveBefore) {
        conditions.append(sql` AND m.created_at < ${effectiveBefore}`);
      }

      const milestonesWithoutEvents = await db.execute(sql`
        SELECT m.* FROM milestones m
        LEFT JOIN agreement_events ae
          ON ae.transaction_hash = m.transaction_hash
         AND ae.event_type = 'MilestoneAdded'
         AND ae.agreement_id = m.agreement_id
        WHERE ae.id IS NULL AND ${conditions}
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `);

      const scannedRows = milestonesWithoutEvents.rows as Record<string, unknown>[];
      let created = 0;
      const results: BackfillResultEntry[] = [];
      let totalScannedSoFar = progress?.totalScanned ?? 0;
      let totalCreatedSoFar = progress?.totalCreated ?? 0;

      for (let i = 0; i < scannedRows.length; i += BACKFILL_CHECKPOINT_BATCH_SIZE) {
        const batch = scannedRows.slice(i, i + BACKFILL_CHECKPOINT_BATCH_SIZE);
        let batchCreated = 0;

        await db.transaction(async (tx) => {
          for (const milestone of batch) {
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
              batchCreated++;
            }
            results.push({
              milestoneId: String(milestone.id),
              agreementId: String(milestone.agreement_id),
              status: inserted.length > 0 ? "created" : "skipped",
            });
          }

          totalScannedSoFar += batch.length;
          totalCreatedSoFar += batchCreated;
          const lastInBatch = batch[batch.length - 1];
          await upsertBackfillProgress(tx, MILESTONE_BACKFILL_JOB, {
            status: "running",
            lastCursor: new Date(lastInBatch.created_at as any),
            totalScanned: totalScannedSoFar,
            totalCreated: totalCreatedSoFar,
          });
        });
      }

      const lastRow = scannedRows[scannedRows.length - 1];
      const nextCursor = lastRow ? new Date(lastRow.created_at as any).toISOString() : null;
      const hasMore = scannedRows.length === limit;

      await upsertBackfillProgress(db, MILESTONE_BACKFILL_JOB, {
        status: hasMore ? "idle" : "completed",
        ...(hasMore ? {} : { completedAt: new Date() }),
        lastError: null,
      });

      const body: BackfillResponse = {
        message: `Backfilled ${created} MilestoneAdded events`,
        totalScanned: scannedRows.length,
        created,
        results: results.slice(0, RESULTS_PREVIEW_SIZE),
        nextCursor,
        hasMore,
      };
      res.json(body);
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

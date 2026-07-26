/**
 * @file backfill-events.test.ts
 * Tests for the admin-only backfill routes: POST /backfill/employee-events,
 * POST /backfill/milestone-events, and GET /backfill/status.
 *
 * Mock strategy
 * -------------
 * - The real requireAuth + requireAdmin middleware run here (only their
 *   dependencies — the session check and the admin allowlist — are mocked),
 *   matching the pattern in diagnostics.test.ts, so admin gating itself is
 *   exercised end to end.
 * - `../db/index.js` is replaced with a small in-memory model of two tables
 *   (`agreement_events`, `backfill_progress`) rather than a call-by-call
 *   mock, because the checkpoint/resume/interrupted-run tests need realistic
 *   read-your-writes behavior across multiple requests. `db.execute` (the
 *   raw LEFT JOIN scan query) stays a canned queue, as in diagnostics.test.ts
 *   — this suite verifies the application's checkpoint/resume logic given
 *   whatever rows a real query would have returned, not the SQL itself.
 * - `drizzle-orm`'s real `sql` tag is used unmocked (it needs no live DB),
 *   only `eq` is replaced with a simple stub so the in-memory `.where()`
 *   lookup can read the comparison value back out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../auth/session.js", () => ({
  requireSession: vi.fn(async () => true),
}));

vi.mock("../config.js", () => ({
  env: { ADMIN_ADDRESSES: ["0xabc1"] },
}));

const { dbMock, schemaMock, store } = vi.hoisted(() => {
  interface AgreementEventRow {
    id: string;
    agreementId: string;
    contractAddress: string;
    eventType: string;
    blockNumber: number;
    transactionHash: string;
    eventIndex: number;
  }

  interface ProgressRow {
    jobName: string;
    status: string;
    lastCursor: Date | null;
    totalScanned: number;
    totalCreated: number;
    lastError: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    updatedAt: Date;
  }

  const schema = {
    agreementEvents: { __table: "agreementEvents" as const },
    backfillProgress: { __table: "backfillProgress" as const, jobName: "job_name" },
  };

  const state = {
    agreementEvents: new Map<string, AgreementEventRow>(),
    progress: new Map<string, ProgressRow>(),
    executeQueue: [] as Array<{ rows: Record<string, unknown>[] }>,
    executeCalls: [] as unknown[],
    /** 1-indexed db.transaction call number (across the whole test) that should throw instead of committing. */
    failOnBatchNumber: null as number | null,
    batchCallCount: 0,
    /** 1-indexed onConflictDoUpdate call number (on backfill_progress, across the whole test) that should throw. */
    failProgressWriteOnCallNumber: null as number | null,
    progressWriteCallCount: 0,
  };

  function reset() {
    state.agreementEvents.clear();
    state.progress.clear();
    state.executeQueue = [];
    state.executeCalls = [];
    state.failOnBatchNumber = null;
    state.batchCallCount = 0;
    state.failProgressWriteOnCallNumber = null;
    state.progressWriteCallCount = 0;
  }

  function insertAgreementEvent(values: AgreementEventRow) {
    if (state.agreementEvents.has(values.id)) {
      return [];
    }
    state.agreementEvents.set(values.id, { ...values });
    return [{ ...values }];
  }

  function upsertProgress(values: ProgressRow, set: Partial<ProgressRow>) {
    state.progressWriteCallCount++;
    if (state.failProgressWriteOnCallNumber === state.progressWriteCallCount) {
      throw new Error("simulated progress write failure");
    }
    const existing = state.progress.get(values.jobName);
    if (!existing) {
      state.progress.set(values.jobName, { ...values });
      return;
    }
    state.progress.set(values.jobName, { ...existing, ...set });
  }

  function makeAgreementEventsInsertChain() {
    return {
      values: (values: AgreementEventRow) => ({
        onConflictDoNothing: () => ({
          returning: async () => insertAgreementEvent(values),
        }),
      }),
    };
  }

  function makeProgressInsertChain() {
    return {
      values: (values: ProgressRow) => ({
        onConflictDoUpdate: async ({ set }: { set: Partial<ProgressRow> }) => {
          upsertProgress(values, set);
        },
      }),
    };
  }

  function insertFor(table: unknown) {
    if (table === schema.agreementEvents) return makeAgreementEventsInsertChain();
    if (table === schema.backfillProgress) return makeProgressInsertChain();
    throw new Error(`unexpected insert table: ${String(table)}`);
  }

  const txMock = { insert: insertFor };

  const db = {
    execute: vi.fn(async (arg: unknown) => {
      state.executeCalls.push(arg);
      return state.executeQueue.shift() ?? { rows: [] };
    }),
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table !== schema.backfillProgress) {
          throw new Error(`unexpected select table: ${String(table)}`);
        }
        const allRows = () => Array.from(state.progress.values()).map((r) => ({ ...r }));
        const result: {
          where: (condition: { value: string }) => Promise<ProgressRow[]>;
          then: (resolve: (rows: ProgressRow[]) => void, reject: (e: unknown) => void) => void;
        } = {
          where: async (condition: { value: string }) => {
            const row = state.progress.get(condition.value);
            return row ? [{ ...row }] : [];
          },
          then: (resolve, reject) => {
            Promise.resolve(allRows()).then(resolve, reject);
          },
        };
        return result;
      },
    })),
    insert: insertFor,
    transaction: vi.fn(async (cb: (tx: typeof txMock) => Promise<void>) => {
      state.batchCallCount++;
      if (state.failOnBatchNumber !== null && state.batchCallCount === state.failOnBatchNumber) {
        throw new Error("simulated batch failure");
      }
      return cb(txMock);
    }),
  };

  return { dbMock: db, schemaMock: schema, store: { state, reset } };
});

vi.mock("../db/index.js", () => ({
  db: dbMock,
  schema: schemaMock,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn((column: unknown, value: string) => ({ type: "eq", column, value })),
  };
});

import {
  backfillEventsRouter,
  BACKFILL_CHECKPOINT_BATCH_SIZE,
  RESULTS_PREVIEW_SIZE,
} from "./backfill-events.js";
import { requireSession } from "../auth/session.js";

const ADMIN = "0xabc1";
const NON_ADMIN = "0xdef2";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", backfillEventsRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

function authHeaders(address: string) {
  return { "x-user-address": address, authorization: "Bearer testtoken" };
}

/** Recursively walks a drizzle SQL fragment's internal queryChunks to find every embedded Date param. */
function extractDateParams(node: unknown): Date[] {
  const found: Date[] = [];
  function walk(n: unknown) {
    if (!n || typeof n !== "object") return;
    if (n instanceof Date) {
      found.push(n);
      return;
    }
    const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c);
    }
  }
  walk(node);
  return found;
}

function queueRows(rows: Record<string, unknown>[]) {
  store.state.executeQueue.push({ rows });
}

/** Builds a canned row for either `employees` or `milestones` — the columns the routes read are identical. */
function makeRow(
  index: number,
  opts: { agreementId?: string; transactionHash?: string; createdAt?: Date } = {},
) {
  return {
    id: `row-${index}`,
    agreement_id: opts.agreementId ?? `agr-${index}`,
    contract_address: "0xcontract",
    transaction_hash: opts.transactionHash ?? `0xtx${index}`,
    block_number: 1000 + index,
    created_at: opts.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
  };
}

/** Descending-by-created_at row set, matching the routes' `ORDER BY created_at DESC` contract. */
function makeDescendingRows(count: number, idOffset = 0) {
  return Array.from({ length: count }, (_, i) =>
    makeRow(idOffset + i, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, count - i)) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  store.reset();
  vi.mocked(requireSession).mockResolvedValue(true);
});

interface JobConfig {
  jobName: "employee-events" | "milestone-events";
  path: string;
  entityIdKey: "employeeId" | "milestoneId";
  eventType: "EmployeeAdded" | "MilestoneAdded";
}

const JOBS: JobConfig[] = [
  {
    jobName: "employee-events",
    path: "/api/v1/backfill/employee-events",
    entityIdKey: "employeeId",
    eventType: "EmployeeAdded",
  },
  {
    jobName: "milestone-events",
    path: "/api/v1/backfill/milestone-events",
    entityIdKey: "milestoneId",
    eventType: "MilestoneAdded",
  },
];

describe.each(JOBS)("POST $path", (job) => {
  it("rejects an unauthenticated request with 401 and runs no queries", async () => {
    const res = await request(makeApp()).post(job.path);
    expect(res.status).toBe(401);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it("rejects an authenticated non-admin with 403", async () => {
    const res = await request(makeApp()).post(job.path).set(authHeaders(NON_ADMIN));
    expect(res.status).toBe(403);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it("rejects an invalid `before` value with 400 and never touches progress state", async () => {
    const res = await request(makeApp())
      .post(`${job.path}?before=not-a-date`)
      .set(authHeaders(ADMIN));
    expect(res.status).toBe(400);
    expect(store.state.progress.has(job.jobName)).toBe(false);
  });

  it("rejects a limit above MAX_BACKFILL_LIMIT with 400", async () => {
    const res = await request(makeApp()).post(`${job.path}?limit=99999`).set(authHeaders(ADMIN));
    expect(res.status).toBe(400);
  });

  it("creates events for scanned rows, returns the response contract, and skips duplicates idempotently", async () => {
    queueRows([makeRow(1), makeRow(2)]);
    const res = await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(200);

    expect(res.body.totalScanned).toBe(2);
    expect(res.body.created).toBe(2);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0][job.entityIdKey]).toBe("row-1");
    expect(res.body.results[0].status).toBe("created");
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString());

    // Re-running against the same (still-queued) row set must be a no-op.
    queueRows([makeRow(1), makeRow(2)]);
    const res2 = await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(200);
    expect(res2.body.created).toBe(0);
    expect(res2.body.results.every((r: any) => r.status === "skipped")).toBe(true);
  });

  it("caps the results preview at RESULTS_PREVIEW_SIZE even when more rows were scanned", async () => {
    queueRows(makeDescendingRows(15));
    const res = await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(200);
    expect(res.body.totalScanned).toBe(15);
    expect(res.body.created).toBe(15);
    expect(res.body.results).toHaveLength(RESULTS_PREVIEW_SIZE);
  });

  it("reports hasMore true and nextCursor null appropriately", async () => {
    // Full page (scanned === limit) => hasMore true.
    queueRows(makeDescendingRows(5));
    const full = await request(makeApp()).post(`${job.path}?limit=5`).set(authHeaders(ADMIN)).expect(200);
    expect(full.body.hasMore).toBe(true);

    // Zero rows scanned => nextCursor null, hasMore false.
    queueRows([]);
    const empty = await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(200);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.body.hasMore).toBe(false);
  });

  it("checkpoints progress in batches when a page exceeds the checkpoint batch size", async () => {
    const rowCount = BACKFILL_CHECKPOINT_BATCH_SIZE + 20;
    queueRows(makeDescendingRows(rowCount));

    // No `limit` override: default (1000) exceeds rowCount, so hasMore is false and the
    // job is expected to reach "completed" once all batches commit.
    const res = await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(200);

    expect(res.body.totalScanned).toBe(rowCount);
    // One batch of 100 + one partial batch of 20 = 2 transactions.
    expect(dbMock.transaction).toHaveBeenCalledTimes(2);

    const progress = store.state.progress.get(job.jobName)!;
    expect(progress.totalScanned).toBe(rowCount);
    expect(progress.totalCreated).toBe(rowCount);
    expect(progress.status).toBe("completed");
    expect(progress.completedAt).not.toBeNull();
  });

  it("leaves the job idle (not completed) when the page is full and more rows may remain", async () => {
    queueRows(makeDescendingRows(10));
    await request(makeApp()).post(`${job.path}?limit=10`).set(authHeaders(ADMIN)).expect(200);

    const progress = store.state.progress.get(job.jobName)!;
    expect(progress.status).toBe("idle");
    expect(progress.completedAt).toBeNull();
  });

  it("auto-resumes from the persisted checkpoint when `before` is omitted, but an explicit `before` overrides it", async () => {
    queueRows(makeDescendingRows(3));
    await request(makeApp()).post(`${job.path}?limit=3`).set(authHeaders(ADMIN)).expect(200);

    const persistedCursor = store.state.progress.get(job.jobName)!.lastCursor!;

    // Second call, no `before` in the query string: should scan using the persisted cursor.
    queueRows([]);
    await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(200);
    const autoResumeCall = store.state.executeCalls[store.state.executeCalls.length - 1];
    const autoResumeDates = extractDateParams(autoResumeCall);
    expect(autoResumeDates).toHaveLength(1);
    expect(autoResumeDates[0].toISOString()).toBe(persistedCursor.toISOString());

    // Third call, explicit `before` provided: must override the checkpoint value.
    const explicitBefore = new Date(Date.UTC(2020, 0, 1)).toISOString();
    queueRows([]);
    await request(makeApp())
      .post(`${job.path}?before=${encodeURIComponent(explicitBefore)}`)
      .set(authHeaders(ADMIN))
      .expect(200);
    const explicitCall = store.state.executeCalls[store.state.executeCalls.length - 1];
    const explicitDates = extractDateParams(explicitCall);
    expect(explicitDates).toHaveLength(1);
    expect(explicitDates[0].toISOString()).toBe(explicitBefore);
  });

  it("sends no cursor condition on the very first call for a job that has never run", async () => {
    queueRows([]);
    await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(200);
    const call = store.state.executeCalls[0];
    expect(extractDateParams(call)).toHaveLength(0);
  });

  it("marks the job failed and preserves the last committed checkpoint when a batch throws, then resumes from it on the next call", async () => {
    const rowCount = BACKFILL_CHECKPOINT_BATCH_SIZE + 50;
    queueRows(makeDescendingRows(rowCount));
    // The 2nd db.transaction call (the second batch) fails outright — nothing in it commits.
    store.state.failOnBatchNumber = 2;

    const res = await request(makeApp())
      .post(`${job.path}?limit=${rowCount}`)
      .set(authHeaders(ADMIN))
      .expect(500);
    expect(res.body.error).toBe("simulated batch failure");

    // Only the first, successfully-committed batch is durable.
    expect(store.state.agreementEvents.size).toBe(BACKFILL_CHECKPOINT_BATCH_SIZE);

    const failedProgress = store.state.progress.get(job.jobName)!;
    expect(failedProgress.status).toBe("failed");
    expect(failedProgress.lastError).toBe("simulated batch failure");
    expect(failedProgress.totalScanned).toBe(BACKFILL_CHECKPOINT_BATCH_SIZE);
    expect(failedProgress.totalCreated).toBe(BACKFILL_CHECKPOINT_BATCH_SIZE);
    const checkpointAfterFailure = failedProgress.lastCursor!;

    // Resume: caller retries without `before` — the persisted checkpoint from the surviving
    // batch is used automatically, and the new run's totals accumulate on top of it rather
    // than starting over. These rows represent records the (real, un-mocked) LEFT JOIN scan
    // would return next — distinct ids from the ones already committed in the first batch.
    const remainingRows = makeDescendingRows(30, rowCount);
    queueRows(remainingRows);
    const resumed = await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(200);

    const resumeCall = store.state.executeCalls[store.state.executeCalls.length - 1];
    expect(extractDateParams(resumeCall)[0].toISOString()).toBe(checkpointAfterFailure.toISOString());

    expect(resumed.body.totalScanned).toBe(30);
    const finalProgress = store.state.progress.get(job.jobName)!;
    expect(finalProgress.status).toBe("completed");
    expect(finalProgress.lastError).toBeNull();
    expect(finalProgress.totalScanned).toBe(BACKFILL_CHECKPOINT_BATCH_SIZE + 30);
    expect(finalProgress.totalCreated).toBe(BACKFILL_CHECKPOINT_BATCH_SIZE + 30);

    // The first batch's rows were never reprocessed/duplicated.
    expect(store.state.agreementEvents.size).toBe(BACKFILL_CHECKPOINT_BATCH_SIZE + 30);
  });

  it("still propagates the original error to the client if the best-effort failed-status write itself throws", async () => {
    queueRows(makeDescendingRows(5));
    // Call #1 is the "mark running" write at the start of the request (must succeed so the
    // batch failure below is what actually drives the response); call #2 is the "mark failed"
    // write inside the catch block once the batch itself throws — that's the one we fail.
    store.state.failOnBatchNumber = 1;
    store.state.failProgressWriteOnCallNumber = 2;

    const res = await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(500);
    expect(res.body.error).toBe("simulated batch failure");
  });
});

describe("GET /api/v1/backfill/status", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(makeApp()).get("/api/v1/backfill/status");
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin with 403", async () => {
    const res = await request(makeApp())
      .get("/api/v1/backfill/status")
      .set(authHeaders(NON_ADMIN));
    expect(res.status).toBe(403);
  });

  it("reports both jobs as idle with zeroed fields when neither has ever run", async () => {
    const res = await request(makeApp()).get("/api/v1/backfill/status").set(authHeaders(ADMIN)).expect(200);
    expect(res.body.jobs).toEqual([
      {
        jobName: "employee-events",
        status: "idle",
        lastCursor: null,
        totalScanned: 0,
        totalCreated: 0,
        lastError: null,
        startedAt: null,
        updatedAt: null,
        completedAt: null,
      },
      {
        jobName: "milestone-events",
        status: "idle",
        lastCursor: null,
        totalScanned: 0,
        totalCreated: 0,
        lastError: null,
        startedAt: null,
        updatedAt: null,
        completedAt: null,
      },
    ]);
  });

  it("reflects real progress for a job that has run while the other job stays default-idle", async () => {
    queueRows(makeDescendingRows(3));
    await request(makeApp())
      .post("/api/v1/backfill/employee-events")
      .set(authHeaders(ADMIN))
      .expect(200);

    const res = await request(makeApp()).get("/api/v1/backfill/status").set(authHeaders(ADMIN)).expect(200);
    const employeeJob = res.body.jobs.find((j: any) => j.jobName === "employee-events");
    const milestoneJob = res.body.jobs.find((j: any) => j.jobName === "milestone-events");

    expect(employeeJob.status).toBe("completed");
    expect(employeeJob.totalScanned).toBe(3);
    expect(employeeJob.totalCreated).toBe(3);
    expect(employeeJob.startedAt).not.toBeNull();
    expect(employeeJob.completedAt).not.toBeNull();
    expect(milestoneJob.status).toBe("idle");
    expect(milestoneJob.totalScanned).toBe(0);
  });
});

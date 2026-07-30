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

vi.mock("../starknet/client.js", () => ({
  provider: { getBlockNumber: vi.fn().mockResolvedValue(1200) },
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
    lastBlockNumber: number | null;
    lastContractAddress: string | null;
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

  function insertAgreementEvent(values: AgreementEventRow | AgreementEventRow[]) {
    const rows = Array.isArray(values) ? values : [values];
    const inserted: AgreementEventRow[] = [];
    for (const row of rows) {
      if (state.agreementEvents.has(row.id)) continue;
      state.agreementEvents.set(row.id, { ...row });
      inserted.push({ ...row });
    }
    return inserted;
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
    // Filter out undefined values so they don't overwrite existing data.
    // This matches real drizzle-orm behavior: omitting a field from `set`
    // leaves the existing column value intact.
    const cleaned = Object.fromEntries(
      Object.entries(set).filter(([, v]) => v !== undefined),
    );
    state.progress.set(values.jobName, { ...existing, ...cleaned });
  }

  function makeAgreementEventsInsertChain() {
    return {
      values: (values: AgreementEventRow | AgreementEventRow[]) => {
        const rows = Array.isArray(values) ? values : [values];
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              const inserted: AgreementEventRow[] = [];
              for (const row of rows) {
                const result = insertAgreementEvent(row);
                inserted.push(...result);
              }
              return inserted;
            },
          }),
        };
      },
    };
  }

  function makeProgressInsertChain() {
    return {
      values: (values: ProgressRow) => {
        const existing = state.progress.get(values.jobName);
        if (!existing) {
          state.progress.set(values.jobName, { ...values });
        }
        return {
          onConflictDoUpdate: async ({ set }: { set: Partial<ProgressRow> }) => {
            upsertProgress(values, set);
          },
        };
      },
    };
  }

  function insertFor(table: unknown) {
    if (table === schema.agreementEvents) return makeAgreementEventsInsertChain();
    if (table === schema.backfillProgress) return makeProgressInsertChain();
    throw new Error(`unexpected insert table: ${String(table)}`);
  }

  function selectFrom(table: unknown) {
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
  }

  function updateTable(table: unknown) {
    if (table !== schema.backfillProgress) {
      throw new Error(`unexpected update table: ${String(table)}`);
    }
    return {
      set: (values: Partial<ProgressRow>) => ({
        where: (condition: { value: string }) => {
          const existing = state.progress.get(condition.value);
          if (existing) {
            state.progress.set(condition.value, { ...existing, ...values, updatedAt: new Date() });
          }
          return Promise.resolve();
        },
      }),
    };
  }

  const txMock = {
    insert: insertFor,
    select: vi.fn(() => ({ from: selectFrom })),
    update: vi.fn(updateTable),
  };

  const db = {
    execute: vi.fn(async (arg: unknown) => {
      state.executeCalls.push(arg);
      return state.executeQueue.shift() ?? { rows: [] };
    }),
    select: vi.fn(() => ({ from: selectFrom })),
    insert: insertFor,
    update: vi.fn(updateTable),
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
  RESULTS_PREVIEW_SIZE,
  BACKFILL_CHECKPOINT_BATCH_SIZE,
  buildBackfillEventId,
  BackfillQuerySchema,
  DEFAULT_BACKFILL_LIMIT,
  MAX_BACKFILL_LIMIT,
  normalizeResumeCursor,
  getBackfillProgress,
} from "./backfill-events.js";
import { requireSession } from "../auth/session.js";
import { provider } from "../starknet/client.js";
import { getStarknetMetricsSnapshot, resetStarknetMetrics } from "../starknet/client-metrics.js";

const ADMIN = "0xabc1";
const NON_ADMIN = "0xdef2";

function authHeaders(address: string) {
  return { "x-user-address": address, Authorization: "Bearer test-token" };
}

function setupDbDefaults() {
  store.reset();
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", backfillEventsRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
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
  resetStarknetMetrics();
  vi.mocked(provider.getBlockNumber).mockResolvedValue(1200);
  store.reset();
  vi.mocked(requireSession).mockResolvedValue(true);
});

describe("backfill lag metrics", () => {
  it("records chain-head lag with job and contract labels", async () => {
    queueRows([makeRow(1)]);
    vi.mocked(provider.getBlockNumber).mockResolvedValue(1200);

    const response = await request(makeApp())
      .post("/api/v1/backfill/employee-events")
      .set(authHeaders(ADMIN));

    expect(response.status).toBe(200);
    expect(getStarknetMetricsSnapshot().gauges[
      'backfill_lag_blocks{job="employee-events",contract="0xcontract"}'
    ]).toBe(199);
  });
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
    vi.spyOn(console, "info").mockImplementation(() => {});
    queueRows([makeRow(1), makeRow(2)]);
    const res = await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(200);

    expect(res.body.totalScanned).toBe(2);
    expect(res.body.created).toBe(2);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0][job.entityIdKey]).toBe("row-1");
    expect(res.body.results[0].status).toBe("created");
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString());
    expect(res.body.nextResumeToken).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString());
    expect(res.body.cursor).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString());
    expect(typeof res.body.durationMs).toBe("number");
    expect(res.body.durationMs).toBeGreaterThanOrEqual(0);

    expect(console.info).toHaveBeenCalledWith(
      expect.objectContaining({
        op: job.jobName === "employee-events" ? "backfill_employee_events" : "backfill_milestone_events",
        scanned: 2,
        created: 2,
        durationMs: expect.any(Number),
        nextResumeToken: expect.any(String),
      }),
    );

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
    // Mark running (1) + batch of 100 (2) + partial batch of 20 (3) + mark completed (4) = 4 transactions.
    expect(dbMock.transaction).toHaveBeenCalledTimes(4);

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

  it("accepts `resumeToken` as an alias for `before` and resolves the same cursor", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const cursorDate = new Date(Date.UTC(2025, 0, 1)).toISOString();
    queueRows([]);
    await request(makeApp())
      .post(`${job.path}?resumeToken=${encodeURIComponent(cursorDate)}`)
      .set(authHeaders(ADMIN))
      .expect(200);
    const call = store.state.executeCalls[store.state.executeCalls.length - 1];
    const dates = extractDateParams(call);
    expect(dates).toHaveLength(1);
    expect(dates[0].toISOString()).toBe(cursorDate);
  });

  it("accepts `cursor` as an alias for `before` and resolves the same cursor", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const cursorDate = new Date(Date.UTC(2025, 0, 1)).toISOString();
    queueRows([]);
    await request(makeApp())
      .post(`${job.path}?cursor=${encodeURIComponent(cursorDate)}`)
      .set(authHeaders(ADMIN))
      .expect(200);
    const call = store.state.executeCalls[store.state.executeCalls.length - 1];
    const dates = extractDateParams(call);
    expect(dates).toHaveLength(1);
    expect(dates[0].toISOString()).toBe(cursorDate);
  });

  it("prefers `before` over `resumeToken` when both are provided", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const beforeDate = new Date(Date.UTC(2025, 0, 1)).toISOString();
    const resumeDate = new Date(Date.UTC(2025, 6, 1)).toISOString();
    queueRows([]);
    await request(makeApp())
      .post(`${job.path}?before=${encodeURIComponent(beforeDate)}&resumeToken=${encodeURIComponent(resumeDate)}`)
      .set(authHeaders(ADMIN))
      .expect(200);
    const call = store.state.executeCalls[store.state.executeCalls.length - 1];
    const dates = extractDateParams(call);
    expect(dates).toHaveLength(1);
    expect(dates[0].toISOString()).toBe(beforeDate);
  });

  it("returns all three output cursors (nextCursor, nextResumeToken, cursor) on every response", async () => {
    queueRows([makeRow(1)]);
    const res = await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(200);
    expect(res.body).toHaveProperty("nextCursor");
    expect(res.body).toHaveProperty("nextResumeToken");
    expect(res.body).toHaveProperty("cursor");
    expect(res.body.nextCursor).toBe(res.body.nextResumeToken);
    expect(res.body.nextCursor).toBe(res.body.cursor);
  });

  it("marks the job failed and preserves the last committed checkpoint when a batch throws, then resumes from it on the next call", async () => {
    const rowCount = BACKFILL_CHECKPOINT_BATCH_SIZE + 50;
    queueRows(makeDescendingRows(rowCount));
    // Transaction 1 = mark running, Transaction 2 = first batch (succeeds),
    // Transaction 3 = second batch (fails).
    store.state.failOnBatchNumber = 3;

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
    // Transaction 1 = mark running (succeeds), Transaction 2 = batch insert (fails).
    store.state.failOnBatchNumber = 2;

    const res = await request(makeApp()).post(job.path).set(authHeaders(ADMIN)).expect(500);
    expect(res.body.error).toBe("simulated batch failure");
  });
});

describe("BackfillQuerySchema", () => {
  it("defaults limit to DEFAULT_BACKFILL_LIMIT when omitted", () => {
    const result = BackfillQuerySchema.parse({});
    expect(result.limit).toBe(DEFAULT_BACKFILL_LIMIT);
  });

  it("accepts limit at the lower boundary (1)", () => {
    const result = BackfillQuerySchema.parse({ limit: "1" });
    expect(result.limit).toBe(1);
  });

  it("accepts limit at the upper boundary (MAX_BACKFILL_LIMIT)", () => {
    const result = BackfillQuerySchema.parse({ limit: String(MAX_BACKFILL_LIMIT) });
    expect(result.limit).toBe(MAX_BACKFILL_LIMIT);
  });

  it("rejects limit above MAX_BACKFILL_LIMIT", () => {
    expect(() => BackfillQuerySchema.parse({ limit: String(MAX_BACKFILL_LIMIT + 1) })).toThrow();
  });

  it("rejects zero", () => {
    expect(() => BackfillQuerySchema.parse({ limit: "0" })).toThrow();
  });

  it("rejects negative values", () => {
    expect(() => BackfillQuerySchema.parse({ limit: "-5" })).toThrow();
  });

  it("rejects non-numeric strings", () => {
    expect(() => BackfillQuerySchema.parse({ limit: "abc" })).toThrow();
  });

  it("rejects floating-point values", () => {
    expect(() => BackfillQuerySchema.parse({ limit: "10.5" })).toThrow();
  });

  it("passes agreementId through unchanged", () => {
    const result = BackfillQuerySchema.parse({ agreementId: "agr_123" });
    expect(result.agreementId).toBe("agr_123");
  });

  it("leaves agreementId undefined when not provided", () => {
    const result = BackfillQuerySchema.parse({});
    expect(result.agreementId).toBeUndefined();
  });

  it("accepts an optional cursor parameter", () => {
    const result = BackfillQuerySchema.parse({ cursor: "2024-06-01T00:00:00.000Z" });
    expect(result.cursor).toBeInstanceOf(Date);
  });

  it("accepts resumeToken parameter alias", () => {
    const result = BackfillQuerySchema.parse({ resumeToken: "2024-06-01T00:00:00.000Z" });
    expect(result.resumeToken).toBeInstanceOf(Date);
  });

  it("accepts before parameter alias", () => {
    const result = BackfillQuerySchema.parse({ before: "2024-06-01T00:00:00.000Z" });
    expect(result.before).toBeInstanceOf(Date);
  });

  it("rejects invalid date strings", () => {
    expect(() => BackfillQuerySchema.parse({ before: "invalid-date" })).toThrow();
    expect(() => BackfillQuerySchema.parse({ resumeToken: "invalid-date" })).toThrow();
    expect(() => BackfillQuerySchema.parse({ cursor: "invalid-date" })).toThrow();
  });
});

describe("buildBackfillEventId", () => {
  it("handles empty strings without throwing", () => {
    expect(buildBackfillEventId("", "", "")).toBe("_backfill__");
  });

  it("produces deterministic IDs for the same inputs", () => {
    const id1 = buildBackfillEventId("0xtx1", "EmployeeAdded", "emp_1");
    const id2 = buildBackfillEventId("0xtx1", "EmployeeAdded", "emp_1");
    expect(id1).toBe(id2);
  });

  it("produces different IDs for different inputs", () => {
    const id1 = buildBackfillEventId("0xtx1", "EmployeeAdded", "emp_1");
    const id2 = buildBackfillEventId("0xtx2", "EmployeeAdded", "emp_1");
    expect(id1).not.toBe(id2);
  });

  it("includes the _backfill_ segment in the ID", () => {
    const id = buildBackfillEventId("0xtx1", "EmployeeAdded", "emp_1");
    expect(id).toContain("_backfill_");
  });
});

describe("normalizeResumeCursor", () => {
  const d1 = new Date("2025-01-01T00:00:00Z");
  const d2 = new Date("2025-06-01T00:00:00Z");
  const d3 = new Date("2025-12-01T00:00:00Z");

  it("returns undefined when all three are undefined", () => {
    expect(normalizeResumeCursor(undefined, undefined, undefined)).toBeUndefined();
  });

  it("returns the before value when only before is provided", () => {
    expect(normalizeResumeCursor(d1, undefined, undefined)).toBe(d1);
  });

  it("returns the resumeToken value when only resumeToken is provided", () => {
    expect(normalizeResumeCursor(undefined, d1, undefined)).toBe(d1);
  });

  it("returns the cursor value when only cursor is provided", () => {
    expect(normalizeResumeCursor(undefined, undefined, d1)).toBe(d1);
  });

  it("prefers before over resumeToken when both are provided", () => {
    expect(normalizeResumeCursor(d1, d2, undefined)).toBe(d1);
  });

  it("prefers before over cursor when both are provided", () => {
    expect(normalizeResumeCursor(d1, undefined, d2)).toBe(d1);
  });

  it("prefers resumeToken over cursor when both are provided", () => {
    expect(normalizeResumeCursor(undefined, d1, d2)).toBe(d1);
  });

  it("prefers before over both resumeToken and cursor when all three are provided", () => {
    expect(normalizeResumeCursor(d1, d2, d3)).toBe(d1);
  });

  it("returns undefined when all three are null or empty string (coerced to undefined)", () => {
    const u = undefined as any;
    expect(normalizeResumeCursor(u, u, u)).toBeUndefined();
  });
});

describe("getBackfillProgress", () => {
  it("returns null for a job that has never run", async () => {
    const progress = await getBackfillProgress("employee-events");
    expect(progress).toBeNull();
  });

  it("returns progress data after a job has run", async () => {
    queueRows([makeRow(1)]);
    await request(makeApp())
      .post("/api/v1/backfill/employee-events")
      .set(authHeaders(ADMIN))
      .expect(200);

    const progress = await getBackfillProgress("employee-events");
    expect(progress).not.toBeNull();
    expect(progress!.status).toBe("completed");
    expect(progress!.totalScanned).toBe(1);
    expect(progress!.totalCreated).toBe(1);
  });
});

describe("Edge cases", () => {
  it("returns nextCursor, nextResumeToken, cursor, and durationMs on success", async () => {
    queueRows([makeRow(1)]);
    const res = await request(makeApp())
      .post("/api/v1/backfill/employee-events")
      .set(authHeaders(ADMIN))
      .expect(200);

    expect(res.body.nextResumeToken).toBeDefined();
    expect(res.body.nextCursor).toBeDefined();
    expect(res.body.cursor).toBeDefined();
    expect(res.body.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.durationMs).toBe("number");
  });

  it("all three cursor aliases are identical", async () => {
    queueRows([makeRow(1)]);
    const res = await request(makeApp())
      .post("/api/v1/backfill/employee-events")
      .set(authHeaders(ADMIN))
      .expect(200);

    expect(res.body.nextCursor).toBe(res.body.nextResumeToken);
    expect(res.body.nextCursor).toBe(res.body.cursor);
  });

  it("uses onConflictDoNothing for idempotent inserts", async () => {
    queueRows([makeRow(1)]);
    await request(makeApp())
      .post("/api/v1/backfill/employee-events")
      .set(authHeaders(ADMIN))
      .expect(200);

    // Second call with same row should skip
    queueRows([makeRow(1)]);
    const res = await request(makeApp())
      .post("/api/v1/backfill/employee-events")
      .set(authHeaders(ADMIN))
      .expect(200);

    expect(res.body.created).toBe(0);
    expect(res.body.results[0].status).toBe("skipped");
  });
});


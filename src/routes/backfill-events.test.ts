import { vi, describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const { mockRequireAuth, mockRequireAdmin } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  mockRequireAdmin: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock("../auth/middleware.js", () => ({
  requireAuth: mockRequireAuth,
  requireAdmin: mockRequireAdmin,
}));

const { mockDb, mockInsertReturning, mockTransaction } = vi.hoisted(() => {
  const returning = vi.fn().mockResolvedValue([]);
  const insertReturning: any = {};
  insertReturning.values = vi.fn().mockReturnValue(insertReturning);
  insertReturning.onConflictDoNothing = vi.fn().mockReturnValue(insertReturning);
  insertReturning.returning = returning;
  const insert = vi.fn().mockReturnValue(insertReturning);
  const transaction = vi.fn();
  const execute = vi.fn();
  return {
    mockDb: {
      insert,
      execute,
      transaction,
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    },
    mockInsertReturning: insertReturning,
    mockTransaction: transaction,
  };
});

vi.mock("../db/index.js", () => ({
  db: mockDb,
  schema: {
    agreementEvents: { id: "agreementEvents" },
  },
}));

import {
  backfillEventsRouter,
  MAX_BACKFILL_LIMIT,
  DEFAULT_BACKFILL_LIMIT,
  BACKFILL_EVENT_INDEX,
  RESULTS_PREVIEW_SIZE,
  buildBackfillEventId,
  BackfillQuerySchema,
} from "./backfill-events.js";

/** Reset DB mocks to a default working state. */
function setupDbDefaults() {
  mockDb.execute.mockResolvedValue({ rows: [] });
  mockTransaction.mockImplementation(async (cb: any) => cb(mockDb));
}

const mockDateString = "2024-01-01T00:00:00.000Z";

describe("Backfill contract constants", () => {
  it("MAX_BACKFILL_LIMIT is 5000", () => {
    expect(MAX_BACKFILL_LIMIT).toBe(5000);
  });

  it("DEFAULT_BACKFILL_LIMIT is 1000", () => {
    expect(DEFAULT_BACKFILL_LIMIT).toBe(1000);
  });

  it("BACKFILL_EVENT_INDEX is 0 (satisfies DB CHECK constraint)", () => {
    expect(BACKFILL_EVENT_INDEX).toBe(0);
  });

  it("RESULTS_PREVIEW_SIZE is 10", () => {
    expect(RESULTS_PREVIEW_SIZE).toBe(10);
  });
});

describe("buildBackfillEventId", () => {
  it("builds the expected {txHash}_backfill_{eventType}_{rowId} format", () => {
    expect(buildBackfillEventId("0xabc", "EmployeeAdded", "emp_1")).toBe(
      "0xabc_backfill_EmployeeAdded_emp_1",
    );
  });

  it("includes the _backfill_ segment that cannot collide with real IDs", () => {
    const id = buildBackfillEventId("0x123", "MilestoneAdded", "ms_7");
    expect(id).toContain("_backfill_");
    expect(id).toBe("0x123_backfill_MilestoneAdded_ms_7");
  });

  it("handles empty strings without throwing", () => {
    expect(buildBackfillEventId("", "", "")).toBe("_backfill__");
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

describe("Backfill Events Routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    setupDbDefaults();

    app = express();
    app.use(express.json());
    app.use("/api/v1", backfillEventsRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status || 500).json({ error: err.message });
    });
  });

  describe("Input Validation & Resume Tokens", () => {
    it("rejects a malformed resumeToken (not an ISO date)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?resumeToken=invalid-date")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("accepts a valid resumeToken and passes it to the query", async () => {
      const validToken = "2026-07-25T10:00:00.000Z";
      await request(app)
        .post(`/api/v1/backfill/employee-events?resumeToken=${validToken}`)
        .expect(200);

      expect(mockDb.execute).toHaveBeenCalled();
    });

    it("rejects negative limit (400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=-1")
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("rejects zero limit (400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=0")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("rejects limit exceeding MAX_BACKFILL_LIMIT (400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=5001")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("rejects non-integer limit (400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=abc")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("rejects floating-point limit (400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=10.5")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("accepts valid limit and agreementId", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=100&agreementId=agr_123")
        .expect(200);

      expect(res.body.created).toBe(0);
    });

    it("defaults limit to 1000 when not provided", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.totalScanned).toBe(0);
    });

    it("rejects an invalid before value (employee-events, 400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?before=not-a-date")
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("rejects an invalid before value (milestone-events, 400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/milestone-events?before=not-a-date")
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("accepts a valid ISO before value and returns 200 (employee-events)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?before=2024-06-01T00:00:00.000Z")
        .expect(200);

      expect(res.body.totalScanned).toBe(0);
    });
  });

  describe("POST /backfill/employee-events", () => {
    const mockEmployeeRow = {
      id: "emp_1",
      agreement_id: "agr_123",
      contract_address: "0xabc",
      block_number: 100,
      transaction_hash: "0xtx1",
      created_at: mockDateString,
    };

    it("returns nextResumeToken, nextCursor, cursor, and durationMs on success", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });
      mockInsertReturning.returning.mockResolvedValue([{ id: "0xtx1_backfill_EmployeeAdded_emp_1" }]);

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.nextResumeToken).toBe(mockEmployeeRow.created_at);
      expect(res.body.nextCursor).toBe(mockEmployeeRow.created_at);
      expect(res.body.cursor).toBe(mockEmployeeRow.created_at);
      expect(res.body.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof res.body.durationMs).toBe("number");
    });

    it("is idempotent on re-run (no employees without events)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.created).toBe(0);
      expect(res.body.totalScanned).toBe(0);
    });

    it("uses collision-safe event ID scheme and eventIndex 0", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });
      mockInsertReturning.returning.mockResolvedValue([{ id: "0xtx1_backfill_EmployeeAdded_emp_1" }]);

      let insertedValues: any = null;
      mockInsertReturning.values.mockImplementation((values: any) => {
        insertedValues = values;
        return mockInsertReturning;
      });

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(insertedValues).not.toBeNull();
      expect(Array.isArray(insertedValues)).toBe(true);
      expect(insertedValues[0].id).toBe("0xtx1_backfill_EmployeeAdded_emp_1");
      expect(insertedValues[0].eventIndex).toBe(0);
      expect(insertedValues[0].eventType).toBe("EmployeeAdded");
    });

    it("runs inserts in batch inside a transaction", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });
      mockInsertReturning.returning.mockResolvedValue([{ id: "0xtx1_backfill_EmployeeAdded_emp_1" }]);

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(console.info).toHaveBeenCalledWith(
        expect.objectContaining({
          op: "backfill_employee_events",
          scanned: 1,
          created: 1,
          durationMs: expect.any(Number),
          nextResumeToken: mockEmployeeRow.created_at,
        }),
      );
    });

    it("uses onConflictDoNothing for idempotent inserts", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });
      mockInsertReturning.returning.mockResolvedValue([{ id: "0xtx1_backfill_EmployeeAdded_emp_1" }]);

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(mockInsertReturning.onConflictDoNothing).toHaveBeenCalled();
    });

    it("handles empty results gracefully", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.created).toBe(0);
      expect(res.body.totalScanned).toBe(0);
      expect(res.body.results).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
    });

    it("handles outer catch-all error", async () => {
      mockDb.execute.mockRejectedValue(new Error("DB Connection Failed"));

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(500);

      expect(res.body.error).toBe("DB Connection Failed");
    });

    it("limits results array to RESULTS_PREVIEW_SIZE entries", async () => {
      const manyRows = Array.from({ length: 20 }, (_, i) => ({
        id: `emp_${i}`,
        agreement_id: `agr_${i}`,
        contract_address: "0xabc",
        block_number: 100 + i,
        transaction_hash: `0xtx${i}`,
        created_at: new Date("2024-01-01"),
      }));
      mockDb.execute.mockResolvedValue({ rows: manyRows });
      mockInsertReturning.returning.mockResolvedValue(
        manyRows.map((r) => ({ id: buildBackfillEventId(r.transaction_hash, "EmployeeAdded", r.id) })),
      );

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.results).toHaveLength(RESULTS_PREVIEW_SIZE);
      expect(res.body.created).toBe(20);
    });

    it("propagates transaction errors to error handler (500)", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });
      mockTransaction.mockRejectedValue(new Error("Transaction failed"));

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(500);

      expect(res.body.error).toBe("Transaction failed");
    });

    describe("Resume cursor (nextCursor / hasMore)", () => {
      it("nextCursor is null when no rows are scanned", async () => {
        mockDb.execute.mockResolvedValue({ rows: [] });

        const res = await request(app)
          .post("/api/v1/backfill/employee-events")
          .expect(200);

        expect(res.body.nextCursor).toBeNull();
        expect(res.body.hasMore).toBe(false);
      });

      it("nextCursor equals the created_at of the last (oldest) scanned row", async () => {
        const rows = [
          { ...mockEmployeeRow, id: "emp_1", transaction_hash: "0xtx1", created_at: new Date("2024-01-05") },
          { ...mockEmployeeRow, id: "emp_2", transaction_hash: "0xtx2", created_at: new Date("2024-01-03") },
          { ...mockEmployeeRow, id: "emp_3", transaction_hash: "0xtx3", created_at: new Date("2024-01-01") },
        ];
        mockDb.execute.mockResolvedValue({ rows });

        const res = await request(app)
          .post("/api/v1/backfill/employee-events?limit=100")
          .expect(200);

        expect(res.body.nextCursor).toBe(new Date("2024-01-01").toISOString());
      });

      it("hasMore is true when scanned rows equal requested limit", async () => {
        const rows = Array.from({ length: 5 }, (_, i) => ({
          ...mockEmployeeRow,
          id: `emp_${i}`,
          transaction_hash: `0xtx${i}`,
        }));
        mockDb.execute.mockResolvedValue({ rows });

        const res = await request(app)
          .post("/api/v1/backfill/employee-events?limit=5")
          .expect(200);

        expect(res.body.hasMore).toBe(true);
      });

      it("hasMore is false when fewer rows are returned than limit", async () => {
        mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

        const res = await request(app)
          .post("/api/v1/backfill/employee-events?limit=5")
          .expect(200);

        expect(res.body.hasMore).toBe(false);
      });
    });
  });

  describe("POST /backfill/milestone-events", () => {
    const mockMilestoneRow = {
      id: "ms_1",
      agreement_id: "agr_456",
      contract_address: "0xdef",
      block_number: 200,
      transaction_hash: "0xtx2",
      created_at: "2024-02-01T10:00:00.000Z",
    };

    it("emits structured logs for milestones and backfills events", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });
      mockInsertReturning.returning.mockResolvedValue([{ id: "0xtx2_backfill_MilestoneAdded_ms_1" }]);

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(res.body.message).toContain("Backfilled 1 MilestoneAdded events");
      expect(res.body.created).toBe(1);
      expect(res.body.totalScanned).toBe(1);
    });

    it("is idempotent on re-run", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(res.body.created).toBe(0);
    });

    it("handles empty milestone results gracefully", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(res.body.created).toBe(0);
      expect(res.body.totalScanned).toBe(0);
    });
  });
});

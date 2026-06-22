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
  const onConflictDoNothing = vi.fn().mockResolvedValue({});
  const insertReturning = { values: vi.fn().mockReturnThis(), onConflictDoNothing };
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

import { backfillEventsRouter } from "./backfill-events.js";

/** Reset DB mocks to a default working state. */
function setupDbDefaults() {
  mockDb.execute.mockResolvedValue({ rows: [] });
  mockTransaction.mockImplementation(async (cb: any) => cb(mockDb));
}

describe("Backfill Events Routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDbDefaults();

    app = express();
    app.use(express.json());
    app.use("/api/v1", backfillEventsRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status || 500).json({ error: err.message });
    });
  });

  describe("Authentication & Authorization", () => {
    it("rejects unauthenticated requests (requireAuth fails)", async () => {
      mockRequireAuth.mockImplementationOnce((_req: any, res: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(401);

      expect(res.body).toEqual({ error: "Unauthorized" });
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("rejects non-admin requests (requireAdmin fails)", async () => {
      mockRequireAdmin.mockImplementationOnce((_req: any, res: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(401);

      expect(res.body).toEqual({ error: "Unauthorized" });
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests for milestone backfill", async () => {
      mockRequireAuth.mockImplementationOnce((_req: any, res: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(401);

      expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("rejects non-admin requests for milestone backfill", async () => {
      mockRequireAdmin.mockImplementationOnce((_req: any, res: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(401);

      expect(res.body).toEqual({ error: "Unauthorized" });
    });
  });

  describe("Input Validation", () => {
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
  });

  describe("POST /backfill/employee-events", () => {
    const mockEmployeeRow = {
      id: "emp_1",
      agreement_id: "agr_123",
      contract_address: "0xabc",
      block_number: 100,
      transaction_hash: "0xtx1",
      created_at: new Date("2024-01-01"),
    };

    it("backfills EmployeeAdded events successfully", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.message).toContain("Backfilled 1 EmployeeAdded events");
      expect(res.body.created).toBe(1);
      expect(res.body.totalScanned).toBe(1);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0]).toEqual({
        employeeId: "emp_1",
        agreementId: "agr_123",
        status: "created",
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it("is idempotent on re-run (no new employees without events)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.created).toBe(0);
      expect(res.body.totalScanned).toBe(0);
    });

    it("uses collision-safe event ID scheme and eventIndex -1", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      let insertedValues: any = null;
      mockInsertReturning.values.mockImplementation((values: any) => {
        insertedValues = values;
        return mockInsertReturning;
      });

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(insertedValues).not.toBeNull();
      expect(insertedValues.id).toBe("0xtx1_backfill_EmployeeAdded_emp_1");
      expect(insertedValues.eventIndex).toBe(-1);
      expect(insertedValues.eventType).toBe("EmployeeAdded");
    });

    it("runs inserts inside a transaction", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(mockTransaction).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("uses onConflictDoNothing for idempotent inserts", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(mockInsertReturning.onConflictDoNothing).toHaveBeenCalled();
    });

    it("filters by agreementId when query param is provided", async () => {
      await request(app)
        .post("/api/v1/backfill/employee-events?agreementId=agr_123")
        .expect(200);

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("handles empty results gracefully", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.created).toBe(0);
      expect(res.body.totalScanned).toBe(0);
      expect(res.body.results).toEqual([]);
    });

    it("handles outer catch-all error", async () => {
      mockDb.execute.mockRejectedValue(new Error("DB Connection Failed"));

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(500);

      expect(res.body.error).toBe("DB Connection Failed");
    });

    it("limits results array to 10 entries", async () => {
      const manyRows = Array.from({ length: 20 }, (_, i) => ({
        id: `emp_${i}`,
        agreement_id: `agr_${i}`,
        contract_address: "0xabc",
        block_number: 100 + i,
        transaction_hash: `0xtx${i}`,
        created_at: new Date("2024-01-01"),
      }));
      mockDb.execute.mockResolvedValue({ rows: manyRows });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.results).toHaveLength(10);
      expect(res.body.created).toBe(20);
    });
  });

  describe("POST /backfill/milestone-events", () => {
    const mockMilestoneRow = {
      id: "ms_1",
      agreement_id: "agr_456",
      contract_address: "0xdef",
      block_number: 200,
      transaction_hash: "0xtx2",
      created_at: new Date("2024-02-01"),
    };

    it("backfills MilestoneAdded events successfully", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

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

    it("uses collision-safe event IDs", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      let insertedValues: any = null;
      mockInsertReturning.values.mockImplementation((values: any) => {
        insertedValues = values;
        return mockInsertReturning;
      });

      await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(insertedValues!.id).toBe("0xtx2_backfill_MilestoneAdded_ms_1");
      expect(insertedValues!.eventIndex).toBe(-1);
      expect(insertedValues!.eventType).toBe("MilestoneAdded");
    });

    it("runs inserts inside a transaction", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(mockTransaction).toHaveBeenCalled();
    });

    it("uses onConflictDoNothing for idempotent inserts", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(mockInsertReturning.onConflictDoNothing).toHaveBeenCalled();
    });

    it("handles empty results gracefully", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(res.body.created).toBe(0);
      expect(res.body.totalScanned).toBe(0);
    });

    it("handles outer catch-all error", async () => {
      mockDb.execute.mockRejectedValue(new Error("DB Connection Failed"));

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(500);

      expect(res.body.error).toBe("DB Connection Failed");
    });
  });
});

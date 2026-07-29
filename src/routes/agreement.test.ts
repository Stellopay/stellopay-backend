import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { ZodError } from "zod";

const { dbMock, schemaMock, mockProvider } = vi.hoisted(() => {
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  const schema = {
    agreements: {
      contractAddress: "contractAddress",
      id: "id",
      employer: "employer",
      contributor: "contributor",
      token: "token",
      mode: "mode",
      status: "status",
      totalAmount: "totalAmount",
      paidAmount: "paidAmount",
    },
    employees: {
      contractAddress: "contractAddress",
      agreementId: "agreementId",
      employeeIndex: "employeeIndex",
    },
  };
  const mockProvider = {
    getNonceForAddress: vi.fn().mockResolvedValue("0x0"),
    getChainId: vi.fn().mockResolvedValue("0x534e5f5345504f4c4941"),
    getTransactionReceipt: vi.fn().mockResolvedValue({
      events: [
        {
          from_address: "0x000000000000000000000000000000000000000000000000000000000000aaaa",
          data: ["0x1"],
        },
      ],
    }),
  };
  return { dbMock: db, schemaMock: schema, mockProvider };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("../db/schema.js", () => ({
  agreements: schemaMock.agreements,
  employees: schemaMock.employees,
}));
vi.mock("../starknet/client.js", () => ({
  provider: mockProvider,
  agreementContract: vi.fn().mockReturnValue({
    get_employer: vi.fn().mockResolvedValue("0x1"),
    get_contributor: vi.fn().mockResolvedValue("0x2"),
    get_status: vi.fn().mockResolvedValue(1),
    get_agreement_mode: vi.fn().mockResolvedValue(0),
    get_total_amount: vi.fn().mockResolvedValue(0n),
    get_paid_amount: vi.fn().mockResolvedValue(0n),
    populate: vi.fn().mockReturnValue({
      contractAddress: "0xcontract",
      entrypoint: "test",
      calldata: [],
    }),
  }),
}));
vi.mock("../auth/session.js", () => ({
  requireSession: vi.fn().mockResolvedValue(true),
}));
vi.mock("./events.js", async () => {
  const { z } = await import("zod");
  return {
    TxHashSchema: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  };
});

import { agreementRouter } from "./agreement";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", agreementRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    const isZodError = err instanceof ZodError;
    res.status(isZodError ? 400 : (err.status ?? 500)).json({
      error: isZodError ? "Validation failed" : (err.message ?? "Internal error"),
      details: err.issues,
    });
  });
  return app;
}

describe("Agreement Routes Schema Validation", () => {
  const validWallet = "0x0000000000000000000000000000000000000000000000000000000000001111";
  const validSession = "session-token-123456789";
  const validAddress = "0x000000000000000000000000000000000000000000000000000000000000aaaa";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /prepare/agreement/:address/create_time_based_agreement", () => {
    it("accepts a valid payload", async () => {
      const app = makeApp();
      const res = await request(app)
        .post(`/api/v1/prepare/agreement/${validAddress}/create_time_based_agreement`)
        .send({
          wallet_address: validWallet,
          session_token: validSession,
          employer: validAddress,
          contributor: validAddress,
          token: validAddress,
          amount_per_period: "1000",
          period_seconds: 3600,
          num_periods: 12,
        });

      expect(res.status).toBe(200);
      expect(res.body.call).toBeDefined();
    });

    it("rejects invalid addresses", async () => {
      const app = makeApp();
      const badAddresses = ["", "invalid-address", "0xG123"];

      for (const bad of badAddresses) {
        const res = await request(app)
          .post(`/api/v1/prepare/agreement/${validAddress}/create_time_based_agreement`)
          .send({
            wallet_address: validWallet,
            session_token: validSession,
            employer: bad,
            contributor: validAddress,
            token: validAddress,
            amount_per_period: "1000",
            period_seconds: 3600,
            num_periods: 12,
          });

        expect(res.status).toBe(400);
      }
    });

    it("rejects invalid amount_per_period", async () => {
      const app = makeApp();
      const badAmounts = ["", "abc", "-100", "12.34", "0123"];

      for (const bad of badAmounts) {
        const res = await request(app)
          .post(`/api/v1/prepare/agreement/${validAddress}/create_time_based_agreement`)
          .send({
            wallet_address: validWallet,
            session_token: validSession,
            employer: validAddress,
            contributor: validAddress,
            token: validAddress,
            amount_per_period: bad,
            period_seconds: 3600,
            num_periods: 12,
          });

        expect(res.status).toBe(400);
      }
    });

    it("rejects invalid period_seconds (negative or non-bigint)", async () => {
      const app = makeApp();
      const res = await request(app)
        .post(`/api/v1/prepare/agreement/${validAddress}/create_time_based_agreement`)
        .send({
          wallet_address: validWallet,
          session_token: validSession,
          employer: validAddress,
          contributor: validAddress,
          token: validAddress,
          amount_per_period: "1000",
          period_seconds: -3600,
          num_periods: 12,
        });

      expect(res.status).toBe(400);
    });

    it("rejects invalid num_periods (non-positive)", async () => {
      const app = makeApp();
      const res = await request(app)
        .post(`/api/v1/prepare/agreement/${validAddress}/create_time_based_agreement`)
        .send({
          wallet_address: validWallet,
          session_token: validSession,
          employer: validAddress,
          contributor: validAddress,
          token: validAddress,
          amount_per_period: "1000",
          period_seconds: 3600,
          num_periods: 0,
        });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /prepare/agreement/:address/add_employee", () => {
    it("accepts a valid payload", async () => {
      const app = makeApp();
      const res = await request(app)
        .post(`/api/v1/prepare/agreement/${validAddress}/add_employee`)
        .send({
          wallet_address: validWallet,
          session_token: validSession,
          agreement_id: 1,
          employee: validAddress,
          salary_per_period: "5000",
        });

      expect(res.status).toBe(200);
    });

    it("rejects invalid employee address", async () => {
      const app = makeApp();
      const res = await request(app)
        .post(`/api/v1/prepare/agreement/${validAddress}/add_employee`)
        .send({
          wallet_address: validWallet,
          session_token: validSession,
          agreement_id: 1,
          employee: "not-a-valid-address",
          salary_per_period: "5000",
        });

      expect(res.status).toBe(400);
    });

    it("rejects invalid salary_per_period", async () => {
      const app = makeApp();
      const res = await request(app)
        .post(`/api/v1/prepare/agreement/${validAddress}/add_employee`)
        .send({
          wallet_address: validWallet,
          session_token: validSession,
          agreement_id: 1,
          employee: validAddress,
          salary_per_period: "abc",
        });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /agreement/:address/get_agreement_id_from_tx", () => {
    it("accepts valid transaction hashes", async () => {
      const app = makeApp();
      const validTx = "0x" + "a".repeat(64);
      mockProvider.getNonceForAddress.mockResolvedValue("0x0");
      
      const res = await request(app)
        .post(`/api/v1/agreement/${validAddress}/get_agreement_id_from_tx`)
        .send({ tx_hash: validTx });

      expect(res.status).not.toBe(400);
    });

    it("rejects invalid transaction hashes", async () => {
      const app = makeApp();
      const badTxs = ["", "invalid-tx", "0x" + "g".repeat(64), "0x123"];

      for (const bad of badTxs) {
        const res = await request(app)
          .post(`/api/v1/agreement/${validAddress}/get_agreement_id_from_tx`)
          .send({ tx_hash: bad });

        expect(res.status).toBe(400);
      }
    });
  });

  describe("POST /agreement/:address/bulk-status", () => {
    it("returns indexed statuses and per-id not-found results from one query", async () => {
      dbMock.where.mockResolvedValueOnce([
        { id: "1", status: 0 },
        { id: "3", status: 5 },
      ]);
      const app = makeApp();

      const res = await request(app)
        .post(`/api/v1/agreement/${validAddress}/bulk-status`)
        .send({ agreement_ids: [1, "2", 3] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        results: [
          { agreement_id: "1", found: true, status: 0 },
          { agreement_id: "2", found: false, status: null },
          { agreement_id: "3", found: true, status: 5 },
        ],
        source: "indexed",
      });
      expect(dbMock.select).toHaveBeenCalledTimes(1);
      expect(dbMock.from).toHaveBeenCalledTimes(1);
      expect(dbMock.where).toHaveBeenCalledTimes(1);
    });

    it("preserves duplicate ids in response order while querying once", async () => {
      dbMock.where.mockResolvedValueOnce([{ id: "7", status: 2 }]);
      const app = makeApp();

      const res = await request(app)
        .post(`/api/v1/agreement/${validAddress}/bulk-status`)
        .send({ agreement_ids: [7, 7] });

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([
        { agreement_id: "7", found: true, status: 2 },
        { agreement_id: "7", found: true, status: 2 },
      ]);
      expect(dbMock.where).toHaveBeenCalledTimes(1);
    });

    it.each([
      { agreement_ids: [] },
      { agreement_ids: [0] },
      { agreement_ids: [-1] },
      { agreement_ids: [1.5] },
      { agreement_ids: ["1 OR 1=1"] },
      { agreement_ids: ["1".repeat(79)] },
      { agreement_ids: [true] },
      { agreement_ids: [1], unexpected: true },
    ])("rejects an invalid body without querying the database: %j", async (body) => {
      const app = makeApp();

      const res = await request(app)
        .post(`/api/v1/agreement/${validAddress}/bulk-status`)
        .send(body);

      expect(res.status).toBe(400);
      expect(dbMock.select).not.toHaveBeenCalled();
    });

    it("rejects batches larger than 50 ids without querying the database", async () => {
      const app = makeApp();

      const res = await request(app)
        .post(`/api/v1/agreement/${validAddress}/bulk-status`)
        .send({ agreement_ids: Array.from({ length: 51 }, (_, index) => index + 1) });

      expect(res.status).toBe(400);
      expect(dbMock.select).not.toHaveBeenCalled();
    });

    it("rejects an invalid contract address without querying the database", async () => {
      const app = makeApp();

      const res = await request(app)
        .post("/api/v1/agreement/not-an-address/bulk-status")
        .send({ agreement_ids: [1] });

      expect(res.status).toBe(400);
      expect(dbMock.select).not.toHaveBeenCalled();
    });

    it("forwards a database failure to the central error handler", async () => {
      dbMock.where.mockRejectedValueOnce(new Error("Database unavailable"));
      const app = makeApp();

      const res = await request(app)
        .post(`/api/v1/agreement/${validAddress}/bulk-status`)
        .send({ agreement_ids: [1] });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Database unavailable");
      expect(dbMock.where).toHaveBeenCalledTimes(1);
    });
  });
});

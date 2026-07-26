import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";

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

import { agreementRouter } from "./agreement";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", agreementRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 400).json({ error: err.message, details: err.issues });
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
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { escrowRouter } from "./escrow.js";
import { db, schema } from "../db/index.js";

const mockEscrow = {
  get_token: vi.fn(),
  get_agreement_balance: vi.fn(),
  get_agreement_employer: vi.fn(),
  populate: vi.fn(),
};

vi.mock("../starknet/client.js", () => ({
  provider: {
    getNonceForAddress: vi.fn(),
    getChainId: vi.fn(),
  },
  escrowContract: vi.fn(() => mockEscrow),
}));

vi.mock("../auth/session.js", () => ({
  requireSession: vi.fn(),
}));

vi.mock("../db/index.js", () => {
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(),
          })),
        })),
      })),
    },
    schema: {
      escrowEvents: {
        contractAddress: "contractAddress",
        agreementId: "agreementId",
        blockNumber: "blockNumber",
      },
    },
  };
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", escrowRouter);
  // Add a generic error handler to prevent 500s from blowing up the test output
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

describe("escrow routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /escrow/:address/get_agreement_balance/:agreement_id", () => {
    it("returns balance from indexed data when available", async () => {
      const mockOrderBy = vi.fn().mockResolvedValue([
        { eventType: "Funded", amount: "1000" },
        { eventType: "Released", amount: "200" },
        { eventType: "Refunded", amount: "100" },
      ]);
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({
        agreement_id: "1",
        balance: "700",
        source: "indexed",
      });
    });

    it("clamps negative balance to zero", async () => {
      const mockOrderBy = vi.fn().mockResolvedValue([
        { eventType: "Funded", amount: "100" },
        { eventType: "Released", amount: "200" }, // More released than funded
      ]);
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({
        agreement_id: "1",
        balance: "0",
        source: "indexed",
      });
    });

    it("falls back to contract call when indexed data is empty", async () => {
      const mockOrderBy = vi.fn().mockResolvedValue([]);
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 500n, high: 0n });

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({
        agreement_id: "1",
        balance: "500",
        source: "contract",
      });
    });

    it("falls back to contract call when db throws", async () => {
      const mockOrderBy = vi.fn().mockRejectedValue(new Error("DB Error"));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 500n, high: 0n });

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({
        agreement_id: "1",
        balance: "500",
        source: "contract",
      });
    });
  });

  describe("POST /prepare/escrow/:address/release", () => {
    it("returns prepared call successfully", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);

      mockEscrow.populate.mockReturnValue({ contractAddress: "0x123", entrypoint: "release", calldata: [] });
      const { provider } = await import("../starknet/client.js");
      (provider.getNonceForAddress as any).mockResolvedValue("0x1");
      (provider.getChainId as any).mockResolvedValue("0x534e5f4d41494e"); // SN_MAIN

      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0x123/release")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "100",
        })
        .expect(200);

      expect(res.body).toMatchObject({
        call: { contractAddress: "0x123", entrypoint: "release", calldata: [] },
        wallet_address: "0xabc",
        nonce: "0x1",
        chain_id: "0x534e5f4d41494e",
      });
    });

    it("returns 401 when session is invalid", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(false);

      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0x123/release")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "100",
        })
        .expect(401);

      expect(res.body).toEqual({ error: "Invalid session" });
    });
  });
});

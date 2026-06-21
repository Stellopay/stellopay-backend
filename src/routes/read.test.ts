import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { readRouter } from "./read.js";

// Mock starknet client
const mockEscrow = {
  get_token: vi.fn(),
  get_agreement_balance: vi.fn(),
  get_agreement_employer: vi.fn(),
};

const mockAgreement = {
  get_employer: vi.fn(),
  get_contributor: vi.fn(),
  get_token: vi.fn(),
  get_escrow: vi.fn(),
  get_total_amount: vi.fn(),
  get_paid_amount: vi.fn(),
  get_status: vi.fn(),
  get_agreement_mode: vi.fn(),
  get_dispute_status: vi.fn(),
};

vi.mock("../starknet/client.js", () => ({
  provider: {
    callContract: vi.fn(),
  },
  escrowContract: vi.fn(() => mockEscrow),
  agreementContract: vi.fn(() => mockAgreement),
}));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", readRouter);
  return app;
}

describe("read routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /escrow/:address/summary/:agreement_id", () => {
    it("returns correct summary and formats addresses using unified toHexString", async () => {
      mockEscrow.get_token.mockResolvedValue(12345n); // 0x3039
      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 2000000n, high: 0n });
      mockEscrow.get_agreement_employer.mockResolvedValue("0xabcd");

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x1234/summary/1")
        .expect(200);

      expect(res.body).toEqual({
        escrow: "0x1234",
        agreement_id: "1",
        employer: "0xabcd",
        token: "0x3039",
        balance: "2000000",
      });
    });
  });

  describe("GET /agreement/:address/summary/:agreement_id", () => {
    it("returns correct summary and formats addresses using unified toHexString", async () => {
      mockAgreement.get_employer.mockResolvedValue(100n); // 0x64
      mockAgreement.get_contributor.mockResolvedValue("0x200");
      mockAgreement.get_token.mockResolvedValue(300n); // 0x12c
      mockAgreement.get_escrow.mockResolvedValue(400n); // 0x190
      mockAgreement.get_total_amount.mockResolvedValue({ low: 1000n, high: 0n });
      mockAgreement.get_paid_amount.mockResolvedValue({ low: 500n, high: 0n });
      mockAgreement.get_status.mockResolvedValue(1n);
      mockAgreement.get_agreement_mode.mockResolvedValue(0n);
      mockAgreement.get_dispute_status.mockResolvedValue(2n);

      const res = await request(makeApp())
        .get("/api/v1/agreement/0x5678/summary/2")
        .expect(200);

      expect(res.body).toEqual({
        agreement: "0x5678",
        agreement_id: "2",
        employer: "0x64",
        contributor: "0x200",
        token: "0x12c",
        escrow: "0x190",
        total_amount: "1000",
        paid_amount: "500",
        status: 1,
        mode: 0,
        dispute_status: 2,
      });
    });
  });
});

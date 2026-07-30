import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { ZodError } from "zod";
import { escrowRouter, clearEscrowIdempotencyStore } from "./escrow.js";
import { db } from "../db/index.js";

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
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                offset: vi.fn(),
              })),
            })),
          })),
        })),
      })),
    },
    schema: {
      escrowEvents: {
        contractAddress: "contractAddress",
        agreementId: "agreementId",
        blockNumber: "blockNumber",
        id: "id",
      },
    },
  };
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", escrowRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const isZodError = err instanceof ZodError;
    res.status(isZodError ? 400 : 500).json({
      error: isZodError ? "Validation failed" : (err?.message ?? "Internal error"),
      details: isZodError ? err.issues : undefined,
    });
  });
  return app;
}

describe("escrow routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEscrowIdempotencyStore();

    // Default db.select chain to resolve to empty array on first call
    const mockOffset = vi.fn().mockResolvedValue([]);
    const mockLimit = vi.fn(() => ({ offset: mockOffset }));
    const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
    const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
    const mockFrom = vi.fn(() => ({ where: mockWhere }));
    (db.select as any).mockReturnValue({ from: mockFrom });

    mockEscrow.get_agreement_balance.mockResolvedValue({ low: 1000n, high: 0n });
  });

  describe("GET /escrow/:address/get_agreement_balance/:agreement_id", () => {
    it("returns balance from indexed data when available", async () => {
      const mockOffset = vi.fn().mockResolvedValue([
        { eventType: "Funded", amount: "1000" },
        { eventType: "Released", amount: "200" },
        { eventType: "Refunded", amount: "100" },
      ]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
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
      const mockOffset = vi.fn().mockResolvedValue([
        { eventType: "Funded", amount: "100" },
        { eventType: "Released", amount: "200" }, // More released than funded
      ]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
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
      const mockOffset = vi.fn().mockResolvedValue([]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
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
      const mockOffset = vi.fn().mockRejectedValue(new Error("DB Error"));
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
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

    it("deduplicates indexed events by unique event ID", async () => {
      const mockOffset = vi.fn().mockResolvedValue([
        { id: "evt-1", eventType: "Funded", amount: "1000" },
        { id: "evt-1", eventType: "Funded", amount: "1000" },
        { id: "evt-2", eventType: "Released", amount: "200" },
      ]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({
        agreement_id: "1",
        balance: "800",
        source: "indexed",
      });
    });
  });

  describe("POST /prepare/escrow/:address/release", () => {
    it("returns prepared call successfully", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);

      mockEscrow.populate.mockReturnValue({
        contractAddress: "0x123",
        entrypoint: "release",
        calldata: [],
      });
      mockEscrow.get_agreement_employer.mockResolvedValue("0xabc");
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
        nonce: "0x1",
        chain_id: "0x534e5f4d41494e",
      });
      // wallet_address is normalised to canonical 64-hex form
      expect(res.body.wallet_address).toMatch(/^0x0+abc$/);
    });

    it("rejects malformed release amounts with 400", async () => {
      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0x123/release")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "not-a-number",
        })
        .expect(400);

      expect(res.body).toMatchObject({
        error: "Validation failed",
      });
      expect(res.body.details).toEqual(expect.any(Array));
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

    it("returns cached prepared call when retried with same idempotency key and body", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);

      mockEscrow.populate.mockReturnValue({
        contractAddress: "0x123",
        entrypoint: "release",
        calldata: [],
      });
      const { provider } = await import("../starknet/client.js");
      (provider.getNonceForAddress as any).mockResolvedValue("0x1");
      (provider.getChainId as any).mockResolvedValue("0x534e5f4d41494e"); // SN_MAIN

      const payload = {
        wallet_address: "0xabc",
        session_token: "token123456",
        agreement_id: 1,
        to: "0xdef",
        amount: "100",
      };

      const res1 = await request(makeApp())
        .post("/api/v1/prepare/escrow/0x123/release")
        .set("Idempotency-Key", "idemp-key-1")
        .send(payload)
        .expect(200);

      const res2 = await request(makeApp())
        .post("/api/v1/prepare/escrow/0x123/release")
        .set("Idempotency-Key", "idemp-key-1")
        .send(payload)
        .expect(200);

      expect(res2.body).toEqual(res1.body);
      expect(provider.getNonceForAddress).toHaveBeenCalledTimes(1);
    });

    it("rejects with 409 Conflict when retried with same idempotency key but different body", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);

      mockEscrow.populate.mockReturnValue({
        contractAddress: "0x123",
        entrypoint: "release",
        calldata: [],
      });
      const { provider } = await import("../starknet/client.js");
      (provider.getNonceForAddress as any).mockResolvedValue("0x1");
      (provider.getChainId as any).mockResolvedValue("0x534e5f4d41494e"); // SN_MAIN

      await request(makeApp())
        .post("/api/v1/prepare/escrow/0x123/release")
        .set("Idempotency-Key", "idemp-key-2")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "100",
        })
        .expect(200);

      const res2 = await request(makeApp())
        .post("/api/v1/prepare/escrow/0x123/release")
        .set("Idempotency-Key", "idemp-key-2")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "200",
        })
        .expect(409);

      expect(res2.body).toEqual({
        error: "Idempotency key already used with a different request body",
      });
    });

    it("returns 400 Bad Request when agreement balance is insufficient", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);

      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 50n, high: 0n });

      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0x123/release")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "100",
        })
        .expect(400);

      expect(res.body).toEqual({
        error: "Insufficient agreement balance",
      });
    });
  });

  describe("structured logging – balance resolution", () => {
    let consoleLogSpy: any;
    let consoleWarnSpy: any;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("emits escrow_balance_resolved log with source=indexed when DB has events", async () => {
      const mockOffset = vi.fn().mockResolvedValue([{ eventType: "Funded", amount: "1000" }]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      await request(makeApp()).get("/api/v1/escrow/0xabc/get_agreement_balance/5").expect(200);

      const balanceLog = consoleLogSpy.mock.calls.find((call: any[]) => {
        const arg = call[0];
        return typeof arg === "object" && arg?.event === "escrow_balance_resolved";
      });
      expect(balanceLog).toBeDefined();
      expect(balanceLog[0].source).toBe("indexed");
      expect(balanceLog[0].agreement_id).toBe("5");
      expect(balanceLog[0].balance).toBe("1000");
      expect(balanceLog[0].event_count).toBe(1);
    });

    it("emits escrow_balance_fallback log when indexed data is empty", async () => {
      const mockOffset = vi.fn().mockResolvedValue([]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 300n, high: 0n });

      await request(makeApp()).get("/api/v1/escrow/0xabc/get_agreement_balance/5").expect(200);

      const fallbackLog = consoleLogSpy.mock.calls.find((call: any[]) => {
        const arg = call[0];
        return typeof arg === "object" && arg?.event === "escrow_balance_fallback";
      });
      expect(fallbackLog).toBeDefined();
      expect(fallbackLog[0].source).toBe("contract");
      expect(fallbackLog[0].reason).toBe("no_indexed_data");
    });

    it("emits escrow_balance_resolved log with source=contract after fallback", async () => {
      const mockOffset = vi.fn().mockResolvedValue([]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 300n, high: 0n });

      await request(makeApp()).get("/api/v1/escrow/0xabc/get_agreement_balance/5").expect(200);

      const resolvedLog = consoleLogSpy.mock.calls.find((call: any[]) => {
        const arg = call[0];
        return (
          typeof arg === "object" &&
          arg?.event === "escrow_balance_resolved" &&
          arg?.source === "contract"
        );
      });
      expect(resolvedLog).toBeDefined();
      expect(resolvedLog[0].balance).toBe("300");
    });

    it("emits escrow_balance_clamped warn when balance would go negative", async () => {
      const mockOffset = vi.fn().mockResolvedValue([
        { eventType: "Funded", amount: "100" },
        { eventType: "Released", amount: "200" },
      ]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      await request(makeApp()).get("/api/v1/escrow/0xabc/get_agreement_balance/5").expect(200);

      const clampedLog = consoleWarnSpy.mock.calls.find((call: any[]) => {
        const arg = call[0];
        return typeof arg === "object" && arg?.event === "escrow_balance_clamped";
      });
      expect(clampedLog).toBeDefined();
      expect(clampedLog[0].raw_balance).toBe("-100");
    });

    it("emits escrow_balance_fallback with reason=db_error when DB throws", async () => {
      const mockOffset = vi.fn().mockRejectedValue(new Error("connection refused"));
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 500n, high: 0n });

      await request(makeApp()).get("/api/v1/escrow/0xabc/get_agreement_balance/5").expect(200);

      const fallbackLog = consoleWarnSpy.mock.calls.find((call: any[]) => {
        const arg = call[0];
        return (
          typeof arg === "object" &&
          arg?.event === "escrow_balance_fallback" &&
          arg?.reason === "db_error"
        );
      });
      expect(fallbackLog).toBeDefined();
      expect(fallbackLog[0].error).toBe("connection refused");
    });
  });

  describe("structured logging – release preparation", () => {
    let consoleLogSpy: any;
    let consoleWarnSpy: any;

    beforeEach(async () => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);
    });

    it("emits escrow_release_insufficient_balance warn when balance < amount", async () => {
      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 50n, high: 0n });

      await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/release")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "100",
        })
        .expect(400);

      const warnLog = consoleWarnSpy.mock.calls.find((call: any[]) => {
        const arg = call[0];
        return typeof arg === "object" && arg?.event === "escrow_release_insufficient_balance";
      });
      expect(warnLog).toBeDefined();
      expect(warnLog[0].requested).toBe("100");
      expect(warnLog[0].available).toBe("50");
      expect(warnLog[0].source).toBe("contract");
    });

    it("emits escrow_release_prepared log on successful preparation", async () => {
      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 1000n, high: 0n });
      mockEscrow.populate.mockReturnValue({
        contractAddress: "0xabc",
        entrypoint: "release",
        calldata: [],
      });
      const { provider } = await import("../starknet/client.js");
      (provider.getNonceForAddress as any).mockResolvedValue("0x1");
      (provider.getChainId as any).mockResolvedValue("0x534e5f4d41494e");

      await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/release")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "100",
        })
        .expect(200);

      const log = consoleLogSpy.mock.calls.find((call: any[]) => {
        const arg = call[0];
        return typeof arg === "object" && arg?.event === "escrow_release_prepared";
      });
      expect(log).toBeDefined();
      expect(log[0].amount).toBe("100");
      expect(log[0].agreement_id).toBe("1");
      expect(log[0].balance).toBe("1000");
    });

    it("emits escrow_auth_failed warn when session is invalid", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(false);

      await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/release")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "100",
        })
        .expect(401);

      const warnLog = consoleWarnSpy.mock.calls.find((call: any[]) => {
        const arg = call[0];
        return typeof arg === "object" && arg?.event === "escrow_auth_failed";
      });
      expect(warnLog).toBeDefined();
      expect(warnLog[0].route).toBe("release");
    });

    it("emits escrow_idempotency_cache_hit log on replay", async () => {
      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 1000n, high: 0n });
      mockEscrow.populate.mockReturnValue({
        contractAddress: "0xabc",
        entrypoint: "release",
        calldata: [],
      });
      const { provider } = await import("../starknet/client.js");
      (provider.getNonceForAddress as any).mockResolvedValue("0x1");
      (provider.getChainId as any).mockResolvedValue("0x534e5f4d41494e");

      const payload = {
        wallet_address: "0xabc",
        session_token: "token123456",
        agreement_id: 1,
        to: "0xdef",
        amount: "100",
      };

      // First call — caches response
      await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/release")
        .set("Idempotency-Key", "log-key-1")
        .send(payload)
        .expect(200);

      // Second call — should emit cache hit log
      await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/release")
        .set("Idempotency-Key", "log-key-1")
        .send(payload)
        .expect(200);

      const cacheLog = consoleLogSpy.mock.calls.find((call: any[]) => {
        const arg = call[0];
        return typeof arg === "object" && arg?.event === "escrow_idempotency_cache_hit";
      });
      expect(cacheLog).toBeDefined();
    });

    it("emits escrow_idempotency_conflict warn when body differs", async () => {
      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 1000n, high: 0n });
      mockEscrow.populate.mockReturnValue({
        contractAddress: "0xabc",
        entrypoint: "release",
        calldata: [],
      });
      const { provider } = await import("../starknet/client.js");
      (provider.getNonceForAddress as any).mockResolvedValue("0x1");
      (provider.getChainId as any).mockResolvedValue("0x534e5f4d41494e");

      // First call
      await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/release")
        .set("Idempotency-Key", "log-key-conflict")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "100",
        })
        .expect(200);

      // Second call — different body
      await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/release")
        .set("Idempotency-Key", "log-key-conflict")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          to: "0xdef",
          amount: "200",
        })
        .expect(409);

      const conflictLog = consoleWarnSpy.mock.calls.find((call: any[]) => {
        const arg = call[0];
        return typeof arg === "object" && arg?.event === "escrow_idempotency_conflict";
      });
      expect(conflictLog).toBeDefined();
    });
  });

  describe("GET /escrow/defaults", () => {
    it("returns the configured payroll escrow address", async () => {
      const res = await request(makeApp()).get("/api/v1/escrow/defaults").expect(200);

      expect(res.body).toHaveProperty("address");
      expect(typeof res.body.address).toBe("string");
    });
  });

  describe("GET /escrow/:address/get_token", () => {
    it("returns the token address from the escrow contract", async () => {
      mockEscrow.get_token.mockResolvedValue("0xTokenAddress123");

      const res = await request(makeApp()).get("/api/v1/escrow/0xabc/get_token").expect(200);

      expect(res.body).toEqual({ token: "0xTokenAddress123" });
    });

    it("returns 400 for an invalid address parameter", async () => {
      const res = await request(makeApp()).get("/api/v1/escrow/xx/get_token").expect(400);

      expect(res.body).toMatchObject({ error: "Validation failed" });
    });
  });

  describe("GET /escrow/:address/is_initialized", () => {
    it("returns initialized: true when token is a non-zero address", async () => {
      mockEscrow.get_token.mockResolvedValue("0x1234567890abcdef");

      const res = await request(makeApp()).get("/api/v1/escrow/0xabc/is_initialized").expect(200);

      expect(res.body).toMatchObject({
        initialized: true,
        token: "0x1234567890abcdef",
      });
    });

    it("returns initialized: false when token is 0x0", async () => {
      mockEscrow.get_token.mockResolvedValue("0x0");

      const res = await request(makeApp()).get("/api/v1/escrow/0xabc/is_initialized").expect(200);

      expect(res.body).toMatchObject({
        initialized: false,
        token: null,
      });
    });

    it("returns initialized: false with error when contract call fails", async () => {
      mockEscrow.get_token.mockRejectedValue(new Error("Contract not deployed"));

      const res = await request(makeApp()).get("/api/v1/escrow/0xabc/is_initialized").expect(200);

      expect(res.body).toMatchObject({
        initialized: false,
        token: null,
      });
      expect(res.body.error).toBeDefined();
    });
  });

  describe("GET /escrow/:address/get_agreement_employer/:agreement_id", () => {
    it("returns the employer address for the agreement", async () => {
      mockEscrow.get_agreement_employer.mockResolvedValue("0xEmployerAddress");

      const res = await request(makeApp())
        .get("/api/v1/escrow/0xabc/get_agreement_employer/1")
        .expect(200);

      expect(res.body).toEqual({
        agreement_id: "1",
        employer: "0xEmployerAddress",
      });
    });
  });

  describe("POST /prepare/escrow/:address/initialize", () => {
    it("returns prepared call successfully", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);

      mockEscrow.populate.mockReturnValue({
        contractAddress: "0xabc",
        entrypoint: "initialize",
        calldata: [],
      });
      const { provider } = await import("../starknet/client.js");
      (provider.getNonceForAddress as any).mockResolvedValue("0x1");
      (provider.getChainId as any).mockResolvedValue("0x534e5f4d41494e");

      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/initialize")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          token: "0xaaa",
          manager: "0xbbb",
        })
        .expect(200);

      expect(res.body).toMatchObject({
        call: { contractAddress: "0xabc", entrypoint: "initialize", calldata: [] },
        nonce: "0x1",
        chain_id: "0x534e5f4d41494e",
      });
      expect(res.body.wallet_address).toMatch(/^0x0+abc$/);
    });

    it("returns 401 when session is invalid", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(false);

      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/initialize")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          token: "0xaaa",
          manager: "0xbbb",
        })
        .expect(401);

      expect(res.body).toEqual({ error: "Invalid session" });
    });
  });

  describe("POST /prepare/escrow/:address/fund_agreement", () => {
    it("returns prepared call successfully", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);

      mockEscrow.populate.mockReturnValue({
        contractAddress: "0xabc",
        entrypoint: "fund_agreement",
        calldata: [],
      });
      const { provider } = await import("../starknet/client.js");
      (provider.getNonceForAddress as any).mockResolvedValue("0x1");
      (provider.getChainId as any).mockResolvedValue("0x534e5f4d41494e");

      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/fund_agreement")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          employer: "0xccc",
          amount: "5000",
        })
        .expect(200);

      expect(res.body).toMatchObject({
        call: { contractAddress: "0xabc", entrypoint: "fund_agreement", calldata: [] },
        nonce: "0x1",
        chain_id: "0x534e5f4d41494e",
      });
      expect(res.body.wallet_address).toMatch(/^0x0+abc$/);
    });

    it("returns 401 when session is invalid", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(false);

      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/fund_agreement")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
          employer: "0xccc",
          amount: "5000",
        })
        .expect(401);

      expect(res.body).toEqual({ error: "Invalid session" });
    });
  });

  describe("POST /prepare/escrow/:address/refund_remaining", () => {
    it("returns prepared call successfully when caller is employer", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);

      mockEscrow.get_agreement_employer.mockResolvedValue("0xabc");
      mockEscrow.populate.mockReturnValue({
        contractAddress: "0xabc",
        entrypoint: "refund_remaining",
        calldata: [],
      });
      const { provider } = await import("../starknet/client.js");
      (provider.getNonceForAddress as any).mockResolvedValue("0x1");
      (provider.getChainId as any).mockResolvedValue("0x534e5f4d41494e");

      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/refund_remaining")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
        })
        .expect(200);

      expect(res.body).toMatchObject({
        call: { contractAddress: "0xabc", entrypoint: "refund_remaining", calldata: [] },
        nonce: "0x1",
        chain_id: "0x534e5f4d41494e",
      });
    });

    it("returns 401 when session is invalid", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(false);

      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/refund_remaining")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
        })
        .expect(401);

      expect(res.body).toEqual({ error: "Invalid session" });
    });

    it("returns 403 when caller is not the agreement employer", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);

      // Caller address (0xabc) doesn't match the employer on-chain (0xdef)
      mockEscrow.get_agreement_employer.mockResolvedValue("0xdef");

      const res = await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/refund_remaining")
        .send({
          wallet_address: "0xabc",
          session_token: "token123456",
          agreement_id: 1,
        })
        .expect(403);

      expect(res.body).toEqual({ error: "Unauthorized" });
    });
  });

  describe("boundary — balance resolution", () => {
    it("handles events without an id field gracefully (no deduplication)", async () => {
      const mockOffset = vi.fn().mockResolvedValue([
        { eventType: "Funded", amount: "1000" },
        { eventType: "Funded", amount: "500" },
      ]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({
        agreement_id: "1",
        balance: "1500",
        source: "indexed",
      });
    });

    it("handles contract balance returned as a plain string", async () => {
      const mockOffset = vi.fn().mockResolvedValue([]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      mockEscrow.get_agreement_balance.mockResolvedValue("750");

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({
        agreement_id: "1",
        balance: "750",
        source: "contract",
      });
    });

    it("handles contract balance returned as a plain number", async () => {
      const mockOffset = vi.fn().mockResolvedValue([]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      mockEscrow.get_agreement_balance.mockResolvedValue(999);

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({
        agreement_id: "1",
        balance: "999",
        source: "contract",
      });
    });

    it("handles contract balance returned as a plain bigint", async () => {
      const mockOffset = vi.fn().mockResolvedValue([]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      mockEscrow.get_agreement_balance.mockResolvedValue(1234n);

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({
        agreement_id: "1",
        balance: "1234",
        source: "contract",
      });
    });

    it("balances exactly to zero (equal funded and released)", async () => {
      const mockOffset = vi.fn().mockResolvedValue([
        { eventType: "Funded", amount: "1000" },
        { eventType: "Released", amount: "1000" },
      ]);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
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
  });

  describe("batched pagination — balance resolution", () => {
    it("accumulates balance correctly across multiple batches", async () => {
      // Simulate 250 events: 3 pages (100 + 100 + 50)
      // Page 1: 100 Funded events of 10 each
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: `evt-p1-${i}`,
        eventType: "Funded" as const,
        amount: "10",
      }));
      // Page 2: 100 Released events of 5 each
      const page2 = Array.from({ length: 100 }, (_, i) => ({
        id: `evt-p2-${i}`,
        eventType: "Released" as const,
        amount: "5",
      }));
      // Page 3: 50 Refunded events of 2 each
      const page3 = Array.from({ length: 50 }, (_, i) => ({
        id: `evt-p3-${i}`,
        eventType: "Refunded" as const,
        amount: "2",
      }));

      // mockOffset is called 3 times with offsets 0, 100, 200
      const mockOffset = vi
        .fn()
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2)
        .mockResolvedValueOnce(page3);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      // Balance = (100*10) - (100*5) - (50*2) = 1000 - 500 - 100 = 400
      expect(res.body).toEqual({
        agreement_id: "1",
        balance: "400",
        source: "indexed",
      });
      expect(mockOffset).toHaveBeenCalledTimes(3);
    });

    it("handles exactly one full batch (boundary)", async () => {
      const page = Array.from({ length: 100 }, (_, i) => ({
        id: `evt-${i}`,
        eventType: "Funded" as const,
        amount: "1",
      }));

      const mockOffset = vi.fn().mockResolvedValueOnce(page);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({ agreement_id: "1", balance: "100", source: "indexed" });
      // One full batch: loop fetches it, sees length === BATCH_SIZE, fetches second page (empty)
      expect(mockOffset).toHaveBeenCalledTimes(2);
    });

    it("deduplicates events across batch boundaries", async () => {
      // Page 1 ends with evt-99 and evt-100 (duplicate); page 2 starts with same duplicate
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: `evt-${i}`,
        eventType: "Funded" as const,
        amount: "10",
      }));
      // Page 2: first event is a duplicate of the last from page 1
      const page2 = [
        { id: "evt-99", eventType: "Funded" as const, amount: "10" },
        ...Array.from({ length: 49 }, (_, i) => ({
          id: `evt-p2-${i}`,
          eventType: "Released" as const,
          amount: "5",
        })),
      ];

      const mockOffset = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      // Balance = 100*10 - 49*5 = 1000 - 245 = 755
      expect(res.body).toEqual({ agreement_id: "1", balance: "755", source: "indexed" });
    });

    it("stops pagination when a page returns fewer than BATCH_SIZE", async () => {
      // Only 30 events — one page, then loop stops
      const page = Array.from({ length: 30 }, (_, i) => ({
        id: `evt-${i}`,
        eventType: "Funded" as const,
        amount: "1",
      }));

      const mockOffset = vi.fn().mockResolvedValueOnce(page);
      const mockLimit = vi.fn(() => ({ offset: mockOffset }));
      const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      (db.select as any).mockReturnValue({ from: mockFrom });

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x123/get_agreement_balance/1")
        .expect(200);

      expect(res.body).toEqual({ agreement_id: "1", balance: "30", source: "indexed" });
      // Only one page fetched — offset is called once
      expect(mockOffset).toHaveBeenCalledTimes(1);
    });
  });

  describe("clearEscrowIdempotencyStore", () => {
    it("clears all entries so subsequent requests re-execute the handler", async () => {
      const { requireSession } = await import("../auth/session.js");
      (requireSession as any).mockResolvedValue(true);

      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 1000n, high: 0n });
      mockEscrow.populate.mockReturnValue({
        contractAddress: "0xabc",
        entrypoint: "release",
        calldata: [],
      });
      const { provider } = await import("../starknet/client.js");
      (provider.getNonceForAddress as any).mockResolvedValue("0x1");
      (provider.getChainId as any).mockResolvedValue("0x534e5f4d41494e");

      const payload = {
        wallet_address: "0xabc",
        session_token: "token123456",
        agreement_id: 1,
        to: "0xdef",
        amount: "100",
      };

      await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/release")
        .set("Idempotency-Key", "clear-test-key")
        .send(payload)
        .expect(200);

      // First call: nonce fetched once
      expect(provider.getNonceForAddress).toHaveBeenCalledTimes(1);

      clearEscrowIdempotencyStore();

      await request(makeApp())
        .post("/api/v1/prepare/escrow/0xabc/release")
        .set("Idempotency-Key", "clear-test-key")
        .send(payload)
        .expect(200);

      // After clearing, handler re-executes → nonce fetched again
      expect(provider.getNonceForAddress).toHaveBeenCalledTimes(2);
    });
  });
});

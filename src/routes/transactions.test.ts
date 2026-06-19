import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryResults, envMock, mockGetToken } = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  envMock: {
    NODE_ENV: "test",
    STARKNET_RPC_URL: "https://starknet-sepolia.public.invalid/rpc",
    TOKEN_STRK: undefined as string | undefined,
    TOKEN_USDC: undefined as string | undefined,
    TOKEN_USDT: undefined as string | undefined,
  },
  mockGetToken: vi.fn(),
}));

vi.mock("../config.js", () => ({ env: envMock }));

vi.mock("../db/index.js", () => {
  const makeQuery = () => {
    let query: any;
    query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      innerJoin: vi.fn(() => query),
      leftJoin: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(() => query),
      offset: vi.fn(() => Promise.resolve(queryResults.shift() ?? [])),
    };
    return query;
  };

  return {
    db: {
      select: vi.fn(() => makeQuery()),
    },
    schema: {
      agreementEvents: {
        id: "agreementEvents.id",
        agreementId: "agreementEvents.agreementId",
        contractAddress: "agreementEvents.contractAddress",
        eventType: "agreementEvents.eventType",
        blockNumber: "agreementEvents.blockNumber",
        transactionHash: "agreementEvents.transactionHash",
        createdAt: "agreementEvents.createdAt",
      },
      agreements: {
        id: "agreements.id",
        contractAddress: "agreements.contractAddress",
        employer: "agreements.employer",
        contributor: "agreements.contributor",
        token: "agreements.token",
      },
      payments: {
        from: "payments.from",
        to: "payments.to",
        eventType: "payments.eventType",
        blockNumber: "payments.blockNumber",
      },
      escrowEvents: {
        employer: "escrowEvents.employer",
        to: "escrowEvents.to",
        eventType: "escrowEvents.eventType",
        blockNumber: "escrowEvents.blockNumber",
      },
      employees: {
        id: "employees.id",
        agreementId: "employees.agreementId",
        contractAddress: "employees.contractAddress",
        blockNumber: "employees.blockNumber",
        transactionHash: "employees.transactionHash",
        createdAt: "employees.createdAt",
        employeeAddress: "employees.employeeAddress",
        salaryPerPeriod: "employees.salaryPerPeriod",
      },
      milestones: {
        id: "milestones.id",
        agreementId: "milestones.agreementId",
        contractAddress: "milestones.contractAddress",
        blockNumber: "milestones.blockNumber",
        transactionHash: "milestones.transactionHash",
        createdAt: "milestones.createdAt",
        amount: "milestones.amount",
      },
    },
  };
});

vi.mock("../starknet/client.js", () => ({
  agreementContract: vi.fn(() => ({
    get_token: mockGetToken,
  })),
}));

describe("GET /transactions/:user_address", () => {
  beforeEach(() => {
    vi.resetModules();
    queryResults.length = 0;
    mockGetToken.mockReset();
    delete process.env.TRANSACTIONS_DEBUG;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not write verbose transaction diagnostics to console.log by default", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    queryResults.push([], [], [], [], []);

    const { transactionsRouter } = await import("./transactions.js");
    const app = express();
    app.use(express.json());
    app.use("/api/v1", transactionsRouter);
    app.use((err: any, req: any, res: any, next: any) => {
      res.status(err.status || 500).json({ error: err.message });
    });

    const res = await request(app)
      .get("/api/v1/transactions/0x123")
      .expect(200);

    expect(res.body).toEqual({ transactions: [], total: 0 });
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});

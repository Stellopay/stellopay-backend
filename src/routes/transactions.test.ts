import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { transactionsRouter } from "./transactions.js";

// Mock starknet client
vi.mock("../starknet/client.js", () => ({
  agreementContract: vi.fn(() => ({
    get_token: vi.fn().mockResolvedValue(12345n),
  })),
}));

// Mock config
vi.mock("../config.js", () => ({
  env: {
    TOKEN_STRK: "0xSTRK",
    TOKEN_USDC: "0xUSDC",
    TOKEN_USDT: "0xUSDT",
  },
}));

// Let's create a robust query chain mock
const createQueryChain = (results: any[]) => {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.offset = vi.fn(() => chain);
  // Make the chain thenable so await works
  chain.then = (resolve: any) => resolve(results);
  return chain;
};

// We need to return counts for some selects and data for others
// The handler calls db.select() 5 times for counts, then 5 times for data
// We can track the calls to db.select
let selectCallCount = 0;

vi.mock("../db/index.js", () => {
  return {
    db: {
      select: vi.fn((arg) => {
        // Simple heuristic: if arg has 'count', it's a count query
        if (arg && arg.count) {
          // Return a query chain that resolves to [{ count: 10 }]
          return createQueryChain([{ count: 2 }]);
        }
        // Otherwise it's a data query
        return createQueryChain([
          {
            id: "1",
            agreementId: "1",
            contractAddress: "0x123",
            eventType: "PaymentSent",
            blockNumber: 100,
            transactionHash: "0xabc123" + Math.random(),
            createdAt: new Date(),
            from: "0xuser",
            to: "0xother",
            amount: "1000000",
            token: "0xUSDC",
          },
        ]);
      }),
    },
    schema: {
      payments: {
        from: "from",
        to: "to",
        eventType: "eventType",
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        id: "id",
      },
      escrowEvents: {
        employer: "employer",
        to: "to",
        eventType: "eventType",
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        id: "id",
      },
      agreements: { employer: "employer", contributor: "contributor", token: "token", id: "id" },
      agreementEvents: {
        eventType: "eventType",
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        agreementId: "agreementId",
        id: "id",
      },
      employees: {
        employeeAddress: "employeeAddress",
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        agreementId: "agreementId",
        id: "id",
      },
      milestones: {
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        agreementId: "agreementId",
        id: "id",
      },
    },
  };
});

// App setup
const app = express();
app.use(express.json());
app.use(transactionsRouter);
app.use((err: any, req: any, res: any, next: any) => {
  res.status(500).json({ error: err.message });
});

describe("Transactions Router Pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return correct total and clamp limit", async () => {
    // 5 tables * 2 count each = 10 total items expected based on our mock
    const res = await request(app).get("/transactions/0xuser?limit=200"); // Request limit > 100

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    // Limit should be clamped to 100
    expect(res.body.limit).toBe(100);
    expect(res.body.total).toBe(10); // 5 count queries * 2 = 10

    // We mocked 1 item per table, so 5 items total
    expect(res.body.transactions.length).toBe(5);

    // total (10) > offset (0) + limit (100) -> false
    expect(res.body.hasMore).toBe(false);
  });

  it("should calculate hasMore correctly when paginating", async () => {
    const res = await request(app).get("/transactions/0xuser?limit=5");

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    // offset 0 + limit 5 < total 10 -> true
    expect(res.body.hasMore).toBe(true);
  });

  it("should work for filtered endpoint with similar logic", async () => {
    const res = await request(app).get("/transactions/0xuser/filtered?limit=5");

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(10);
    expect(res.body.hasMore).toBe(true);
  });

  it("should handle empty results smoothly", async () => {
    // Override select mock for this test to return 0
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 0 }]);
      return createQueryChain([]);
    });

    const res = await request(app).get("/transactions/0xuser");

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.transactions.length).toBe(0);
    expect(res.body.hasMore).toBe(false);
  });
});

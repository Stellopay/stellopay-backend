import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { transactionsRouter } from "./transactions.js";

// Mock starknet client
vi.mock("../starknet/client.js", () => ({
  agreementContract: vi.fn(() => ({
    get_token: vi.fn().mockResolvedValue(12345n),
  })),
}));

// Mock config with valid hex token addresses so the router can normalize them.
vi.mock("../config.js", () => ({
  env: {
    LOG_LEVEL: "info",
    TOKEN_STRK:
      "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    TOKEN_USDC:
      "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
    TOKEN_USDT:
      "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb",
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
            contractAddress:
              "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
            eventType: "PaymentSent",
            blockNumber: 100,
            transactionHash:
              "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            createdAt: new Date(),
            from: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
            to: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
            amount: "1000000",
            token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
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
      agreements: {
        employer: "employer",
        contributor: "contributor",
        token: "token",
        id: "id",
      },
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
    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4?limit=200",
    );

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
    expect(res.body.total).toBe(10);
    expect(res.body.transactions.length).toBe(5);
    expect(res.body.hasMore).toBe(false);
  });

  it("should calculate hasMore correctly when paginating", async () => {
    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4?limit=5",
    );

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.hasMore).toBe(true);
  });

  it("should work for filtered endpoint with similar logic", async () => {
    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4/filtered?limit=5",
    );

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(10);
    expect(res.body.hasMore).toBe(true);
  });

  it("should handle empty results smoothly", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 0 }]);
      return createQueryChain([]);
    });

    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
    );

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.transactions.length).toBe(0);
    expect(res.body.hasMore).toBe(false);
  });
});

describe("Transactions Router Logging", () => {
  const userAddress = "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4";
  let logSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 1 }]);
      return createQueryChain([
        {
          id: "1",
          agreementId: "1",
          contractAddress: "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
          eventType: "PaymentReceived",
          blockNumber: 100,
          transactionHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          createdAt: new Date(),
          from: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
          to: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
          amount: "1500000",
          token: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
        },
      ]);
    });

    const { env } = await import("../config.js");
    (env as { LOG_LEVEL?: string }).LOG_LEVEL = "info";

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("stays silent and still returns transactions at the default log level", async () => {
    const res = await request(app).get(`/transactions/${userAddress}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transactions)).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("emits diagnostics through console.debug only when LOG_LEVEL is debug", async () => {
    const { env } = await import("../config.js");
    (env as { LOG_LEVEL?: string }).LOG_LEVEL = "debug";

    const res = await request(app).get(`/transactions/${userAddress}`);

    expect(res.status).toBe(200);
    expect(debugSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("Transaction Export Contracts - Edge Cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should enforce exactly the TransactionRecord shape when returning mock results", async () => {
    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4?limit=1"
    );
    expect(res.status).toBe(200);
    const exportData = res.body;
    expect(exportData).toHaveProperty("total");
    expect(exportData).toHaveProperty("hasMore");
    expect(exportData).toHaveProperty("limit");
    expect(exportData).toHaveProperty("offset");
    expect(Array.isArray(exportData.transactions)).toBe(true);

    if (exportData.transactions.length > 0) {
      const record = exportData.transactions[0];
      expect(record).toHaveProperty("id");
      expect(typeof record.id).toBe("string");
      expect(record).toHaveProperty("type");
      expect(typeof record.type).toBe("string");
      expect(record).toHaveProperty("address");
      expect(typeof record.address).toBe("string");
      expect(record).toHaveProperty("date");
      expect(typeof record.date).toBe("string");
      expect(record).toHaveProperty("time");
      expect(typeof record.time).toBe("string");
      expect(record).toHaveProperty("token");
      expect(typeof record.token).toBe("string");
      expect(record).toHaveProperty("amount");
      expect(typeof record.amount).toBe("string");
      expect(record).toHaveProperty("status", "Completed");
      expect(record).toHaveProperty("tokenIcon");
      expect(typeof record.tokenIcon).toBe("string");
      expect(record).toHaveProperty("txHash");
      expect(typeof record.txHash).toBe("string");
      expect(record).toHaveProperty("createdAt");
    }
  });

  it("should return 400 for malformed 'from' timestamp", async () => {
    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4?from=not-a-date",
    );
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("from");
  });

  it("should return 400 for malformed 'to' timestamp", async () => {
    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4?to=not-a-date",
    );
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("to");
  });

  it("should return 400 when 'from' is after 'to'", async () => {
    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4?from=2025-06-01T00:00:00Z&to=2024-01-01T00:00:00Z",
    );
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("from");
    expect(res.body.error).toContain("to");
  });

  it("should accept a valid date-range and still return transactions", async () => {
    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4?from=2024-01-01T00:00:00Z&to=2025-06-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transactions)).toBe(true);
  });

  it("should accept only a 'from' param without 'to'", async () => {
    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4?from=2024-01-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transactions)).toBe(true);
  });

  it("should accept only a 'to' param without 'from'", async () => {
    const res = await request(app).get(
      "/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4?to=2025-06-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transactions)).toBe(true);
  });

  it("should handle boundary/failure path gracefully when db throws", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error("Database connection lost");
    });
    const res = await request(app).get("/transactions/0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Database connection lost");
  });
});

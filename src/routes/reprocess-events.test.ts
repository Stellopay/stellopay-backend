import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { reprocessEventsRouter } from "./reprocess-events.js";
import { eventsRouter } from "./events.js";
import { db } from "../db/index.js";

// Mock global fetch to ensure no network calls are made
const originalFetch = global.fetch;
const fetchMock = vi.fn();

// Mock database
vi.mock("../db/index.js", () => {
  const mockDb = {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue({}),
    onConflictDoUpdate: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockReturnThis(),
  };
  return {
    db: mockDb,
    schema: {
      agreementEvents: { id: "agreementEvents", eventType: "AgreementStatusChange" },
      agreements: { id: "agreements" },
      payments: { id: "payments" },
      escrowEvents: { id: "escrowEvents" },
    },
  };
});

// Mock Starknet provider and contracts
const mockGetTransactionReceipt = vi.fn();
vi.mock("../starknet/client.js", () => {
  return {
    provider: {
      getTransactionReceipt: (...args: any[]) => mockGetTransactionReceipt(...args),
    },
    agreementContract: vi.fn().mockReturnValue({
      get_token: vi.fn().mockResolvedValue("0x54321"),
    }),
  };
});

// Mock ABI loading to bypass file dependencies
vi.mock("../starknet/abi.js", () => {
  return {
    loadAbiFromContractClassJsonPath: vi.fn().mockReturnValue([]),
  };
});

// Mock Contract from Starknet to return mock parsed events
vi.mock("starknet", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    Contract: class MockContract {
      constructor(public abi: any, public address: string, public provider: any) {}
      parseEvent = vi.fn().mockImplementation((event: any) => {
        if (event?.shouldFail) {
          throw new Error("Failed to parse event");
        }
        return {
          name: "AgreementCreated",
          data: {
            agreement_id: "123",
            employer: "0x123",
            contributor: "0x456",
            token: "0x789",
            mode: 0,
            payment_type: 1,
          },
        };
      });
    },
  };
});


vi.mock("../auth/middleware.js", () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireAdmin: vi.fn((req, res, next) => next()),
}));
describe("Reprocess Events Routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as any;
    
    // Set up test express app
    app = express();
    app.use(express.json());
    
    // Add a basic error handler for express testing of catch blocks
    app.use("/api/v1", reprocessEventsRouter);
    app.use("/api/v1", eventsRouter);
    app.use((err: any, req: any, res: any, next: any) => {
      res.status(err.status || 500).json({ error: err.message });
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("POST /reprocess-events/tx/:tx_hash", () => {
    it("should process events directly and successfully with PORT unset", async () => {
      // Temporarily unset PORT
      const originalPort = process.env.PORT;
      delete process.env.PORT;

      // Mock Starknet receipt containing an event
      const mockReceipt = {
        transaction_hash: "0x1234567890abcdef",
        blockNumber: 100,
        events: [
          {
            from_address: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd", // workAgreementAddress default
            data: ["123", "0x123", "0x456", "0x789", "0", "1"],
          },
        ],
      };
      mockGetTransactionReceipt.mockResolvedValue(mockReceipt);

      const txHash = "0x1234567890abcdef";
      const res = await request(app)
        .post(`/api/v1/reprocess-events/tx/${txHash}`)
        .expect(200);

      // Verify response structure (result is the shared processTxReceipt output)
      expect(res.body).toEqual({
        message: "Events reprocessed",
        result: {
          txHash: "0x0000000000000000000000000000000000000000000000001234567890abcdef",
          status: "processed",
          eventsProcessed: 1,
          eventLabels: ["AgreementCreated-123"],
        },
      });

      // Verify that no HTTP loopback call was made
      expect(fetchMock).not.toHaveBeenCalled();

      // Restore PORT
      process.env.PORT = originalPort;
    });

    it("should reject invalid tx_hash format", async () => {
      const invalidTxHash = "not-a-tx-hash-$$";
      const res = await request(app)
        .post(`/api/v1/reprocess-events/tx/${invalidTxHash}`)
        .expect(400);

      expect(res.body).toEqual({
        error: "Invalid Starknet transaction hash format",
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
    });

    it("should handle transaction not found (404)", async () => {
      mockGetTransactionReceipt.mockResolvedValue(null);

      const txHash = "0x99999";
      const res = await request(app)
        .post(`/api/v1/reprocess-events/tx/${txHash}`)
        .expect(404);

      expect(res.body).toEqual({
        error: "Transaction not found",
      });
    });

    it("should yield the same persisted rows as direct process_tx call", async () => {
      // Mock Starknet receipt
      const mockReceipt = {
        transaction_hash: "0x1234567890abcdef",
        blockNumber: 100,
        events: [
          {
            from_address: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
            data: ["123", "0x123", "0x456", "0x789", "0", "1"],
          },
        ],
      };
      mockGetTransactionReceipt.mockResolvedValue(mockReceipt);

      const txHash = "0x1234567890abcdef";

      // 1. Call reprocess-events endpoint
      const reprocessRes = await request(app)
        .post(`/api/v1/reprocess-events/tx/${txHash}`)
        .expect(200);

      // 2. Call direct process_tx endpoint
      const processRes = await request(app)
        .post(`/api/v1/events/process_tx/${txHash}`)
        .expect(200);

      // Both paths run the same shared processor, so they decode the same
      // events and tx hash even though the two routes shape their JSON differently.
      expect(reprocessRes.body.result.eventLabels).toEqual(processRes.body.eventsProcessed);
      expect(reprocessRes.body.result.txHash).toEqual(processRes.body.transactionHash);
    });

    it("should handle outer catch-all error in reprocess-events/tx", async () => {
      mockGetTransactionReceipt.mockRejectedValue(new Error("RPC Connection Fail"));

      const res = await request(app)
        .post("/api/v1/reprocess-events/tx/0x1234")
        .expect(500);

      expect(res.body.error).toBe("RPC Connection Fail");
    });
  });

  describe("POST /reprocess-events/status-changes", () => {
    it("should handle case when there are no events in database", async () => {
      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes")
        .expect(200);

      expect(res.body.message).toContain("Reprocessed 0 events");
      expect(res.body.updated).toBe(0);

      selectMock.mockRestore();
    });

    it("should handle case where transaction has no receipt", async () => {
      const mockEvents = [
        {
          id: "event_1",
          transactionHash: "0x123",
          eventIndex: 0,
          contractAddress: "0xwork",
          eventType: "AgreementStatusChange",
        },
      ];

      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(mockEvents),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockResolvedValue(null);

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes")
        .expect(200);

      expect(res.body.results[0]).toEqual({
        eventId: "event_1",
        status: "no_receipt",
      });

      selectMock.mockRestore();
    });

    it("should handle case where event is not found in receipt", async () => {
      const mockEvents = [
        {
          id: "event_1",
          transactionHash: "0x123",
          eventIndex: 99, // out of bounds event index
          contractAddress: "0xwork",
          eventType: "AgreementStatusChange",
        },
      ];

      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(mockEvents),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockResolvedValue({
        events: [{ from_address: "0xwork" }],
      });

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes")
        .expect(200);

      expect(res.body.results[0]).toEqual({
        eventId: "event_1",
        status: "event_not_found",
      });

      selectMock.mockRestore();
    });

    it("should decode using fallback selector map when parseEvent throws", async () => {
      const mockEvents = [
        {
          id: "event_1",
          transactionHash: "0x123",
          eventIndex: 0,
          contractAddress: "0xwork",
          eventType: "AgreementStatusChange",
        },
      ];

      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(mockEvents),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockResolvedValue({
        events: [
          {
            from_address: "0xwork",
            keys: ["0x39935559db9e6f265020b5e7f9e32f707ec95bc7744e4313651be569076f335"], // AgreementActivated selector
            shouldFail: true, // triggers exception in MockContract.parseEvent
          },
        ],
      });

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes")
        .expect(200);

      expect(res.body.updated).toBe(1);
      expect(res.body.results[0]).toEqual({
        eventId: "event_1",
        status: "updated",
        oldType: "AgreementStatusChange",
        newType: "AgreementActivated",
      });

      selectMock.mockRestore();
    });

    it("should keep AgreementStatusChange if parseEvent and selector matching both fail", async () => {
      const mockEvents = [
        {
          id: "event_1",
          transactionHash: "0x123",
          eventIndex: 0,
          contractAddress: "0xwork",
          eventType: "AgreementStatusChange",
        },
      ];

      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(mockEvents),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockResolvedValue({
        events: [
          {
            from_address: "0xwork",
            keys: ["0xunknownkey"], // not in selectorMap
            shouldFail: true,
          },
        ],
      });

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes")
        .expect(200);

      expect(res.body.updated).toBe(0);
      expect(res.body.results[0]).toEqual({
        eventId: "event_1",
        status: "no_change",
        eventType: "AgreementStatusChange",
      });

      selectMock.mockRestore();
    });

    it("should handle inner parsing exception and log it (parseError)", async () => {
      const mockEvents = [
        {
          id: "event_1",
          transactionHash: "0x123",
          eventIndex: 0,
          contractAddress: "0xwork",
          eventType: "AgreementStatusChange",
        },
      ];

      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(mockEvents),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockResolvedValue({
        events: [
          {
            from_address: "0xwork",
            get keys() {
              throw new Error("Simulate parseError when accessing keys");
            },
            shouldFail: true,
          },
        ],
      });

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes")
        .expect(200);

      expect(res.body.updated).toBe(0);
      expect(res.body.results[0]).toEqual({
        eventId: "event_1",
        status: "no_change",
        eventType: "AgreementStatusChange",
      });

      selectMock.mockRestore();
    });

    it("should handle error in loop (getTransactionReceipt throws)", async () => {
      const mockEvents = [
        {
          id: "event_1",
          transactionHash: "0x123",
          eventIndex: 0,
          contractAddress: "0xwork",
          eventType: "AgreementStatusChange",
        },
      ];

      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(mockEvents),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockRejectedValue(new Error("RPC Error"));

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes")
        .expect(200);

      expect(res.body.results[0]).toEqual({
        eventId: "event_1",
        status: "error",
        error: "Error: RPC Error",
      });

      selectMock.mockRestore();
    });

    it("should handle outer catch-all error in status-changes", async () => {
      const selectMock = vi.spyOn(db, "select").mockImplementation(() => {
        throw new Error("DB Connection Failed");
      });

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes")
        .expect(500);

      expect(res.body.error).toBe("DB Connection Failed");

      selectMock.mockRestore();
    });
  });
});

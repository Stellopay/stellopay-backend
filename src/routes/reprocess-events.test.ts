import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import {
  reprocessEventsRouter,
  __resetRetryCounts,
  __resetReprocessLocks,
  acquireReprocessLock,
  releaseReprocessLock,
  getReprocessingLockStatus,
  RETRY_BUDGET,
  QUARANTINE_PATH,
} from "./reprocess-events.js";
import fs from "fs";
import path from "path";
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
      constructor(
        public abi: any,
        public address: string,
        public provider: any,
      ) {}
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
    mockGetTransactionReceipt.mockReset();
    mockParseEvent.mockReset();
    statusChangeQuarantine.clear();
    statusChangeRetryCounts.clear();
    global.fetch = fetchMock as any;

    // Reset retry counts and lock states for isolation
    __resetRetryCounts();
    __resetReprocessLocks();

    // Ensure quarantine directory is clean
    if (fs.existsSync(QUARANTINE_PATH)) {
      fs.rmSync(QUARANTINE_PATH, { recursive: true, force: true });
    }

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
      mockParseEvent.mockImplementation((event: any) => {
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

      const txHash = "0x1234567890abcdef";
      const res = await request(app).post(`/api/v1/reprocess-events/tx/${txHash}`).expect(200);

      // Verify response structure (result is the shared processTxReceipt output)
      expect(res.body).toEqual({
        message: "Events reprocessed",
        result: {
          txHash: "0x0000000000000000000000000000000000000000000000001234567890abcdef",
          status: "processed",
          eventsProcessed: 1,
          eventLabels: ["AgreementCreated-123"],
          tokenVerified: true,
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
      const res = await request(app).post(`/api/v1/reprocess-events/tx/${txHash}`).expect(404);

      expect(res.body).toEqual({
        success: false,
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
      mockParseEvent.mockImplementation(() => ({
        name: "AgreementCreated",
        data: { agreement_id: "123" }
      }));

      const txHash = "0x1234567890abcdef";

      // 1. Call reprocess-events endpoint
      const reprocessRes = await request(app)
        .post(`/api/v1/reprocess-events/tx/${txHash}`)
        .expect(200);

      // 2. Call direct process_tx endpoint
      const processRes = await request(app).post(`/api/v1/events/process_tx/${txHash}`).expect(200);

      // Both paths run the same shared processor, so they decode the same
      // events and tx hash even though the two routes shape their JSON differently.
      expect(reprocessRes.body.result.eventLabels).toEqual(processRes.body.eventsProcessed);
      expect(reprocessRes.body.result.txHash).toEqual(processRes.body.transactionHash);
    });

    it("should be idempotent on double reprocess (tx/:tx_hash)", async () => {
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
      mockParseEvent.mockImplementation(() => ({ name: "test", data: {} }));

      const txHash = "0x1234567890abcdef";
      const endpoint = `/api/v1/reprocess-events/tx/${txHash}`;

      // First call
      const res1 = await request(app).post(endpoint).expect(200);
      expect(res1.body.message).toBe("Events reprocessed");

      // Second call — processTxReceipt uses onConflictDoNothing, so result is identical
      const res2 = await request(app).post(endpoint).expect(200);
      expect(res2.body).toEqual(res1.body);

      // Verify the shared processor was invoked both times (idempotent at DB level)
      expect(mockGetTransactionReceipt).toHaveBeenCalledTimes(2);
    });

    it("should handle outer catch-all error in reprocess-events/tx", async () => {
      mockGetTransactionReceipt.mockRejectedValue(new Error("RPC Connection Fail"));

      const res = await request(app).post("/api/v1/reprocess-events/tx/0x1234").expect(500);

      expect(res.body.error).toBe("RPC Connection Fail");
    });

it("should quarantine after exceeding retry budget", async () => {
  const txHash = "0xabc";
  // First three attempts fail
  mockGetTransactionReceipt.mockRejectedValue(new Error("Transient error"));
  await request(app).post(`/api/v1/reprocess-events/tx/${txHash}`).expect(500);
  await request(app).post(`/api/v1/reprocess-events/tx/${txHash}`).expect(500);
  await request(app).post(`/api/v1/reprocess-events/tx/${txHash}`).expect(500);
  // Fourth attempt should be quarantined
  const res = await request(app).post(`/api/v1/reprocess-events/tx/${txHash}`).expect(200);
  expect(res.body.message).toBe("Transaction quarantined after repeated failures");
  expect(res.body.attempts).toBe(4);
  const norm = "0x0000000000000000000000000000000000000000000000000000000000000abc";
  const quarantineFile = path.join(QUARANTINE_PATH, `${norm}.json`);
  expect(fs.existsSync(quarantineFile)).toBe(true);
});
  });

  describe("POST /reprocess-events/status-changes", () => {
    it("should handle case when there are no events in database", async () => {
      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);

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
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(mockEvents),
            }),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockResolvedValue(null);

      const res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);

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
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(mockEvents),
            }),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockResolvedValue({
        events: [{ from_address: "0xwork" }],
      });

      const res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);

      expect(res.body.results[0]).toEqual({
        eventId: "event_1",
        status: "event_not_found",
      });

      selectMock.mockRestore();
    });

      it("should apply retry budget and quarantine path for failing events", async () => {
        const mockEvents = [
          {
            id: "event_quarantine_test",
            transactionHash: "0x123",
            eventIndex: 0,
            contractAddress: "0xwork",
            eventType: "AgreementStatusChange",
          },
        ];
  
        const selectMock = vi.spyOn(db, "select").mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(mockEvents),
              }),
            }),
          }),
        } as any);
  
        // Always fail with no receipt
        mockGetTransactionReceipt.mockResolvedValue(null);
  
        // First attempt -> error/no_receipt
        let res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);
        expect(res.body.results[0]).toEqual({
          eventId: "event_quarantine_test",
          status: "no_receipt",
        });
  
        // Second attempt -> error/no_receipt
        res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);
        expect(res.body.results[0]).toEqual({
          eventId: "event_quarantine_test",
          status: "no_receipt",
        });
  
        // Third attempt (MAX_RETRIES) -> quarantined
        res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);
        expect(res.body.results[0]).toEqual({
          eventId: "event_quarantine_test",
          status: "quarantined",
          reason: "no_receipt"
        });
  
        // Fourth attempt -> immediately quarantined without RPC call
        mockGetTransactionReceipt.mockClear();
        res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);
        expect(res.body.results[0]).toEqual({
          eventId: "event_quarantine_test",
          status: "quarantined"
        });
        expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
  
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
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(mockEvents),
            }),
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

      const res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);

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
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(mockEvents),
            }),
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

      const res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);

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
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(mockEvents),
            }),
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

      const res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);

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
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(mockEvents),
            }),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockRejectedValue(new Error("RPC Error"));

      const res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);

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

      const res = await request(app).post("/api/v1/reprocess-events/status-changes").expect(500);

      expect(res.body.error).toBe("DB Connection Failed");

      selectMock.mockRestore();
    });

    it("should reject invalid status-changes query params (400)", async () => {
      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes?limit=-1")
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should filter by block range when fromBlock/toBlock provided", async () => {
      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes?fromBlock=100&toBlock=200")
        .expect(200);

      expect(res.body.message).toContain("Reprocessed 0 events");

      selectMock.mockRestore();
    });

    it("should be idempotent on double reprocess (status-changes)", async () => {
      const mockEvents = [
        {
          id: "event_1",
          transactionHash: "0x123",
          eventIndex: 0,
          contractAddress: "0xwork",
          eventType: "AgreementStatusChange",
        },
      ];

      let callCount = 0;
      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(() => {
                callCount++;
                // First call returns events, second call returns empty (already updated)
                return Promise.resolve(callCount === 1 ? mockEvents : []);
              }),
            }),
          }),
        }),
      } as any);

      // Mock a receipt that will trigger the "no_receipt" path so the event stays unchanged
      // (we just want to verify that the second call sees no work to do)
      mockGetTransactionReceipt.mockResolvedValue(null);

      // First call
      const res1 = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);
      expect(res1.body.updated).toBe(0);
      expect(res1.body.results).toHaveLength(1);
      expect(res1.body.results[0].status).toBe("no_receipt");

      // Second call — query returns empty so no events are processed
      const res2 = await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);
      expect(res2.body.updated).toBe(0);
      expect(res2.body.results).toHaveLength(0);

      // Verify fetch was called via processTxReceipt
      expect(mockGetTransactionReceipt).toHaveBeenCalledTimes(1);

      selectMock.mockRestore();
      callCount = 0;
    });

    it("should invoke orderBy for deterministic pagination", async () => {
      const orderByMock = vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      });
      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: orderByMock,
          }),
        }),
      } as any);

      await request(app).post("/api/v1/reprocess-events/status-changes").expect(200);

      expect(orderByMock).toHaveBeenCalledTimes(1);

      selectMock.mockRestore();
    });

    it("should report hasMore: true when the page returns exactly `limit` rows", async () => {
      const mockEvents = Array.from({ length: 2 }, (_, i) => ({
        id: `event_${i}`,
        transactionHash: `0x${i}`,
        eventIndex: 0,
        contractAddress: "0xwork",
        eventType: "AgreementStatusChange",
      }));

      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(mockEvents),
            }),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockResolvedValue(null);

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes?limit=2")
        .expect(200);

      expect(res.body.hasMore).toBe(true);

      selectMock.mockRestore();
    });

    it("should report hasMore: false when the page returns fewer than `limit` rows", async () => {
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
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(mockEvents),
            }),
          }),
        }),
      } as any);

      mockGetTransactionReceipt.mockResolvedValue(null);

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes?limit=100")
        .expect(200);

      expect(res.body.hasMore).toBe(false);

      selectMock.mockRestore();
    });
  });

  describe("POST /reprocess-events/batch", () => {
    it("should process a batch of tx hashes successfully", async () => {
      const mockReceipt1 = {
        transaction_hash: "0x1234567890abcdef",
        blockNumber: 100,
        events: [
          {
            from_address: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
            data: ["123", "0x123", "0x456", "0x789", "0", "1"],
          },
        ],
      };
      const mockReceipt2 = {
        transaction_hash: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
        blockNumber: 200,
        events: [
          {
            from_address: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
            data: ["456", "0xabc", "0xdef", "0x789", "0", "1"],
          },
        ],
      };

      mockGetTransactionReceipt
        .mockResolvedValueOnce(mockReceipt1)
        .mockResolvedValueOnce(mockReceipt2);

      const res = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send({
          tx_hashes: ["0x1234567890abcdef", "0xdeadbeef00000000000000000000000000000000000000000000000000000001"],
        })
        .expect(200);

      expect(res.body.summary.total).toBe(2);
      expect(res.body.summary.processed).toBe(2);
      expect(res.body.summary.errors).toBe(0);
      expect(res.body.results).toHaveLength(2);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should reject empty tx_hashes array (400)", async () => {
      const res = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send({ tx_hashes: [] })
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should reject missing tx_hashes field (400)", async () => {
      const res = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send({})
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should reject invalid tx hash format in array (400)", async () => {
      const res = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send({ tx_hashes: ["not-a-valid-hash"] })
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockGetTransactionReceipt).not.toHaveBeenCalled();
    });

    it("should reject oversized tx_hashes array (400)", async () => {
      const tx_hashes = Array.from({ length: 51 }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`);

      const res = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send({ tx_hashes })
        .expect(400);

      expect(res.body.error).toContain("50");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should handle per-tx errors without aborting the batch", async () => {
      mockGetTransactionReceipt
        .mockResolvedValueOnce({
          transaction_hash: "0x1234567890abcdef",
          blockNumber: 100,
          events: [],
        })
        .mockRejectedValueOnce(new Error("RPC Error"));

      const res = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send({
          tx_hashes: [
            "0x1234567890abcdef",
            "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
          ],
        })
        .expect(200);

      expect(res.body.summary.total).toBe(2);
      expect(res.body.summary.noEvents).toBe(1);
      expect(res.body.summary.errors).toBe(1);
      expect(res.body.results[1].status).toBe("error");
      expect(res.body.results[1].error).toBe("RPC Error");
    });

    it("should be idempotent on double reprocess (batch)", async () => {
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

      const body = { tx_hashes: ["0x1234567890abcdef"] };

      // First call
      const res1 = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send(body)
        .expect(200);

      expect(res1.body.summary.processed).toBe(1);

      // Second call — same body, same result (processTxReceipt uses onConflictDoNothing)
      const res2 = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send(body)
        .expect(200);

      expect(res2.body.summary.processed).toBe(1);
      expect(res2.body.results[0].txHash).toBe(res1.body.results[0].txHash);
    });

    it("should dedupe an exact duplicate tx hash to a single RPC call", async () => {
      const mockReceipt = {
        transaction_hash: "0xaaaa",
        blockNumber: 100,
        events: [
          {
            from_address: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
            data: ["123", "0x123", "0x456", "0x789", "0", "1"],
          },
        ],
      };
      mockGetTransactionReceipt.mockResolvedValue(mockReceipt);

      const res = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send({ tx_hashes: ["0xaaaa", "0xaaaa"] })
        .expect(200);

      expect(mockGetTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results[0]).toEqual(res.body.results[1]);
      expect(res.body.summary.duplicates).toBe(1);
      expect(res.body.summary.total).toBe(2);
    });

    it("should dedupe hashes that differ only by leading-zero padding", async () => {
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

      const unpadded = "0x1234567890abcdef";
      const padded = `0x${"0".repeat(48)}1234567890abcdef`; // 66 chars, same value normalized

      const res = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send({ tx_hashes: [unpadded, padded] })
        .expect(200);

      expect(mockGetTransactionReceipt).toHaveBeenCalledTimes(1);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results[0]).toEqual(res.body.results[1]);
      expect(res.body.summary.duplicates).toBe(1);
      expect(res.body.summary.total).toBe(2);
    });

    it("should report duplicates: 0 for an all-unique batch (backward compat)", async () => {
      const mockReceipt1 = {
        transaction_hash: "0x1234567890abcdef",
        blockNumber: 100,
        events: [],
      };
      const mockReceipt2 = {
        transaction_hash: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
        blockNumber: 200,
        events: [],
      };

      mockGetTransactionReceipt
        .mockResolvedValueOnce(mockReceipt1)
        .mockResolvedValueOnce(mockReceipt2);

      const res = await request(app)
        .post("/api/v1/reprocess-events/batch")
        .send({
          tx_hashes: [
            "0x1234567890abcdef",
            "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
          ],
        })
        .expect(200);

      expect(res.body.summary.duplicates).toBe(0);
      expect(res.body.summary.total).toBe(2);
      expect(mockGetTransactionReceipt).toHaveBeenCalledTimes(2);
    });
  });

  describe("In-flight Idempotency Guard (HTTP 409)", () => {
    it("returns HTTP 409 when a second call is made while reprocessing is in-flight", async () => {
      let resolveFirstCall: (value: any) => void;
      const slowReceiptPromise = new Promise((resolve) => {
        resolveFirstCall = resolve;
      });

      mockGetTransactionReceipt.mockImplementationOnce(() => slowReceiptPromise);

      const txHash = "0x1234567890abcdef";

      // Trigger first reprocess request (starts running and acquires lock)
      const firstReq = request(app).post(`/api/v1/reprocess-events/tx/${txHash}`);

      // Wait briefly to ensure first request enters the handler and acquires the lock
      await new Promise((r) => setTimeout(r, 50));

      // Trigger second concurrent request while first is in-flight
      const secondRes = await request(app)
        .post(`/api/v1/reprocess-events/tx/${txHash}`)
        .expect(409);

      expect(secondRes.body.error).toBe("Reprocessing operation already in progress");

      // Resolve the first request
      resolveFirstCall!({
        transaction_hash: txHash,
        blockNumber: 100,
        events: [],
      });

      const firstRes = await firstReq;
      expect(firstRes.status).toBe(200);

      // Verify that after completion, the lock is released and a new request succeeds
      mockGetTransactionReceipt.mockResolvedValueOnce({
        transaction_hash: txHash,
        blockNumber: 101,
        events: [],
      });

      const thirdRes = await request(app)
        .post(`/api/v1/reprocess-events/tx/${txHash}`)
        .expect(200);
      expect(thirdRes.body.message).toBe("Events reprocessed");
    });

    it("reliably releases the lock even if the route handler throws an exception", async () => {
      mockGetTransactionReceipt.mockRejectedValue(new Error("Fatal RPC Error"));

      const txHash = "0x1234567890abcdef";

      // First call throws / fails
      await request(app).post(`/api/v1/reprocess-events/tx/${txHash}`).expect(500);

      // Verify the lock was released despite the error
      expect(getReprocessingLockStatus()).toBe(false);

      // Succeed on subsequent call
      mockGetTransactionReceipt.mockResolvedValueOnce({
        transaction_hash: txHash,
        blockNumber: 100,
        events: [],
      });

      const nextRes = await request(app).post(`/api/v1/reprocess-events/tx/${txHash}`).expect(200);
      expect(nextRes.body.message).toBe("Events reprocessed");
    });

    it("rejects concurrent /status-changes calls with 409", async () => {
      // Manually acquire lock to simulate an in-flight background job
      acquireReprocessLock();

      const res = await request(app)
        .post("/api/v1/reprocess-events/status-changes")
        .expect(409);

      expect(res.body.error).toBe("Reprocessing operation already in progress");

      releaseReprocessLock();

      const selectMock = vi.spyOn(db, "select").mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const nextRes = await request(app)
        .post("/api/v1/reprocess-events/status-changes")
        .expect(200);

      expect(nextRes.body.message).toContain("Reprocessed 0 events");
      selectMock.mockRestore();
    });
  });
});

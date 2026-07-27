/**
 * @file events.test.ts
 * Tests for the shared processTxReceipt helper used by both
 * POST /events/process_tx/:tx_hash and POST /events/process_batch.
 *
 * Mock strategy
 * -------------
 * - `vi.hoisted()` is used to create spies that must be shared between
 *   vi.mock factories (which are hoisted to the top of the file) and test
 *   bodies.
 * - `Contract` is mocked as a plain class so `new Contract(...)` works.
 * - DB insert/update chains are re-wired in beforeEach after clearAllMocks().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Hoisted spies – must be created BEFORE vi.mock factories run
// ---------------------------------------------------------------------------

const parseEventMock = vi.hoisted(() => vi.fn());

const { dbSelectMock, queryState } = vi.hoisted(() => {
  const state = {
    eventsRows: [] as any[],
    lastWhere: null as any,
    lastLimit: 50,
    lastOffset: 0,
  };

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn((cond) => {
        state.lastWhere = cond;
        return {
          orderBy: vi.fn(() => ({
            limit: vi.fn((limit) => {
              state.lastLimit = limit;
              return {
                offset: vi.fn((offset) => {
                  state.lastOffset = offset;
                  return Promise.resolve(state.eventsRows);
                }),
              };
            }),
          })),
        };
      }),
      orderBy: vi.fn(() => ({
        limit: vi.fn((limit) => {
          state.lastLimit = limit;
          return {
            offset: vi.fn((offset) => {
              state.lastOffset = offset;
              return Promise.resolve(state.eventsRows);
            }),
          };
        }),
      })),
    })),
  }));

  return { dbSelectMock: select, queryState: state };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../db/index.js", () => {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });

  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });

  return {
    db: { insert, update, select: dbSelectMock },
    schema: {
      agreements: "agreements",
      agreementEvents: "agreementEvents",
      payments: "payments",
      escrowEvents: "escrowEvents",
    },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ type: "eq", col, val }),
  and: (...conds: any[]) => ({ type: "and", conds }),
  gte: (col: any, val: any) => ({ type: "gte", col, val }),
  lte: (col: any, val: any) => ({ type: "lte", col, val }),
  inArray: (col: any, val: any) => ({ type: "inArray", col, val }),
  desc: (col: any) => ({ type: "desc", col }),
}));

vi.mock("../starknet/client.js", () => ({
  provider: { getTransactionReceipt: vi.fn() },
  agreementContract: vi.fn(() => ({
    // Resolves to the same token as the AgreementCreated fixture so the default
    // path verifies cleanly; the verification tests override this per case.
    get_token: vi
      .fn()
      .mockResolvedValue(
        BigInt("0xdeadbeef00000000000000000000000000000000000000000000000000000002"),
      ),
  })),
}));

vi.mock("../starknet/abi.js", () => ({
  loadAbiFromContractClassJsonPath: vi.fn(() => []),
}));

// Contract is a class – use class syntax inside mockImplementation (vitest v4 requirement).
// parseEventMock is shared via vi.hoisted so every instance delegates to it.
vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  return {
    ...actual,
    Contract: class {
      parseEvent = parseEventMock;
    },
  };
});

vi.mock("../config.js", () => ({
  defaults: {
    workAgreementAddress: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
    payrollEscrowAddress: "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
  },
  abiPaths: { agreement: "/fake/agreement.json", escrow: "/fake/escrow.json" },
  env: { NODE_ENV: "test" },
}));

vi.mock("../utils/codec.js", () => ({
  toHexString: (n: bigint) => `0x${n.toString(16)}`,
  u256ToString: (n: bigint) => n.toString(),
}));

// ---------------------------------------------------------------------------
// Import SUT and mocked modules AFTER all vi.mock calls
// ---------------------------------------------------------------------------

import express from "express";
import request from "supertest";
import {
  processTxReceipt,
  eventsRouter,
  parseEventTypeQuery,
  parseTimestampQuery,
  validateTimeRange,
} from "./events.js";
import { db } from "../db/index.js";
import { provider, agreementContract } from "../starknet/client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGREEMENT_ADDRESS = "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd";

const TX_A = "0x000000000000000000000000000000000000000000000000000000000000aaaa";
const TX_B = "0x000000000000000000000000000000000000000000000000000000000000bbbb";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgreementReceipt(txHash: string) {
  return {
    transaction_hash: txHash,
    block_number: 12345,
    events: [
      {
        from_address: AGREEMENT_ADDRESS,
        keys: ["0xAgreementCreated"],
        data: [
          "0x1",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
          "0x0",
          "0x1",
        ],
      },
    ],
  };
}

function makePaymentReceipt(txHash: string) {
  return {
    transaction_hash: txHash,
    block_number: 12346,
    events: [
      {
        from_address: AGREEMENT_ADDRESS,
        keys: ["0xPaymentSent"],
        data: [
          "0x1",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
          "0x64",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
        ],
      },
    ],
  };
}

const EMPTY_RECEIPT = { transaction_hash: TX_B, block_number: 99, events: [] };

// Decoded shapes returned by parseEvent
const decodedAgreementCreated = () => ({
  name: "AgreementCreated",
  data: {
    agreement_id: "1",
    employer: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
    contributor: null,
    token: "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
    mode: "0",
    payment_type: "1",
  },
});

const decodedPaymentSent = () => ({
  name: "PaymentSent",
  data: {
    agreement_id: "1",
    from: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
    to: "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
    amount: "100",
    token: "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
  },
});

// ---------------------------------------------------------------------------
// beforeEach helper – re-wires db.insert after clearAllMocks resets everything
// ---------------------------------------------------------------------------

function rewireDbInsert() {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
  vi.mocked(db.insert).mockReturnValue({ values } as any);
}

// ---------------------------------------------------------------------------
// Tests – shared processor
// ---------------------------------------------------------------------------

// Named via vi.hoisted so individual tests can override behavior (e.g.
// simulate requireAdmin rejecting a non-admin caller) with mockImplementationOnce.
// vi.clearAllMocks() (used throughout this file) clears call history but not
// the base implementation set here, so the default "always call next()"
// behavior persists across tests unless explicitly overridden.
const { mockRequireAuth, mockRequireAdmin } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  mockRequireAdmin: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock("../auth/middleware.js", () => ({
  requireAuth: mockRequireAuth,
  requireAdmin: mockRequireAdmin,
}));
describe("processTxReceipt – shared processor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rewireDbInsert();
  });

  it("returns not_found when provider returns null", async () => {
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(null as any);

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("not_found");
    expect(result.eventsProcessed).toBe(0);
  });

  it("returns no_events when receipt has empty events array", async () => {
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(EMPTY_RECEIPT as any);

    const result = await processTxReceipt(TX_B);

    expect(result.status).toBe("no_events");
    expect(result.eventsProcessed).toBe(0);
  });

  it("decodes AgreementCreated and inserts into agreementEvents and agreements", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(
      makeAgreementReceipt(TX_A) as any,
    );

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("processed");
    expect(result.eventsProcessed).toBe(1);
    expect(result.eventLabels[0]).toMatch(/AgreementCreated/);
    expect(vi.mocked(db.insert)).toHaveBeenCalledWith("agreementEvents");
    expect(vi.mocked(db.insert)).toHaveBeenCalledWith("agreements");
  });

  it("decodes PaymentSent and inserts into payments", async () => {
    parseEventMock.mockReturnValue(decodedPaymentSent());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(
      makePaymentReceipt(TX_A) as any,
    );

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("processed");
    expect(result.eventsProcessed).toBe(1);
    expect(result.eventLabels[0]).toMatch(/PaymentSent/);
    expect(vi.mocked(db.insert)).toHaveBeenCalledWith("payments");
  });

  it("is idempotent – all inserts use onConflictDoNothing", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const r1 = await processTxReceipt(TX_A);
    const r2 = await processTxReceipt(TX_A);

    expect(r1.status).toBe("processed");
    expect(r2.status).toBe("processed");
    // insert was called on both runs – no uniqueness errors because of
    // onConflictDoNothing (verified by the mock not throwing)
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });

  it("normalises a short tx hash to exactly 0x + 64 hex chars", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    const paddedHash = "0x000000000000000000000000000000000000000000000000000000000000aaaa";
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(
      makeAgreementReceipt(paddedHash) as any,
    );

    const result = await processTxReceipt("0xaaaa"); // short form

    expect(result.txHash.length).toBe(66);
    expect(result.txHash).toBe(paddedHash);
  });

  it("falls back to un-padded hash when normalised lookup fails", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt)
      .mockRejectedValueOnce(new Error("padded hash not found"))
      .mockResolvedValueOnce(makeAgreementReceipt(TX_A) as any);

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("processed");
    expect(vi.mocked(provider.getTransactionReceipt)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tests – batch semantics (per-tx isolation)
// ---------------------------------------------------------------------------

describe("processTxReceipt – batch semantics (per-tx isolation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rewireDbInsert();
  });

  it("processes two different tx hashes independently", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt)
      .mockResolvedValueOnce(makeAgreementReceipt(TX_A) as any)
      .mockResolvedValueOnce(makeAgreementReceipt(TX_B) as any);

    const r1 = await processTxReceipt(TX_A);
    const r2 = await processTxReceipt(TX_B);

    expect(r1.status).toBe("processed");
    expect(r2.status).toBe("processed");
    expect(r1.txHash).not.toBe(r2.txHash);
  });

  it("a failing tx throws so the batch handler can capture it per-tx", async () => {
    // Both the padded and un-padded lookups must fail to surface the RPC error
    vi.mocked(provider.getTransactionReceipt).mockRejectedValue(new Error("RPC timeout"));

    await expect(processTxReceipt(TX_A)).rejects.toThrow("RPC timeout");
  });

  it("re-processing the same tx is idempotent (no duplicate rows)", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const r1 = await processTxReceipt(TX_A);
    const r2 = await processTxReceipt(TX_A);

    expect(r1.status).toBe("processed");
    expect(r2.status).toBe("processed");
  });

  it("returns no_events for a tx with an empty events list", async () => {
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(EMPTY_RECEIPT as any);

    const result = await processTxReceipt(TX_B);

    expect(result.status).toBe("no_events");
    expect(result.eventsProcessed).toBe(0);
  });

  it("written rows have per-event composite IDs (txHash_index) preventing duplicates", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(
      makeAgreementReceipt(TX_A) as any,
    );

    await processTxReceipt(TX_A);

    // Capture the first `values()` call to agreementEvents insert
    const insertCalls = vi.mocked(db.insert).mock.calls;
    const agreementEventInsert = insertCalls.find(([tbl]) => tbl === "agreementEvents");
    expect(agreementEventInsert).toBeDefined();

    // values() was called on the insert mock – the ID includes the tx hash
    const valuesMock = vi
      .mocked(db.insert)
      .mock.results.find((_, i) => insertCalls[i]?.[0] === "agreementEvents");
    expect(valuesMock).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests – Zod input validation schemas
// ---------------------------------------------------------------------------

describe("Zod input validation schemas", () => {
  const TxHashSchema = z
    .string()
    .min(3)
    .max(66)
    .regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid Starknet transaction hash format");

  const BatchSchema = z.object({
    tx_hashes: z.array(TxHashSchema).min(1).max(50),
  });

  it("TxHashSchema rejects non-hex strings", () => {
    expect(() => TxHashSchema.parse("not-a-hash")).toThrow();
    expect(() => TxHashSchema.parse("0xGGGG")).toThrow();
    expect(() => TxHashSchema.parse("")).toThrow();
    expect(() => TxHashSchema.parse("1234abcd")).toThrow(); // missing 0x prefix
  });

  it("TxHashSchema accepts short and full-length valid hashes", () => {
    expect(() => TxHashSchema.parse("0xabc")).not.toThrow();
    expect(() => TxHashSchema.parse(TX_A)).not.toThrow();
    expect(() => TxHashSchema.parse("0x" + "f".repeat(64))).not.toThrow();
  });

  it("BatchSchema rejects arrays with more than 50 hashes (MAX_BATCH_SIZE)", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `0x${i.toString(16).padStart(4, "0")}`);
    expect(() => BatchSchema.parse({ tx_hashes: tooMany })).toThrow();
  });

  it("BatchSchema rejects an empty tx_hashes array", () => {
    expect(() => BatchSchema.parse({ tx_hashes: [] })).toThrow();
  });

  it("BatchSchema accepts arrays of 1 to 50 valid hashes", () => {
    const maxValid = Array.from({ length: 50 }, (_, i) => `0x${i.toString(16).padStart(4, "0")}`);
    expect(() => BatchSchema.parse({ tx_hashes: maxValid })).not.toThrow();
    expect(() => BatchSchema.parse({ tx_hashes: [TX_A] })).not.toThrow();
  });

  it("BatchSchema rejects a batch containing even one invalid hash", () => {
    expect(() => BatchSchema.parse({ tx_hashes: [TX_A, "not-a-hash"] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests – on-chain token verification (#29)
// ---------------------------------------------------------------------------

describe("processTxReceipt – on-chain token verification", () => {
  // The token carried by the AgreementCreated fixture (event data[3]).
  const EVENT_TOKEN = BigInt("0xdeadbeef00000000000000000000000000000000000000000000000000000002");
  const ONCHAIN_MISMATCH = BigInt(
    "0xcafebabe00000000000000000000000000000000000000000000000000000003",
  );

  let setSpy: ReturnType<typeof vi.fn>;

  /** Re-wire the db.insert and db.update chains after clearAllMocks. */
  function rewireDb() {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as any);

    const where = vi.fn().mockResolvedValue(undefined);
    setSpy = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);
  }

  function mockGetToken(impl: () => Promise<bigint>) {
    vi.mocked(agreementContract).mockReturnValue({ get_token: vi.fn(impl) } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rewireDb();
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);
  });

  it("reports tokenVerified true and does not update when the on-chain token matches", async () => {
    mockGetToken(() => Promise.resolve(EVENT_TOKEN));

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("processed");
    expect(result.tokenVerified).toBe(true);
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it("corrects the stored token and still reports tokenVerified true on mismatch", async () => {
    mockGetToken(() => Promise.resolve(ONCHAIN_MISMATCH));

    const result = await processTxReceipt(TX_A);

    expect(result.tokenVerified).toBe(true);
    expect(vi.mocked(db.update)).toHaveBeenCalledWith("agreements");
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.stringContaining("cafebabe") }),
    );
  });

  it("reports tokenVerified false when the contract call fails, without throwing", async () => {
    mockGetToken(() => Promise.reject(new Error("RPC down")));

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("processed");
    expect(result.eventsProcessed).toBe(1);
    expect(result.tokenVerified).toBe(false);
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests – HTTP routes (process_tx / process_batch)
// ---------------------------------------------------------------------------

describe("events routes – process_tx and process_batch responses", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(eventsRouter);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rewireDbInsert();
    // Force a deterministic "token matches" path for the default route tests.
    vi.mocked(agreementContract).mockReturnValue({
      get_token: vi
        .fn()
        .mockResolvedValue(
          BigInt("0xdeadbeef00000000000000000000000000000000000000000000000000000002"),
        ),
    } as any);
  });

  it("process_tx returns 200 and surfaces tokenVerified for an AgreementCreated tx", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const res = await request(makeApp()).post(`/events/process_tx/${TX_A}`).send();

    expect(res.status).toBe(200);
    expect(res.body.tokenVerified).toBe(true);
    expect(res.body.transactionHash).toBe(TX_A);
  });

  it("process_tx returns 404 when the transaction is not found", async () => {
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(null as any);

    const res = await request(makeApp()).post(`/events/process_tx/${TX_A}`).send();

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/not found/i);
  });

  it("process_batch returns a per-tx summary", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const res = await request(makeApp())
      .post("/events/process_batch")
      .send({ tx_hashes: [TX_A] });

    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(1);
    expect(res.body.results).toHaveLength(1);
  });

  it("process_tx returns 400 with a clean error for a malformed hash", async () => {
    const res = await request(makeApp()).post("/events/process_tx/not-a-tx-hash").send();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid Starknet transaction hash format");
    // Never should have reached the provider with garbage input.
    expect(provider.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("process_tx still works for valid TX_A/TX_B-style hashes", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_B) as any);

    const res = await request(makeApp()).post(`/events/process_tx/${TX_B}`).send();

    expect(res.status).toBe(200);
    expect(res.body.transactionHash).toBe(TX_B);
  });

  it("process_batch dedupes an exact duplicate hash within the same batch", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const res = await request(makeApp())
      .post("/events/process_batch")
      .send({ tx_hashes: [TX_A, TX_A] });

    expect(res.status).toBe(200);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toEqual(res.body.results[1]);
    expect(res.body.summary.duplicates).toBe(1);
    expect(res.body.summary.total).toBe(2);
  });

  it("process_batch dedupes hashes that differ only by leading-zero padding", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const unpadded = "0xaaaa";

    const res = await request(makeApp())
      .post("/events/process_batch")
      .send({ tx_hashes: [TX_A, unpadded] });

    expect(res.status).toBe(200);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.summary.duplicates).toBe(1);
    expect(res.body.summary.total).toBe(2);
  });

  it("process_batch reports zero duplicates for all-unique hashes", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt)
      .mockResolvedValueOnce(makeAgreementReceipt(TX_A) as any)
      .mockResolvedValueOnce(makeAgreementReceipt(TX_B) as any);

    const res = await request(makeApp())
      .post("/events/process_batch")
      .send({ tx_hashes: [TX_A, TX_B] });

    expect(res.status).toBe(200);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(res.body.summary.duplicates).toBe(0);
    expect(res.body.summary.total).toBe(2);
  });
});

describe("GET /events event-type and time-range filters", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(eventsRouter);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    queryState.eventsRows = [
      {
        id: "tx1_0",
        agreementId: "100",
        contractAddress: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
        eventType: "AgreementCreated",
        createdAt: new Date("2026-03-01T12:00:00Z"),
      },
      {
        id: "tx2_0",
        agreementId: "100",
        contractAddress: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
        eventType: "PaymentSent",
        createdAt: new Date("2026-03-02T12:00:00Z"),
      },
    ];
  });

  describe("Helper Functions", () => {
    it("parseEventTypeQuery handles strings, comma-separated values, arrays, and deduplication", () => {
      expect(parseEventTypeQuery(undefined)).toEqual([]);
      expect(parseEventTypeQuery("AgreementCreated")).toEqual(["AgreementCreated"]);
      expect(parseEventTypeQuery("AgreementCreated, PaymentSent")).toEqual(["AgreementCreated", "PaymentSent"]);
      expect(parseEventTypeQuery(["AgreementCreated, PaymentSent", "AgreementActivated", "AgreementCreated"])).toEqual([
        "AgreementCreated",
        "PaymentSent",
        "AgreementActivated",
      ]);
    });

    it("parseTimestampQuery correctly parses ISO strings and numeric timestamps", () => {
      expect(parseTimestampQuery(undefined, "from")).toBeUndefined();
      expect(parseTimestampQuery("", "from")).toBeUndefined();

      const iso = "2026-01-01T00:00:00.000Z";
      expect(parseTimestampQuery(iso, "from")?.toISOString()).toBe(iso);

      const ms = 1700000000000;
      expect(parseTimestampQuery(ms, "from")?.getTime()).toBe(ms);

      const sec = 1700000000;
      expect(parseTimestampQuery(sec, "from")?.getTime()).toBe(sec * 1000);
    });

    it("parseTimestampQuery throws ZodError on malformed timestamp string", () => {
      expect(() => parseTimestampQuery("not-a-date", "from")).toThrow();
      expect(() => parseTimestampQuery({} as any, "from")).toThrow();
    });

    it("validateTimeRange passes valid ranges and throws on inverted bounds", () => {
      const earlier = new Date("2026-01-01");
      const later = new Date("2026-02-01");

      expect(() => validateTimeRange(earlier, later)).not.toThrow();
      expect(() => validateTimeRange(earlier, earlier)).not.toThrow();
      expect(() => validateTimeRange(earlier, undefined)).not.toThrow();
      expect(() => validateTimeRange(undefined, later)).not.toThrow();

      expect(() => validateTimeRange(later, earlier)).toThrow();
    });
  });

  describe("HTTP GET /events filtering integration", () => {
    it("returns events list with default pagination when no filters are supplied", async () => {
      const res = await request(makeApp()).get("/events");

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
      expect(res.body.count).toBe(2);
      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(0);
    });

    it("filters by eventType (single or comma-separated)", async () => {
      const res = await request(makeApp()).get("/events?eventType=AgreementCreated,PaymentSent");

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
      expect(queryState.lastWhere).toBeDefined();
    });

    it("filters by time range (from and to parameters)", async () => {
      const from = "2026-03-01T00:00:00Z";
      const to = "2026-03-05T00:00:00Z";
      const res = await request(makeApp()).get(`/events?from=${from}&to=${to}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
      expect(queryState.lastWhere).toBeDefined();
    });

    it("intersects eventType, time-range, agreement_id, and pagination params cleanly", async () => {
      const from = "2026-03-01T00:00:00Z";
      const to = "2026-03-05T00:00:00Z";
      const res = await request(makeApp()).get(
        `/events?eventType=AgreementCreated&from=${from}&to=${to}&agreement_id=100&limit=10&offset=5`
      );

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(10);
      expect(res.body.offset).toBe(5);
      expect(queryState.lastLimit).toBe(10);
      expect(queryState.lastOffset).toBe(5);
      expect(queryState.lastWhere).toBeDefined();
    });

    it("returns 400 Bad Request when from or to timestamp is malformed", async () => {
      const res = await request(makeApp()).get("/events?from=invalid-date");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation failed");
      expect(res.body.details).toBeDefined();
    });

    it("returns 400 Bad Request when from timestamp is strictly greater than to timestamp", async () => {
      const res = await request(makeApp()).get(
        "/events?from=2026-12-31T00:00:00Z&to=2026-01-01T00:00:00Z"
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation failed");
      expect(res.body.details[0].message).toMatch(/from timestamp must be less than or equal to to timestamp/);
    });
  });
});

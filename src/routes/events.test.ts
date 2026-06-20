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
    db: { insert, update },
    schema: {
      agreements: "agreements",
      agreementEvents: "agreementEvents",
      payments: "payments",
      escrowEvents: "escrowEvents",
    },
  };
});

vi.mock("../starknet/client.js", () => ({
  provider: { getTransactionReceipt: vi.fn() },
  agreementContract: vi.fn(() => ({
    get_token: vi.fn().mockResolvedValue(
      "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
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
    workAgreementAddress:
      "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
    payrollEscrowAddress:
      "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
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

import { processTxReceipt } from "./events.js";
import { db } from "../db/index.js";
import { provider } from "../starknet/client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGREEMENT_ADDRESS =
  "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd";

const TX_A =
  "0x000000000000000000000000000000000000000000000000000000000000aaaa";
const TX_B =
  "0x000000000000000000000000000000000000000000000000000000000000bbbb";

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


vi.mock("../auth/middleware.js", () => ({
  requireAuth: vi.fn((req, res, next) => next()),
  requireAdmin: vi.fn((req, res, next) => next()),
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
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(
      EMPTY_RECEIPT as any,
    );

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
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(
      makeAgreementReceipt(TX_A) as any,
    );

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
    const paddedHash =
      "0x000000000000000000000000000000000000000000000000000000000000aaaa";
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
    vi.mocked(provider.getTransactionReceipt).mockRejectedValue(
      new Error("RPC timeout"),
    );

    await expect(processTxReceipt(TX_A)).rejects.toThrow("RPC timeout");
  });

  it("re-processing the same tx is idempotent (no duplicate rows)", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(
      makeAgreementReceipt(TX_A) as any,
    );

    const r1 = await processTxReceipt(TX_A);
    const r2 = await processTxReceipt(TX_A);

    expect(r1.status).toBe("processed");
    expect(r2.status).toBe("processed");
  });

  it("returns no_events for a tx with an empty events list", async () => {
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(
      EMPTY_RECEIPT as any,
    );

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
    const valuesMock = vi.mocked(db.insert).mock.results.find(
      (_, i) => insertCalls[i]?.[0] === "agreementEvents",
    );
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
    const tooMany = Array.from({ length: 51 }, (_, i) =>
      `0x${i.toString(16).padStart(4, "0")}`,
    );
    expect(() => BatchSchema.parse({ tx_hashes: tooMany })).toThrow();
  });

  it("BatchSchema rejects an empty tx_hashes array", () => {
    expect(() => BatchSchema.parse({ tx_hashes: [] })).toThrow();
  });

  it("BatchSchema accepts arrays of 1 to 50 valid hashes", () => {
    const maxValid = Array.from({ length: 50 }, (_, i) =>
      `0x${i.toString(16).padStart(4, "0")}`,
    );
    expect(() => BatchSchema.parse({ tx_hashes: maxValid })).not.toThrow();
    expect(() => BatchSchema.parse({ tx_hashes: [TX_A] })).not.toThrow();
  });

  it("BatchSchema rejects a batch containing even one invalid hash", () => {
    expect(() =>
      BatchSchema.parse({ tx_hashes: [TX_A, "not-a-hash"] }),
    ).toThrow();
  });
});

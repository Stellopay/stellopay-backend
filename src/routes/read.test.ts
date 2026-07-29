import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { isValidationError } from "../utils/validation.js";

const { callContract, envMock, mockEscrow, mockAgreement } = vi.hoisted(() => {
  return {
    callContract: vi.fn(),
    envMock: { LOG_FORMAT: "pretty" },
    mockEscrow: {
      get_token: vi.fn(),
      get_agreement_balance: vi.fn(),
      get_agreement_employer: vi.fn(),
    },
    mockAgreement: {
      get_employer: vi.fn(),
      get_contributor: vi.fn(),
      get_token: vi.fn(),
      get_escrow: vi.fn(),
      get_total_amount: vi.fn(),
      get_paid_amount: vi.fn(),
      get_status: vi.fn(),
      get_agreement_mode: vi.fn(),
      get_dispute_status: vi.fn(),
    },
  };
});

vi.mock("../starknet/client.js", () => ({
  provider: { callContract },
  escrowContract: vi.fn(() => mockEscrow),
  agreementContract: vi.fn(() => mockAgreement),
}));

vi.mock("../config.js", () => ({ env: envMock }));

vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  return {
    ...actual,
    shortString: {
      ...actual.shortString,
      decodeShortString: vi.fn((val: string) => {
        if (val === "0x55534443") return "USDC";
        if (val === "0x574549") return "WEI";
        return actual.shortString.decodeShortString(val);
      }),
    },
  };
});

import {
  readRouter,
  CursorPaginationSchema,
  BatchReadSchema,
  withReadRetry,
} from "./read.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/api/v1", readRouter);
  app.use(
    (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      // Mirror the relevant parts of the global error handler in src/index.ts:
      // honour err.status for ValidationError (4xx) so cursor-validation tests
      // see the correct HTTP status code rather than a hardcoded 500.
      const status = isValidationError(error)
        ? (error as any).status
        : 500;
      res.status(status).json({ error: error.message });
    },
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Token routes
// ---------------------------------------------------------------------------
describe("GET /token/:token/balance/:owner", () => {
  it("returns the balance on success", async () => {
    callContract.mockResolvedValue(["0x3e8", "0x0"]);

    const res = await request(makeApp()).get("/api/v1/token/0xabc/balance/0xdef").expect(200);

    expect(res.body).toEqual({ token: "0xabc", owner: "0xdef", balance: "1000" });
    expect(callContract).toHaveBeenCalledWith({
      contractAddress: "0xabc",
      entrypoint: "balance_of",
      calldata: ["0xdef"],
    });
    const op = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();

    const result = await withReadRetry(op, { baseDelayMs: 1, maxDelayMs: 5 }, onRetry);

    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    const info = onRetry.mock.calls[0][0] as { attempt: number; maxAttempts: number; retriesSoFar: number };
    expect(info.attempt).toBe(1);
    expect(info.maxAttempts).toBe(3);
    expect(info.retriesSoFar).toBe(1);
  });

  it("returns 500 when RPC result is not an array", async () => {
    callContract.mockResolvedValue(undefined);

    const res = await request(makeApp()).get("/api/v1/token/0xabc/balance/0xdef").expect(500);

    expect(res.body.error).toContain("Unexpected balance_of result");
  });

  it("returns 500 when RPC result has fewer than 2 elements", async () => {
    callContract.mockResolvedValue(["0x1"]);

    const res = await request(makeApp()).get("/api/v1/token/0xabc/balance/0xdef").expect(500);

    expect(res.body.error).toContain("Unexpected balance_of result");
  });

  it("rejects an address shorter than 3 characters", async () => {
    await request(makeApp()).get("/api/v1/token/ab/balance/0xdef").expect(500);
    expect(callContract).not.toHaveBeenCalled();
  });
});

describe("GET /token/:token/decimals", () => {
  it("returns decimals on success", async () => {
    callContract.mockResolvedValue(["0x6"]);

    const res = await request(makeApp()).get("/api/v1/token/0xabc/decimals").expect(200);

    expect(res.body).toEqual({ token: "0xabc", decimals: 6 });
    expect(callContract).toHaveBeenCalledWith({
      contractAddress: "0xabc",
      entrypoint: "decimals",
      calldata: [],
    });
  });

  it("returns 500 when result is empty", async () => {
    callContract.mockResolvedValue([]);

    const res = await request(makeApp()).get("/api/v1/token/0xabc/decimals").expect(500);

    expect(res.body.error).toContain("Unexpected decimals result");
  });

  it("returns 500 when result is undefined", async () => {
    callContract.mockResolvedValue(undefined);

    const res = await request(makeApp()).get("/api/v1/token/0xabc/decimals").expect(500);

    expect(res.body.error).toContain("Unexpected decimals result");
  });
});

describe("GET /token/:token/symbol", () => {
  it("returns decoded short-string symbol", async () => {
    callContract.mockResolvedValue(["0x55534443"]);

    const res = await request(makeApp()).get("/api/v1/token/0xabc/symbol").expect(200);

    expect(res.body).toEqual({ token: "0xabc", symbol: "USDC" });
    expect(callContract).toHaveBeenCalledWith({
      contractAddress: "0xabc",
      entrypoint: "symbol",
      calldata: [],
    });
  });

  it("falls back to raw value when decode fails", async () => {
    callContract.mockResolvedValue(["raw-symbol"]);

    const res = await request(makeApp()).get("/api/v1/token/0xabc/symbol").expect(200);

    expect(res.body).toEqual({ token: "0xabc", symbol: "raw-symbol" });
  });

  it("returns 500 when result is empty", async () => {
    callContract.mockResolvedValue([]);

    const res = await request(makeApp()).get("/api/v1/token/0xabc/symbol").expect(500);

    expect(res.body.error).toContain("Unexpected symbol result");
  });
});

// ---------------------------------------------------------------------------
// Escrow balance
// ---------------------------------------------------------------------------
describe("GET /escrow/:address/balance/:agreement_id", () => {
  it("returns balance on success", async () => {
    mockEscrow.get_agreement_balance.mockResolvedValue({ low: 5000n, high: 0n });

    const res = await request(makeApp()).get("/api/v1/escrow/0x1234/balance/1").expect(200);

    expect(res.body).toEqual({
      escrow: "0x1234",
      agreement_id: "1",
      balance: "5000",
    });
    expect(mockEscrow.get_agreement_balance).toHaveBeenCalledWith(1n);
  });

  it("returns 500 on RPC failure", async () => {
    mockEscrow.get_agreement_balance.mockRejectedValue(new Error("RPC down"));

    const res = await request(makeApp()).get("/api/v1/escrow/0x1234/balance/1").expect(500);

    expect(res.body.error).toBe("RPC down");
  });
});

// ---------------------------------------------------------------------------
// Escrow summary
// ---------------------------------------------------------------------------
describe("GET /escrow/:address/summary/:agreement_id", () => {
  it("returns summary with formatted addresses", async () => {
    mockEscrow.get_token.mockResolvedValue(12345n);
    mockEscrow.get_agreement_balance.mockResolvedValue({ low: 2000000n, high: 0n });
    mockEscrow.get_agreement_employer.mockResolvedValue("0xabcd");

    const res = await request(makeApp()).get("/api/v1/escrow/0x1234/summary/1").expect(200);

    expect(res.body).toEqual({
      escrow: "0x1234",
      agreement_id: "1",
      employer: "0xabcd",
      token: "0x3039",
      balance: "2000000",
    });
  });

  it("returns 500 on RPC failure", async () => {
    mockEscrow.get_token.mockRejectedValue(new Error("Contract error"));

    const res = await request(makeApp()).get("/api/v1/escrow/0x1234/summary/1").expect(500);

    expect(res.body.error).toBe("Contract error");
  });
});

// ---------------------------------------------------------------------------
// Agreement summary
// ---------------------------------------------------------------------------
describe("GET /agreement/:address/summary/:agreement_id", () => {
  it("returns full agreement summary with all fields", async () => {
    mockAgreement.get_employer.mockResolvedValue(100n);
    mockAgreement.get_contributor.mockResolvedValue("0x200");
    mockAgreement.get_token.mockResolvedValue(300n);
    mockAgreement.get_escrow.mockResolvedValue(400n);
    mockAgreement.get_total_amount.mockResolvedValue({ low: 1000n, high: 0n });
    mockAgreement.get_paid_amount.mockResolvedValue({ low: 500n, high: 0n });
    mockAgreement.get_status.mockResolvedValue(1n);
    mockAgreement.get_agreement_mode.mockResolvedValue(0n);
    mockAgreement.get_dispute_status.mockResolvedValue(2n);

    const res = await request(makeApp()).get("/api/v1/agreement/0x5678/summary/2").expect(200);

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

  it("returns 500 on RPC failure", async () => {
    mockAgreement.get_employer.mockRejectedValue(new Error("Timeout"));

    const res = await request(makeApp()).get("/api/v1/agreement/0x5678/summary/2").expect(500);

    expect(res.body.error).toBe("Timeout");
  });
});

// ---------------------------------------------------------------------------
// Cursor-based record reads
// ---------------------------------------------------------------------------
describe("GET /records/cursor/:address", () => {
  it("returns records in deterministic order without a cursor", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ limit: 2 })
      .expect(200);

    expect(res.body).toEqual({
      address: "0xabc",
      records: [
        { id: 5, value: "record-5" },
        { id: 4, value: "record-4" },
      ],
      nextCursor: "4",
      order: "desc",
    });
  });

  it("applies the cursor consistently to ordered records", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "4", order: "desc", limit: 2 })
      .expect(200);

    expect(res.body.records).toEqual([
      { id: 3, value: "record-3" },
      { id: 2, value: "record-2" },
    ]);
    expect(res.body.nextCursor).toBe("2");
    expect(res.body.order).toBe("desc");
  });

  it("returns an empty result when the cursor is beyond the available records", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "999", limit: 2 })
      .expect(200);

    expect(res.body).toEqual({
      address: "0xabc",
      records: [],
      nextCursor: null,
      order: "desc",
    });
  });

  it("rejects an invalid cursor", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "not-a-number", limit: 2 })
      .expect(400);

    expect(res.body.error).toMatch(/cursor/i);
  });

  it("returns 400 for a cursor with leading zeros", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "007", limit: 2 })
      .expect(400);

    expect(res.body.error).toMatch(/cursor/i);
  });

  it("returns 400 for a zero cursor", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "0", limit: 2 })
      .expect(400);

    expect(res.body.error).toMatch(/cursor/i);
  });

  it("returns 400 for a negative cursor", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "-5", limit: 2 })
      .expect(400);

    expect(res.body.error).toMatch(/cursor/i);
  });

  it("returns 400 for a float cursor", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "3.14", limit: 2 })
      .expect(400);

    expect(res.body.error).toMatch(/cursor/i);
  });

  it("returns 400 for a whitespace-padded cursor", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: " 4 ", limit: 2 })
      .expect(400);

    expect(res.body.error).toMatch(/cursor/i);
  });

  it("returns 400 for a SQL-injection-style cursor", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "1; DROP TABLE agreements;--", limit: 2 })
      .expect(400);

    expect(res.body.error).toMatch(/cursor/i);
  });

  it("returns 400 for an empty-string cursor", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "", limit: 2 })
      .expect(400);

    expect(res.body.error).toMatch(/cursor/i);
  });

  it("returns 400 for a hex cursor", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "0xff", limit: 2 })
      .expect(400);

    expect(res.body.error).toMatch(/cursor/i);
  });

  it("guarantees idempotency on repeated requests with identical parameters", async () => {
    const app = makeApp();

    const req1 = await request(app)
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .set("Idempotency-Key", "req-test-key-123")
      .query({ cursor: "4", order: "desc", limit: 2 })
      .expect(200);

    const req2 = await request(app)
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .set("Idempotency-Key", "req-test-key-123")
      .query({ cursor: "4", order: "desc", limit: 2 })
      .expect(200);

    expect(req1.body).toEqual(req2.body);
    expect(req1.body).toEqual({
      address: "0xabc",
      records: [
        { id: 3, value: "record-3" },
        { id: 2, value: "record-2" },
      ],
      nextCursor: "2",
      order: "desc",
    });
  });

  it("supports order=asc pagination and boundary conditions", async () => {
    const app = makeApp();

    const page1 = await request(app)
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ order: "asc", limit: 2 })
      .expect(200);

    expect(page1.body).toEqual({
      address: "0xabc",
      records: [
        { id: 1, value: "record-1" },
        { id: 2, value: "record-2" },
      ],
      nextCursor: "2",
      order: "asc",
    });

    const page2 = await request(app)
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: page1.body.nextCursor, order: "asc", limit: 2 })
      .expect(200);

    expect(page2.body).toEqual({
      address: "0xabc",
      records: [
        { id: 3, value: "record-3" },
        { id: 4, value: "record-4" },
      ],
      nextCursor: "4",
      order: "asc",
    });

    const pageAtMax = await request(app)
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "5", order: "asc", limit: 2 })
      .expect(200);

    expect(pageAtMax.body).toEqual({
      address: "0xabc",
      records: [],
      nextCursor: null,
      order: "asc",
    });
  });

  it("returns empty records when cursor is at or below minimum ID in desc order", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ cursor: "1", order: "desc", limit: 2 })
      .expect(200);

    expect(res.body).toEqual({
      address: "0xabc",
      records: [],
      nextCursor: null,
      order: "desc",
    });
  });

  it("supports full pagination traversal from first to last page", async () => {
    const app = makeApp();
    const allRecords: Array<{ id: number; value: string }> = [];
    let currentCursor: string | null = null;

    do {
      const queryParams: Record<string, string | number> = { limit: 2, order: "desc" };
      if (currentCursor) {
        queryParams.cursor = currentCursor;
      }

      const res = await request(app)
        .get("/api/v1/records/cursor/0xabc")
        .set("Authorization", "Bearer 0xabc")
        .query(queryParams)
        .expect(200);

      allRecords.push(...res.body.records);
      currentCursor = res.body.nextCursor;
    } while (currentCursor !== null);

    expect(allRecords).toEqual([
      { id: 5, value: "record-5" },
      { id: 4, value: "record-4" },
      { id: 3, value: "record-3" },
      { id: 2, value: "record-2" },
      { id: 1, value: "record-1" },
    ]);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .expect(401);

    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when Bearer token does not match requested address", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xother")
      .expect(403);

    expect(res.body).toEqual({ error: "Forbidden: privilege check failed" });
  });

  it("returns 400 for an invalid order parameter", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ order: "invalid" })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 400 for an out-of-range limit parameter", async () => {
    const res = await request(makeApp())
      .get("/api/v1/records/cursor/0xabc")
      .set("Authorization", "Bearer 0xabc")
      .query({ limit: 0 })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------
describe("CursorPaginationSchema", () => {
  it("applies default limit when none provided", () => {
    const result = CursorPaginationSchema.parse({});
    expect(result.limit).toBe(50);
    expect(result.cursor).toBeUndefined();
  });

  it("accepts custom cursor and limit", () => {
    const result = CursorPaginationSchema.parse({ cursor: "abc", limit: 10 });
    expect(result.limit).toBe(10);
    expect(result.cursor).toBe("abc");
  });

  it("coerces limit from string to number", () => {
    const result = CursorPaginationSchema.parse({ limit: "25" });
    expect(result.limit).toBe(25);
  });

  it("rejects limit below minimum (0)", () => {
    expect(() => CursorPaginationSchema.parse({ limit: 0 })).toThrow();
  });

  it("rejects limit above maximum (101)", () => {
    expect(() => CursorPaginationSchema.parse({ limit: 101 })).toThrow();
  });

  it("rejects non-integer limit", () => {
    expect(() => CursorPaginationSchema.parse({ limit: 1.5 })).toThrow();
  });
});

describe("BatchReadSchema", () => {
  it("accepts valid array of bigint strings", () => {
    const result = BatchReadSchema.parse({ ids: ["1", "2", "3"] });
    expect(result.ids).toEqual([1n, 2n, 3n]);
  });

  it("rejects empty array", () => {
    expect(() => BatchReadSchema.parse({ ids: [] })).toThrow();
  });

  it("rejects array exceeding max size (50)", () => {
    const large = Array.from({ length: 51 }, (_, i) => BigInt(i + 1));
    expect(() => BatchReadSchema.parse({ ids: large })).toThrow();
  });

  it("rejects zero or negative IDs", () => {
    expect(() => BatchReadSchema.parse({ ids: ["0"] })).toThrow();
    expect(() => BatchReadSchema.parse({ ids: ["-1"] })).toThrow();
  });

  it("accepts exactly 50 items", () => {
    const max = Array.from({ length: 50 }, (_, i) => BigInt(i + 1));
    const result = BatchReadSchema.parse({ ids: max });
    expect(result.ids).toHaveLength(50);
  });
});

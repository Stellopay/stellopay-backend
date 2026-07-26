/**
 * Tests for src/routes/read.ts.
 *
 * Coverage map (issue #read-contract-reliability-15):
 *
 *   1. Unit tests for the `withReadRetry` helper — covers the success
 *      path, transient retry succeeds, non-retriable error fails fast,
 *      AbortSignal cancellation in mid-backoff, and short-circuit modes
 *      (`enabled: false`, `maxAttempts: 1`).
 *
 *   2. Schema contracts — `CursorPaginationSchema` and `BatchReadSchema`
 *      (exported but not yet wired into routes; see docs/routes/read.md).
 *
 *   3. HTTP routes:
 *      - success path on first attempt,
 *      - retry recovery after transient provider failure,
 *      - exhaustion after persistent provider failure,
 *      - **boundary**: validation failure for malformed `agreement_id`
 *        returns 400, malformed address returns 400,
 *      - **boundary**: deterministic ("non-retriable") provider failure
 *        fails fast with no retries,
 *      - telemetry carries the `retries` count for both success / error
 *        paths (folded into the final entry — see docs).
 *
 * Mock strategy
 * -------------
 * - `vi.mock('../starknet/client.js')` provides a `provider.callContract`
 *   and contract-mock factories that the routes consume through
 *   `callContractResult` and `parallelWithRetry`.
 * - `Math.random` is monkey-patched in a single helper so backoff jitter
 *   is deterministic and tests stay fast.
 * - `process.env.READ_RETRY_BASE_DELAY_MS = "1"` is set in `beforeAll` so
 *   retry sleeps finish in <1ms per attempt.
 */
import { ZodError } from "zod";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import {
  readRouter,
  CursorPaginationSchema,
  BatchReadSchema,
  withReadRetry,
  type ReadRetryAttemptInfo,
} from "./read.js";

// -----------------------------------------------------------------------
// Test env — set BEFORE the read.js import is evaluated, so config.ts,
// which parses process.env at module load, sees our overrides. vi.hoisted
// runs before the module graph (including vi.mock factories) is loaded.
// -----------------------------------------------------------------------

vi.hoisted(() => {
  process.env.READ_RETRY_ENABLED = "true";
  process.env.READ_RETRY_MAX_ATTEMPTS = "3";
  process.env.READ_RETRY_BASE_DELAY_MS = "1";
  process.env.READ_RETRY_MAX_DELAY_MS = "5";
});

afterAll(() => {
  delete process.env.READ_RETRY_ENABLED;
  delete process.env.READ_RETRY_MAX_ATTEMPTS;
  delete process.env.READ_RETRY_BASE_DELAY_MS;
  delete process.env.READ_RETRY_MAX_DELAY_MS;
});

// Make jitter deterministic so backoff doesn't add up to ~100ms across
// many retry cases in the suite.
const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

// -----------------------------------------------------------------------
// Starknet client mocks (kept narrow — only what read.ts touches).
// -----------------------------------------------------------------------

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

const providerCallContract = vi.fn();

vi.mock("../starknet/client.js", () => ({
  provider: {
    callContract: (...args: unknown[]) => providerCallContract(...args),
  },
  escrowContract: vi.fn(() => mockEscrow),
  agreementContract: vi.fn(() => mockAgreement),
}));

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/api/v1", readRouter);
  // Mirror src/index.ts: Zod parse failures are 400 with the structured
  // issue list, everything else falls through to 500.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: "Validation failed",
          details: err.issues,
        });
        return;
      }
      res.status(500).json({ error: (err as Error)?.message ?? "Internal error" });
    },
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-attach Math.random after clearAllMocks.
  randomSpy.mockReturnValue(0.5);
  providerCallContract.mockReset();
  for (const fn of Object.values(mockEscrow)) fn.mockReset();
  for (const fn of Object.values(mockAgreement)) fn.mockReset();
});

// =======================================================================
// 1. withReadRetry unit tests
// =======================================================================

describe("withReadRetry", () => {
  it("returns the value on first try (retries: 0)", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    const onRetry = vi.fn();

    const result = await withReadRetry(op, {}, onRetry);

    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries transient errors and returns the eventual success", async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts++;
      if (attempts < 2) throw new Error("ECONNRESET — transient blip");
      return "ok";
    });
    const onRetry = vi.fn();

    const result = await withReadRetry(op, { baseDelayMs: 1, maxDelayMs: 5 }, onRetry);

    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    const info = onRetry.mock.calls[0][0] as ReadRetryAttemptInfo;
    expect(info.attempt).toBe(1);
    expect(info.maxAttempts).toBe(3);
    expect(info.retriesSoFar).toBe(1);
  });

  it("retries up to maxAttempts and then rethrows the last error", async () => {
    const op = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    });
    const onRetry = vi.fn();

    await expect(
      withReadRetry(op, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }, onRetry),
    ).rejects.toThrow("ETIMEDOUT");

    expect(op).toHaveBeenCalledTimes(3);
    // onRetry fires BETWEEN attempts → 2 signals for 3 attempts
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0].retriesSoFar).toBe(1);
    expect(onRetry.mock.calls[1][0].retriesSoFar).toBe(2);
  });

  it("fails fast on non-retriable errors (no retry, no onRetry fire)", async () => {
    const op = vi.fn(async () => {
      throw new Error("Unexpected balance_of result: [1,2]");
    });
    const onRetry = vi.fn();

    await expect(withReadRetry(op, { maxAttempts: 3 }, onRetry)).rejects.toThrow(
      "Unexpected balance_of result",
    );

    expect(op).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("treats 'Contract not found' as non-retriable", async () => {
    const op = vi.fn(async () => {
      throw new Error("Contract not found at 0xdeadbeef");
    });
    await expect(withReadRetry(op, { maxAttempts: 3 })).rejects.toThrow("Contract not found");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("treats Starknet-node 5xx-like messages as retriable", async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error("service unavailable, try again later");
      return "ok";
    });
    const result = await withReadRetry(op, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("aborts during backoff sleep when signal triggers", async () => {
    const controller = new AbortController();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce("ok");

    const promise = withReadRetry(
      op,
      { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 50, signal: controller.signal },
    );

    // Let the first attempt fail; we're now in the backoff sleep.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("aborts before starting the next attempt when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const op = vi.fn().mockResolvedValue("ok");

    await expect(
      withReadRetry(op, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(op).not.toHaveBeenCalled();
  });

  it("short-circuits retry when maxAttempts is 1 (no retries)", async () => {
    const op = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(withReadRetry(op, { maxAttempts: 1 })).rejects.toThrow("ECONNRESET");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("short-circuits retry when enabled is false", async () => {
    const op = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(withReadRetry(op, { enabled: false, maxAttempts: 3 })).rejects.toThrow(
      "ECONNRESET",
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("caps backoff at maxDelayMs even with high attempt counts", async () => {
    // Observable behaviour: with baseDelay=1000 and maxDelay=5, a long retry
    // chain should finish well under (attempts * 1000ms); each sleep is
    // clamped by the cap.
    const op = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const start = Date.now();
    await expect(
      withReadRetry(op, {
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 5,
        signal: undefined,
      }),
    ).rejects.toThrow("ECONNRESET");
    const elapsed = Date.now() - start;
    // 4 sleeps × ~2.5ms (Math.random=0.5 → jitter=1.0; min(5, raw*1.0))
    expect(elapsed).toBeLessThan(250);
    expect(op).toHaveBeenCalledTimes(5);
  });
});

// =======================================================================
// 2. Exported schema contracts
// =======================================================================

describe("CursorPaginationSchema", () => {
  it("applies defaults when no query given", () => {
    const out = CursorPaginationSchema.parse({});
    expect(out.limit).toBe(50);
    expect(out.cursor).toBeUndefined();
  });

  it("accepts custom cursor and limit", () => {
    const out = CursorPaginationSchema.parse({ cursor: "abc", limit: 10 });
    expect(out.cursor).toBe("abc");
    expect(out.limit).toBe(10);
  });

  it("rejects limit < 1 (boundary)", () => {
    expect(() => CursorPaginationSchema.parse({ limit: 0 })).toThrow();
  });

  it("rejects limit > 100 (boundary)", () => {
    expect(() => CursorPaginationSchema.parse({ limit: 101 })).toThrow();
  });
});

describe("BatchReadSchema", () => {
  it("accepts a valid batch", () => {
    const out = BatchReadSchema.parse({ ids: ["1", "2"] });
    expect(out.ids).toEqual([1n, 2n]);
  });

  it("rejects an empty ids array (boundary)", () => {
    expect(() => BatchReadSchema.parse({ ids: [] })).toThrow();
  });

  it("rejects > 50 ids (boundary)", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => BigInt(i + 1));
    expect(() => BatchReadSchema.parse({ ids: tooMany })).toThrow();
  });

  it("rejects a non-positive id", () => {
    expect(() => BatchReadSchema.parse({ ids: [0] })).toThrow();
    expect(() => BatchReadSchema.parse({ ids: [-1n] })).toThrow();
  });
});

// =======================================================================
// 3. HTTP routes — token reads
// =======================================================================

describe("GET /token/:token/balance/:owner", () => {
  it("returns the formatted balance on first try (success path)", async () => {
    providerCallContract.mockResolvedValue(["2000000", "0"]);
    const res = await request(makeApp())
      .get("/api/v1/token/0xtoken/balance/0xowner")
      .expect(200);

    expect(res.body).toEqual({ token: "0xtoken", owner: "0xowner", balance: "2000000" });
    expect(providerCallContract).toHaveBeenCalledTimes(1);
  });

  it("recovers from a transient provider error and still returns the balance", async () => {
    providerCallContract
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(["42", "0"]);

    const res = await request(makeApp())
      .get("/api/v1/token/0xtoken/balance/0xowner")
      .expect(200);

    expect(res.body.balance).toBe("42");
    expect(providerCallContract).toHaveBeenCalledTimes(3);
  });

  it("returns 500 after retry exhaustion", async () => {
    providerCallContract.mockRejectedValue(new Error("ECONNRESET"));
    const res = await request(makeApp()).get("/api/v1/token/0xtoken/balance/0xowner");
    expect(res.status).toBe(500);
    expect(providerCallContract).toHaveBeenCalledTimes(3);
  });

  it("fails fast (no retry) on non-retriable 'Unexpected balance_of result'", async () => {
    // provider returns malformed shape → callContractResult throws
    providerCallContract.mockResolvedValue([]); // empty array → asU256FromResult returns null
    const res = await request(makeApp()).get("/api/v1/token/0xtoken/balance/0xowner");
    expect(res.status).toBe(500);
    expect(providerCallContract).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for an unmatched route (empty owner segment)", async () => {
    const res = await request(makeApp()).get("/api/v1/token/0xtoken/balance/");
    expect(res.status).toBe(404);
  });
});

describe("GET /token/:token/decimals", () => {
  it("returns the parsed decimals", async () => {
    providerCallContract.mockResolvedValue(["6"]); // 6n
    const res = await request(makeApp()).get("/api/v1/token/0xtoken/decimals").expect(200);
    expect(res.body).toEqual({ token: "0xtoken", decimals: 6 });
  });

  it("fails fast on malformed decimals array", async () => {
    providerCallContract.mockResolvedValue([]);
    const res = await request(makeApp()).get("/api/v1/token/0xtoken/decimals");
    expect(res.status).toBe(500);
    expect(providerCallContract).toHaveBeenCalledTimes(1);
  });
});

describe("GET /token/:token/symbol", () => {
  it("decodes a short-string symbol", async () => {
    providerCallContract.mockResolvedValue(["0x55534443"]); // "USDC"
    const res = await request(makeApp()).get("/api/v1/token/0xtoken/symbol").expect(200);
    expect(res.body.symbol).toBe("USDC");
  });

  it("falls back to raw value when symbol isn't a short string", async () => {
    providerCallContract.mockResolvedValue(["not-a-felt-short"]);
    const res = await request(makeApp()).get("/api/v1/token/0xtoken/symbol").expect(200);
    expect(res.body.symbol).toBe("not-a-felt-short");
  });
});

// =======================================================================
// 4. HTTP routes — escrow balance
// =======================================================================

describe("GET /escrow/:address/balance/:agreement_id", () => {
  it("returns the formatted u256 balance", async () => {
    mockEscrow.get_agreement_balance.mockResolvedValue({ low: 1000000n, high: 0n });
    const res = await request(makeApp())
      .get("/api/v1/escrow/0xescrow/balance/1")
      .expect(200);
    expect(res.body).toMatchObject({ escrow: "0xescrow", agreement_id: "1", balance: "1000000" });
  });

  it("returns 500 when the contract call retries all the way through", async () => {
    mockEscrow.get_agreement_balance.mockRejectedValue(new Error("ECONNRESET"));
    const res = await request(makeApp()).get("/api/v1/escrow/0xescrow/balance/1");
    expect(res.status).toBe(500);
    expect(mockEscrow.get_agreement_balance).toHaveBeenCalledTimes(3);
  });

  it("recovers from a transient provider error", async () => {
    mockEscrow.get_agreement_balance
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({ low: 7n, high: 0n });
    const res = await request(makeApp())
      .get("/api/v1/escrow/0xescrow/balance/1")
      .expect(200);
    expect(res.body.balance).toBe("7");
    expect(mockEscrow.get_agreement_balance).toHaveBeenCalledTimes(2);
  });

  it("returns 400 for a malformed agreement_id (boundary)", async () => {
    const res = await request(makeApp()).get("/api/v1/escrow/0xescrow/balance/-1");
    expect(res.status).toBe(400);
    expect(mockEscrow.get_agreement_balance).not.toHaveBeenCalled();
  });

  it("returns 400 for agreement_id of zero (boundary)", async () => {
    const res = await request(makeApp()).get("/api/v1/escrow/0xescrow/balance/0");
    expect(res.status).toBe(400);
    expect(mockEscrow.get_agreement_balance).not.toHaveBeenCalled();
  });
});

// =======================================================================
// 5. HTTP routes — summaries
// =======================================================================

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

  it("recovers when one of the parallel calls transiently fails", async () => {
    // Balance fails twice (retriable), then succeeds; others succeed cleanly.
    mockEscrow.get_token.mockResolvedValue(12345n);
    mockEscrow.get_agreement_employer.mockResolvedValue("0xabcd");
    mockEscrow.get_agreement_balance
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({ low: 99n, high: 0n });

    const res = await request(makeApp())
      .get("/api/v1/escrow/0x1234/summary/1")
      .expect(200);

    expect(res.body.balance).toBe("99");
    // Total balance calls = 1 (first failing Promise.all partner) + 2 retries = 3
    expect(mockEscrow.get_agreement_balance).toHaveBeenCalledTimes(3);
    expect(mockEscrow.get_token).toHaveBeenCalledTimes(1);
    expect(mockEscrow.get_agreement_employer).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when one parallel call exhausts retries", async () => {
    mockEscrow.get_token.mockResolvedValue(12345n);
    mockEscrow.get_agreement_employer.mockResolvedValue("0xabcd");
    mockEscrow.get_agreement_balance.mockRejectedValue(new Error("ECONNRESET"));

    const res = await request(makeApp()).get("/api/v1/escrow/0x1234/summary/1");
    expect(res.status).toBe(500);
    expect(mockEscrow.get_agreement_balance).toHaveBeenCalledTimes(3);
  });

  it("returns 400 for a malformed agreement_id (boundary)", async () => {
    const res = await request(makeApp()).get("/api/v1/escrow/0x1234/summary/not-a-bn");
    expect(res.status).toBe(400);
    expect(mockEscrow.get_token).not.toHaveBeenCalled();
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

  it("recovers when one of the nine parallel reads transiently fails", async () => {
    mockAgreement.get_employer.mockResolvedValue(100n);
    mockAgreement.get_contributor.mockResolvedValue("0x200");
    mockAgreement.get_token.mockResolvedValue(300n);
    mockAgreement.get_escrow.mockResolvedValue(400n);
    mockAgreement.get_total_amount.mockResolvedValue({ low: 1000n, high: 0n });
    mockAgreement.get_paid_amount
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({ low: 500n, high: 0n });
    mockAgreement.get_status.mockResolvedValue(1n);
    mockAgreement.get_agreement_mode.mockResolvedValue(0n);
    mockAgreement.get_dispute_status.mockResolvedValue(2n);

    const res = await request(makeApp())
      .get("/api/v1/agreement/0x5678/summary/2")
      .expect(200);

    expect(res.body.paid_amount).toBe("500");
    expect(mockAgreement.get_paid_amount).toHaveBeenCalledTimes(2);
  });

  it("returns 500 when a parallel call exhausts retries", async () => {
    mockAgreement.get_employer.mockResolvedValue(100n);
    mockAgreement.get_contributor.mockResolvedValue("0x200");
    mockAgreement.get_token.mockResolvedValue(300n);
    mockAgreement.get_escrow.mockResolvedValue(400n);
    mockAgreement.get_total_amount.mockRejectedValue(new Error("ECONNRESET"));
    mockAgreement.get_paid_amount.mockResolvedValue({ low: 500n, high: 0n });
    mockAgreement.get_status.mockResolvedValue(1n);
    mockAgreement.get_agreement_mode.mockResolvedValue(0n);
    mockAgreement.get_dispute_status.mockResolvedValue(2n);

    const res = await request(makeApp()).get("/api/v1/agreement/0x5678/summary/2");
    expect(res.status).toBe(500);
    expect(mockAgreement.get_total_amount).toHaveBeenCalledTimes(3);
  });

  it("returns 400 for a malformed agreement_id (boundary)", async () => {
    const res = await request(makeApp()).get("/api/v1/agreement/0x5678/summary/abc");
    expect(res.status).toBe(400);
    expect(mockAgreement.get_employer).not.toHaveBeenCalled();
  });
});

// =======================================================================
// 6. Telemetry retry-count integration
// =======================================================================

// The helper: pull the first JSON-shaped log entry off the spied console
// method so the test stays format-agnostic. `config.ts` defaults
// `LOG_FORMAT` to "json", and `logReadTelemetry` calls `console.info`/
// `console.error` with `JSON.stringify(...)` in that branch.
function findReadTelemetryEntry(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const stringified = spy.mock.calls
    .map(([arg]) => arg)
    .find((arg): arg is string => typeof arg === "string");
  if (!stringified) throw new Error("no string log argument emitted");
  return JSON.parse(stringified) as Record<string, unknown>;
}

describe("telemetry – retry count propagation", () => {
  it("emits retries=0 on first-try success", async () => {
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    providerCallContract.mockResolvedValue(["1234", "0"]);

    await request(makeApp()).get("/api/v1/token/0xtoken/balance/0xowner").expect(200);

    const entry = findReadTelemetryEntry(consoleInfoSpy);
    expect(entry.operation).toBe("erc20_balance_of");
    expect(entry.status).toBe("success");
    expect(entry.retries).toBe(0);
    consoleInfoSpy.mockRestore();
  });

  it("emits retries>0 after transient recovery (success-with-retries)", async () => {
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    providerCallContract
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(["42", "0"]);

    await request(makeApp()).get("/api/v1/token/0xtoken/balance/0xowner").expect(200);

    const entry = findReadTelemetryEntry(consoleInfoSpy);
    expect(entry.operation).toBe("erc20_balance_of");
    expect(entry.status).toBe("success");
    expect(entry.retries).toBe(1);
    consoleInfoSpy.mockRestore();
  });

  it("emits retries=2 in error log after exhaustion", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    providerCallContract.mockRejectedValue(new Error("ECONNRESET"));

    await request(makeApp()).get("/api/v1/token/0xtoken/balance/0xowner").expect(500);

    const entry = findReadTelemetryEntry(consoleErrorSpy);
    expect(entry.operation).toBe("erc20_balance_of");
    expect(entry.status).toBe("error");
    expect(entry.retries).toBe(2);
    expect(entry.error).toBe("ECONNRESET");
    consoleErrorSpy.mockRestore();
  });

  it("emits retries=0 on a non-retriable fail-fast path", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Malformed array triggers "Unexpected balance_of result" — non-retriable.
    providerCallContract.mockResolvedValue([]);

    await request(makeApp()).get("/api/v1/token/0xtoken/balance/0xowner").expect(500);

    const entry = findReadTelemetryEntry(consoleErrorSpy);
    expect(entry.status).toBe("error");
    // onRetry never fires for non-retriable errors — the field stays at
    // the closure's initial 0. JSON.stringify omits a literal `undefined`
    // but keeps numeric 0, which is the desired "no retries fired" signal
    // distinguishable from the success path only by `status`.
    expect(entry.retries).toBe(0);
    expect(entry.error).toContain("Unexpected balance_of result");
    consoleErrorSpy.mockRestore();
  });
});

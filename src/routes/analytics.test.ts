import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const { dbMock, schemaMock, queryState } = vi.hoisted(() => {
  type TableName = "payments" | "escrowEvents" | "agreementEvents";

  const makeTable = (name: string) =>
    new Proxy(
      { __name: name },
      {
        get(_target, prop) {
          if (prop === "__name") return name;
          return { table: name, column: String(prop) };
        },
      },
    ) as { __name: string } & Record<string, unknown>;

  const schema = {
    payments: makeTable("payments"),
    escrowEvents: makeTable("escrowEvents"),
    agreementEvents: makeTable("agreementEvents"),
    agreements: makeTable("agreements"),
  };

  const state = {
    rows: {
      payments: [] as Array<Record<string, unknown>>,
      escrowEvents: [] as Array<Record<string, unknown>>,
      agreementEvents: [] as Array<Record<string, unknown>>,
    },
    eqValues: [] as string[],
    gteDates: [] as Date[],
    lteDates: [] as Date[],
  };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: { __name: TableName }) => {
        const rows = state.rows[table.__name] ?? [];
        return {
          where: vi.fn(() => Promise.resolve(rows)),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve(rows)),
          })),
        };
      }),
    })),
  };

  return { dbMock: db, schemaMock: schema, queryState: state };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_column: unknown, value: unknown) => {
    if (typeof value === "string") queryState.eqValues.push(value);
    return { type: "eq", value };
  }),
  and: vi.fn((...conditions: unknown[]) => ({ type: "and", conditions })),
  or: vi.fn((...conditions: unknown[]) => ({ type: "or", conditions })),
  gte: vi.fn((_column: unknown, value: Date) => {
    queryState.gteDates.push(value);
    return { type: "gte", value };
  }),
  lte: vi.fn((_column: unknown, value: Date) => {
    queryState.lteDates.push(value);
    return { type: "lte", value };
  }),
  sql: vi.fn(() => "sql-expr"),
}));

import { analyticsRouter, parseBigIntSafe, isValidMonth } from "./analytics.js";
import { normalizeStarknetAddress } from "../utils/address.js";
import { env } from "../config.js";

const USER = "0x0000000000000000000000000000000000000000000000000000000000000abc";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", analyticsRouter);
  app.use(
    (
      err: { status?: number; message?: string; issues?: unknown },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const isZod = err instanceof ZodError;
      res.status(isZod ? 400 : (err.status ?? 500)).json({
        error: isZod ? "Validation failed" : (err.message ?? "Internal error"),
        details: isZod ? err.issues : undefined,
      });
    },
  );
  return app;
}

function viewsFor(data: Array<{ month: string; views: number }>, month: string): number {
  const entry = data.find((d) => d.month === month);
  if (!entry) throw new Error(`month ${month} missing from chart data`);
  return entry.views;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInflightRollups();
  queryState.rows.payments = [];
  queryState.rows.escrowEvents = [];
  queryState.rows.agreementEvents = [];
  queryState.eqValues = [];
  queryState.gteDates = [];
  queryState.lteDates = [];
});

describe("analytics route", () => {
  it("validates and normalizes the address and returns twelve months of chart data", async () => {
    const address = normalizeStarknetAddress("abc");
    queryState.rows.payments = [{ month: 3, amount: "1000000", to: address }];
    queryState.rows.escrowEvents = [
      { month: 4, amount: "2000000", eventType: "Funded", employer: address },
      { month: 5, amount: "3000000", eventType: "Released", to: address },
    ];

    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);

    // March: +5 (received) - 2 (sent) = 3
    expect(viewsFor(res.body.data, "Mar")).toBe(3);
    // May: -8 (sent)
    expect(viewsFor(res.body.data, "May")).toBe(-8);
    // Net total: 3 - 8 = -5
    expect(res.body.total).toBe(-5);
  });
});

// ---------------------------------------------------------------------------
// Escrow event aggregation
// ---------------------------------------------------------------------------
describe("analytics escrow aggregation", () => {
  it("subtracts funding and adds releases/refunds", async () => {
    queryState.rows.escrowEvents = [
      { month: 3, amount: "2000000", eventType: "Funded" }, // -2
      { month: 3, amount: "1000000", eventType: "Released" }, // +1
      { month: 4, amount: "3000000", eventType: "Funded" }, // -3
      { month: 5, amount: "4000000", eventType: "Released" }, // +4
      { month: 6, amount: "2000000", eventType: "Refunded" }, // +2
    ];

    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);

    expect(viewsFor(res.body.data, "Mar")).toBe(-1); // -2 + 1
    expect(viewsFor(res.body.data, "Apr")).toBe(-3);
    expect(viewsFor(res.body.data, "May")).toBe(4);
    expect(viewsFor(res.body.data, "Jun")).toBe(2);
    expect(res.body.total).toBe(2); // -1 -3 + 4 + 2 = 2
  });
});

// ---------------------------------------------------------------------------
// Combined payments + escrow
// ---------------------------------------------------------------------------
describe("analytics combined aggregation", () => {
  it("nets payments and escrow events together", async () => {
    queryState.rows.payments = [
      { month: 3, amount: "5000000", from: "0xother", to: USER }, // +5
      { month: 9, amount: "10000000", from: USER, to: "0xother" }, // -10
    ];
    queryState.rows.escrowEvents = [
      { month: 3, amount: "2000000", eventType: "Funded" }, // -2
      { month: 3, amount: "1000000", eventType: "Released" }, // +1
      { month: 5, amount: "4000000", eventType: "Released" }, // +4
      { month: 6, amount: "2000000", eventType: "Refunded" }, // +2
    ];

    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);

    // March: +5 (payment) -2 (funded) +1 (released) = 4
    expect(viewsFor(res.body.data, "Mar")).toBe(4);
    // May: +4 (released)
    expect(viewsFor(res.body.data, "May")).toBe(4);
    // June: +2 (refunded)
    expect(viewsFor(res.body.data, "Jun")).toBe(2);
    // Sept: -10 (sent)
    expect(viewsFor(res.body.data, "Sept")).toBe(-10);
    // Total: 4 + 4 + 2 - 10 = 0
    expect(res.body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Agreement creation activity proxy
// ---------------------------------------------------------------------------
describe("analytics agreement creation proxy", () => {
  it("adds count × 1000 base units only when no payment/escrow data exists for that month", async () => {
    queryState.rows.agreementEvents = [
      { month: 1, agreementId: "1" },
      { month: 1, agreementId: "2" },
      { month: 1, agreementId: "3" },
      { month: 3, agreementId: "4" }, // March has no payment/escrow → proxy applies
    ];
    queryState.rows.payments = [
      { month: 3, amount: "5000000", from: "0xother", to: USER }, // March has real data
    ];

    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);

    // Jan: 3 agreements × 1000 = 3000 base units → 0.003 display
    expect(viewsFor(res.body.data, "Jan")).toBe(0.003);
    // Mar: real payment data (+5) — agreement proxy NOT applied
    expect(viewsFor(res.body.data, "Mar")).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Zero-fill and response shape
// ---------------------------------------------------------------------------
describe("analytics response shape", () => {
  it("returns twelve months and zero total when there is no activity", async () => {
    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);

    expect(res.body.data).toHaveLength(12);
    expect(res.body.data.map((d: { month: string }) => d.month)).toEqual([
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sept",
      "Oct",
      "Nov",
      "Dec",
    ]);
    for (const entry of res.body.data) {
      expect(entry.views).toBe(0);
    }
    expect(res.body.total).toBe(0);
    expect(res.body.year).toBe(2026);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe("analytics validation", () => {
  it("validates and normalizes the address", async () => {
    const res = await request(makeApp()).get(`/api/v1/analytics/abc?year=2026`).expect(200);
    expect(res.body.year).toBe(2026);
    expect(queryState.eqValues).toContain(normalizeStarknetAddress("abc"));
  });

  it("defaults to the current year", async () => {
    const res = await request(makeApp()).get(`/api/v1/analytics/abc`).expect(200);
    expect(res.body.year).toBe(new Date().getFullYear());
  });

  it("rejects a malformed address with 400", async () => {
    const res = await request(makeApp()).get("/api/v1/analytics/not-an-address").expect(400);
    expect(res.body.error).toBe("Validation failed");
    expect(queryState.eqValues).toHaveLength(0);
  });

  it("computes net payments correctly and ignores agreements when financial activity exists", async () => {
    const address = normalizeStarknetAddress("abc");
    // month 1: received 5, sent 2 (net 3)
    queryState.rows.payments = [
      { month: 1, amount: "5000000", to: address, from: "someone" },
      { month: 1, amount: "2000000", from: address, to: "someone" },
    ];
    // month 2: funded 4 (net -4), released 3 (net +3), refunded 1 (net +1)
    queryState.rows.escrowEvents = [
      { month: 2, amount: "4000000", eventType: "Funded", employer: address, to: "someone" },
      { month: 2, amount: "3000000", eventType: "Released", employer: "someone", to: address },
      { month: 2, amount: "1000000", eventType: "Refunded", employer: address, to: "someone" },
    ];
    // month 3: 2 agreements, but should be ignored because there is financial activity
    queryState.rows.agreementEvents = [
      { month: 3, agreementId: "1" },
      { month: 3, agreementId: "2" },
    ];

    const res = await request(makeApp()).get("/api/v1/analytics/abc").expect(200);
    
    // month 1 should be 3.0
    expect(res.body.data[0].views).toBe(3);
    // month 2 should be -4 + 3 + 1 = 0
    expect(res.body.data[1].views).toBe(0);
    // month 3 should be 0 because agreement fallback is suppressed
    expect(res.body.data[2].views).toBe(0);
    // Total should be 3
    expect(res.body.total).toBe(3);
  });

  it("falls back to agreement counts when there is no financial activity", async () => {
    queryState.rows.payments = [];
    queryState.rows.escrowEvents = [];
    queryState.rows.agreementEvents = [
      { month: 1, agreementId: "1" },
      { month: 1, agreementId: "2" },
      { month: 2, agreementId: "3" },
    ];

    const res = await request(makeApp()).get("/api/v1/analytics/abc").expect(200);
    
    // month 1: 2 agreements * 1000 base units = 0.002
    expect(res.body.data[0].views).toBe(0.002);
    // month 2: 1 agreement * 1000 base units = 0.001
    expect(res.body.data[1].views).toBe(0.001);
    expect(res.body.total).toBe(0.003);
  });

  it("rejects a year below the supported range with 400", async () => {
    await request(makeApp()).get("/api/v1/analytics/abc?year=1999").expect(400);
  });

  it("rejects a year above 2100 with 400", async () => {
    await request(makeApp()).get(`/api/v1/analytics/abc?year=3000`).expect(400);
  });
});

// ---------------------------------------------------------------------------
// Idempotency: ETag + 304
// ---------------------------------------------------------------------------
describe("analytics idempotency — ETag", () => {
  it("returns an ETag header on success", async () => {
    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);
    expect(res.headers["etag"]).toBeDefined();
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it("returns 304 when If-None-Match matches the ETag", async () => {
    const first = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);
    const etag = first.headers["etag"];

    const second = await request(makeApp())
      .get(`/api/v1/analytics/${USER}?year=2026`)
      .set("If-None-Match", etag)
      .expect(304);

    // 304 responses must not carry a payload body.
    expect(second.body.data).toBeUndefined();
    expect(second.body.year).toBeUndefined();
  });

  it("returns 200 with new ETag when If-None-Match does not match", async () => {
    const res = await request(makeApp())
      .get(`/api/v1/analytics/${USER}?year=2026`)
      .set("If-None-Match", '"0000000000000000"')
      .expect(200);
    expect(res.headers["etag"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency: Cache-Control
// ---------------------------------------------------------------------------
describe("analytics idempotency — Cache-Control", () => {
  it("sets private, max-age=60 on success", async () => {
    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);
    expect(res.headers["cache-control"]).toBe("private, max-age=60");
  });
});

// ---------------------------------------------------------------------------
// Idempotency: concurrent dedup (409)
// ---------------------------------------------------------------------------
describe("analytics idempotency — dedup guard", () => {
  it("returns 409 when a duplicate request is in flight", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    // Override the DB to hold the first request open
    dbMock.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => firstPromise.then(() => [])),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => firstPromise.then(() => [])),
        })),
      })),
    }));

    // Fire the first request (will hang)
    const firstReq = request(makeApp())
      .get(`/api/v1/analytics/${USER}?year=2026`)
      .then((res) => res);

    // Wait a tick so the first request acquires the lock
    await new Promise((r) => setTimeout(r, 10));

    // Fire a duplicate — should get 409 immediately
    const secondRes = await request(makeApp())
      .get(`/api/v1/analytics/${USER}?year=2026`)
      .expect(409);

    expect(secondRes.body.error).toContain("Duplicate rollup in progress");

    // Release the first request
    resolveFirst!();
    const firstRes = await firstReq;
    expect(firstRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
describe("analytics telemetry", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalLogFormat: string;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    originalLogFormat = env.LOG_FORMAT;
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    env.LOG_FORMAT = originalLogFormat;
  });

  it("emits JSON success log with row_counts", async () => {
    env.LOG_FORMAT = "json";
    queryState.rows.payments = [{ month: 3, amount: "1000000", from: "0xother", to: USER }];

    await request(makeApp()).get(`/api/v1/analytics/abc?year=2026`).expect(200);

    const parsed = infoSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .find((l) => l?.operation === "analytics_monthly_rollup");

    expect(parsed).toBeDefined();
    expect(parsed.status).toBe("success");
    expect(parsed.row_counts.payments).toBe(1);
  });

  it("emits JSON error log on DB failure", async () => {
    env.LOG_FORMAT = "json";
    dbMock.select.mockImplementationOnce(() => {
      throw new Error("DB connection lost");
    });

    await request(makeApp()).get("/api/v1/analytics/abc?year=2026").expect(500);

    const parsed = errorSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .find((l) => l?.operation === "analytics_monthly_rollup");

    expect(parsed).toBeDefined();
    expect(parsed.status).toBe("error");
    expect(parsed.error).toBe("DB connection lost");
  });
});

// ---------------------------------------------------------------------------
// DB failure
// ---------------------------------------------------------------------------
describe("analytics DB failure", () => {
  it("surfaces a database failure through the error handler", async () => {
    dbMock.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.reject(new Error("db unavailable"))),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => Promise.reject(new Error("db unavailable"))),
        })),
      })),
    }));

    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(500);
    expect(res.body.error).toBe("db unavailable");
  });
});

describe("analytics helper unit tests & input hardening", () => {
  describe("parseBigIntSafe", () => {
    it("safely converts valid string, bigint, and number inputs", () => {
      expect(parseBigIntSafe("1000")).toBe(1000n);
      expect(parseBigIntSafe(500n)).toBe(500n);
      expect(parseBigIntSafe(250)).toBe(250n);
    });

    it("returns 0n for missing, empty, or malformed inputs without throwing", () => {
      expect(parseBigIntSafe(null)).toBe(0n);
      expect(parseBigIntSafe(undefined)).toBe(0n);
      expect(parseBigIntSafe("")).toBe(0n);
      expect(parseBigIntSafe("not-a-number")).toBe(0n);
      expect(parseBigIntSafe("12.34")).toBe(0n);
      expect(parseBigIntSafe(NaN)).toBe(0n);
    });
  });

  describe("isValidMonth", () => {
    it("returns true for valid months (1 to 12)", () => {
      expect(isValidMonth(1)).toBe(true);
      expect(isValidMonth(12)).toBe(true);
      expect(isValidMonth("6")).toBe(true);
    });

    it("returns false for out-of-bounds or non-integer months", () => {
      expect(isValidMonth(0)).toBe(false);
      expect(isValidMonth(13)).toBe(false);
      expect(isValidMonth(-1)).toBe(false);
      expect(isValidMonth("abc")).toBe(false);
    });
  });

  describe("boundary & robustness integration tests", () => {
    it("handles empty year parameter (?year=) by defaulting to current year", async () => {
      const res = await request(makeApp()).get("/api/v1/analytics/abc?year=").expect(200);
      expect(res.body.year).toBe(new Date().getFullYear());
    });

    it("rejects non-integer year with 400", async () => {
      await request(makeApp()).get("/api/v1/analytics/abc?year=2026.5").expect(400);
    });

    it("rejects non-numeric string year with 400", async () => {
      await request(makeApp()).get("/api/v1/analytics/abc?year=invalid").expect(400);
    });

    it("gracefully handles DB rows with unparseable amounts and invalid month numbers", async () => {
      const address = normalizeStarknetAddress("abc");
      queryState.rows.payments = [
        { month: 1, amount: "invalid-amount", to: address },
        { month: 99, amount: "5000000", to: address },
      ];
      queryState.rows.escrowEvents = [
        { month: 2, amount: null, eventType: "Released", to: address },
      ];

      const res = await request(makeApp()).get("/api/v1/analytics/abc").expect(200);
      expect(res.body.data).toHaveLength(12);
      expect(res.body.total).toBe(0);
    });
  });
});

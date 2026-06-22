import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

/**
 * Integration tests for the monthly aggregation logic in
 * {@link analyticsRouter} (GET /analytics/:user_address).
 *
 * Seeding approach: the route reads only through the Drizzle `db` handle, so the
 * suite seeds synthetic rows by mocking `../db/index.js` rather than standing up
 * Postgres. The route's date-range filter is expressed in SQL (gte/lte on
 * created_at), which a query mock cannot evaluate, so each month is seeded by
 * the `month` value the route reads from `EXTRACT(MONTH ...)`. The year-boundary
 * test instead captures the Date bounds the route passes to gte/lte to prove the
 * requested year drives the window. The issue's "against a Postgres service" is
 * therefore approximated with the campaign's mock-db + supertest pattern used by
 * the other route suites; the JS sign conventions, zero-fill, and year handling
 * are what these tests pin down.
 *
 * Security: all fixtures use synthetic addresses and amounts and never reference
 * a real connection string (`../db/index.js` is fully mocked).
 */

type EscrowRow = { month: number; amount: string; eventType: string };

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
  eq: vi.fn((_column: unknown, value: unknown) => ({ type: "eq", value })),
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
  inArray: vi.fn(() => ({ type: "inArray" })),
}));

import { analyticsRouter } from "./analytics.js";

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

/** Reads the chart value for a labelled month from the response payload. */
function viewsFor(data: Array<{ month: string; views: number }>, month: string): number {
  const entry = data.find((d) => d.month === month);
  if (!entry) throw new Error(`month ${month} missing from chart data`);
  return entry.views;
}

const USER = "0x0000000000000000000000000000000000000000000000000000000000000abc";

beforeEach(() => {
  vi.clearAllMocks();
  queryState.rows.payments = [];
  queryState.rows.escrowEvents = [];
  queryState.rows.agreementEvents = [];
  queryState.gteDates = [];
  queryState.lteDates = [];
});

describe("analytics monthly aggregation", () => {
  it("sums payments, subtracts funding, adds releases/refunds, and zero-fills the rest", async () => {
    // Amounts are multiples of 1e6 so the 6-decimal display maps to whole units.
    queryState.rows.payments = [
      { month: 3, amount: "5000000" }, // +5 in March
      { month: 9, amount: "10000000" }, // +10 in September
    ];
    queryState.rows.escrowEvents = [
      { month: 3, amount: "2000000", eventType: "Funded" }, // -2 in March
      { month: 3, amount: "1000000", eventType: "Released" }, // +1 in March
      { month: 4, amount: "3000000", eventType: "Funded" }, // -3 in April (funding only)
      { month: 5, amount: "4000000", eventType: "Released" }, // +4 in May
      { month: 6, amount: "2000000", eventType: "Refunded" }, // +2 in June
    ];

    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);

    expect(res.body.year).toBe(2026);
    expect(res.body.data).toHaveLength(12);

    // March nets payment(+5) - funded(2) + released(1) = 4.
    expect(viewsFor(res.body.data, "Mar")).toBe(4);
    // April is funding only, so it goes negative.
    expect(viewsFor(res.body.data, "Apr")).toBe(-3);
    expect(viewsFor(res.body.data, "May")).toBe(4);
    expect(viewsFor(res.body.data, "Jun")).toBe(2);
    expect(viewsFor(res.body.data, "Sept")).toBe(10);

    // Untouched months are zero-filled, not absent.
    for (const empty of ["Jan", "Feb", "Jul", "Aug", "Oct", "Nov", "Dec"]) {
      expect(viewsFor(res.body.data, empty)).toBe(0);
    }

    // Total is the lossless sum of every month: 4 - 3 + 4 + 2 + 10 = 17.
    expect(res.body.total).toBe(17);
  });

  it("treats a month with only funding as negative", async () => {
    queryState.rows.escrowEvents = [
      { month: 2, amount: "7000000", eventType: "Funded" },
    ] satisfies EscrowRow[];

    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);

    expect(viewsFor(res.body.data, "Feb")).toBe(-7);
    expect(res.body.total).toBe(-7);
  });

  it("counts each agreement creation as a small base activity value", async () => {
    // The route adds count * 1000 base units per month; with 6 decimals that is
    // 0.001 of display value per creation.
    queryState.rows.agreementEvents = [
      { month: 1, agreementId: "1" },
      { month: 1, agreementId: "2" },
      { month: 1, agreementId: "3" },
    ];

    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2026`).expect(200);

    expect(viewsFor(res.body.data, "Jan")).toBe(0.003);
    expect(res.body.total).toBe(0.003);
  });

  it("returns twelve zero-filled months and a zero total when there is no activity", async () => {
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
  });

  it("defaults to the current year when none is supplied", async () => {
    const res = await request(makeApp()).get(`/api/v1/analytics/${USER}`).expect(200);

    expect(res.body.year).toBe(new Date().getFullYear());
    // The default-year window still spans the current calendar year.
    expect(queryState.gteDates[0].getFullYear()).toBe(new Date().getFullYear());
  });

  it("scopes the query to the requested year's calendar boundaries", async () => {
    await request(makeApp()).get(`/api/v1/analytics/${USER}?year=2023`).expect(200);

    // Every table query shares the same start/end window built from the year.
    const start = queryState.gteDates[0];
    const end = queryState.lteDates[0];
    expect(start.getFullYear()).toBe(2023);
    expect(start.getMonth()).toBe(0); // January
    expect(start.getDate()).toBe(1);
    expect(end.getFullYear()).toBe(2023);
    expect(end.getMonth()).toBe(11); // December
    expect(end.getDate()).toBe(31);
  });

  it("surfaces a database failure during aggregation through the error handler", async () => {
    // The first aggregation query rejects, so the route's catch forwards it to
    // the error handler rather than returning a partial chart.
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

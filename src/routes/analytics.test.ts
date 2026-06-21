import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  gte: vi.fn(() => ({ type: "gte" })),
  lte: vi.fn(() => ({ type: "lte" })),
  sql: vi.fn(() => "sql-expr"),
}));

import { analyticsRouter } from "./analytics.js";
import { normalizeStarknetAddress } from "../utils/address.js";

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

beforeEach(() => {
  vi.clearAllMocks();
  queryState.rows.payments = [];
  queryState.rows.escrowEvents = [];
  queryState.rows.agreementEvents = [];
  queryState.eqValues = [];
});

describe("analytics route", () => {
  it("validates and normalizes the address and returns twelve months of chart data", async () => {
    queryState.rows.payments = [{ month: 3, amount: "1000000" }];
    queryState.rows.escrowEvents = [
      { month: 4, amount: "2000000", eventType: "Funded" },
      { month: 5, amount: "3000000", eventType: "Released" },
    ];
    queryState.rows.agreementEvents = [{ month: 6, agreementId: "1" }];

    const res = await request(makeApp()).get("/api/v1/analytics/abc?year=2026").expect(200);

    expect(res.body.year).toBe(2026);
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
    expect(typeof res.body.total).toBe("number");
    // The address is validated and then normalized before it reaches the query
    // layer, so the canonical form is what the DB filters on.
    expect(queryState.eqValues).toContain(normalizeStarknetAddress("abc"));
  });

  it("defaults to the current year when none is supplied", async () => {
    const res = await request(makeApp()).get("/api/v1/analytics/abc").expect(200);
    expect(res.body.year).toBe(new Date().getFullYear());
  });

  it("rejects a malformed address with 400 before any query runs", async () => {
    const res = await request(makeApp()).get("/api/v1/analytics/not-an-address").expect(400);
    expect(res.body.error).toBe("Validation failed");
    expect(queryState.eqValues).toHaveLength(0);
  });

  it("rejects a year below the supported range with 400", async () => {
    await request(makeApp()).get("/api/v1/analytics/abc?year=1999").expect(400);
  });

  it("rejects a year above the supported range with 400", async () => {
    await request(makeApp()).get("/api/v1/analytics/abc?year=3000").expect(400);
  });
});

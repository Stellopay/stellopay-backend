import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, queryState, schemaMock } = vi.hoisted(() => {
  type TableName = "agreements" | "agreementEvents" | "payments" | "escrowEvents";
  type Condition = { type: "eq"; value: string } | { type: "or"; conditions: Condition[] };

  const makeColumn = (table: TableName, name: string) => ({ table, name });
  const makeTable = <TName extends TableName>(name: TName) => ({
    __name: name,
    id: makeColumn(name, "id"),
    employer: makeColumn(name, "employer"),
    contributor: makeColumn(name, "contributor"),
    from: makeColumn(name, "from"),
    to: makeColumn(name, "to"),
    createdAt: makeColumn(name, "createdAt"),
    blockNumber: makeColumn(name, "blockNumber"),
  });

  const schema = {
    agreements: makeTable("agreements"),
    agreementEvents: makeTable("agreementEvents"),
    payments: makeTable("payments"),
    escrowEvents: makeTable("escrowEvents"),
  };

  const validUser = "0x0000000000000000000000000000000000000000000000000000000000000abc";
  const otherUser = "0x0000000000000000000000000000000000000000000000000000000000000def";

  const state = {
    validUser,
    counts: {
      agreements: 7,
      agreementEvents: 9,
      payments: 4,
      escrowEvents: 3,
    } as Record<TableName, number>,
    latest: {
      agreementEvents: Array.from({ length: 7 }, (_, i) => ({
        id: `event-${7 - i}`,
        blockNumber: 700 - i,
      })),
      agreements: Array.from({ length: 6 }, (_, i) => ({
        id: `agreement-${6 - i}`,
        createdAt: new Date(Date.UTC(2026, 0, 6 - i)).toISOString(),
      })),
      payments: [],
      escrowEvents: [],
    } as Record<TableName, unknown[]>,
    byUser: {
      agreements: [
        { id: "agreement-employer", employer: validUser, contributor: otherUser },
        { id: "agreement-contributor", employer: otherUser, contributor: validUser },
      ],
      payments: [
        { id: "payment-from", from: validUser, to: otherUser, blockNumber: 88 },
        { id: "payment-to", from: otherUser, to: validUser, blockNumber: 87 },
      ],
      escrowEvents: [
        { id: "escrow-employer", employer: validUser, to: otherUser, blockNumber: 66 },
        { id: "escrow-to", employer: otherUser, to: validUser, blockNumber: 65 },
      ],
      agreementEvents: [],
    } as Record<TableName, unknown[]>,
    limitCalls: [] as Array<{ table: TableName; limit: number }>,
    whereValues: [] as string[],
  };

  function valueFromCondition(condition: Condition): string | undefined {
    if (condition.type === "eq") return condition.value;
    return condition.conditions.map(valueFromCondition).find(Boolean);
  }

  function rowsForUser(table: TableName, condition: Condition) {
    const value = valueFromCondition(condition);
    if (value) state.whereValues.push(value);
    return value === state.validUser ? state.byUser[table] : [];
  }

  const db = {
    select: vi.fn((selection?: { count?: unknown }) => ({
      from: vi.fn((table: { __name: TableName }) => {
        const tableName = table.__name;

        if (selection?.count !== undefined) {
          return Promise.resolve([{ count: state.counts[tableName] ?? 0 }]);
        }

        return {
          orderBy: vi.fn(() => ({
            limit: vi.fn((limit: number) => {
              state.limitCalls.push({ table: tableName, limit });
              return Promise.resolve(state.latest[tableName].slice(0, limit));
            }),
          })),
          where: vi.fn((condition: Condition) => ({
            orderBy: vi.fn(() => Promise.resolve(rowsForUser(tableName, condition))),
          })),
        };
      }),
    })),
  };

  return { dbMock: db, queryState: state, schemaMock: schema };
});

vi.mock("../db/index.js", () => ({
  db: dbMock,
  schema: schemaMock,
}));

vi.mock("drizzle-orm", () => ({
  count: vi.fn(() => "count(*)"),
  desc: vi.fn((column: unknown) => ({ type: "desc", column })),
  eq: vi.fn((column: unknown, value: string) => ({ type: "eq", column, value })),
  or: vi.fn((...conditions: unknown[]) => ({ type: "or", conditions })),
}));

import { indexerStatusRouter } from "./indexer-status.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", indexerStatusRouter);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: err.message ?? "Internal error" });
    },
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryState.limitCalls = [];
  queryState.whereValues = [];
});

describe("indexer status routes", () => {
  it("returns table counts and caps latest events and agreements at five rows", async () => {
    const res = await request(makeApp()).get("/api/v1/indexer/status").expect(200);

    expect(res.body.counts).toEqual({
      agreements: 7,
      events: 9,
      payments: 4,
      escrowEvents: 3,
    });

    // TODO: status should reflect actual DB connectivity instead of a hardcoded constant.
    expect(res.body.status).toBe("connected");
    expect(res.body.latest.events).toHaveLength(5);
    expect(res.body.latest.events.map((event: { id: string }) => event.id)).toEqual([
      "event-7",
      "event-6",
      "event-5",
      "event-4",
      "event-3",
    ]);
    expect(res.body.latest.agreements).toHaveLength(5);
    expect(res.body.latest.agreements.map((agreement: { id: string }) => agreement.id)).toEqual([
      "agreement-6",
      "agreement-5",
      "agreement-4",
      "agreement-3",
      "agreement-2",
    ]);
    expect(queryState.limitCalls).toEqual([
      { table: "agreementEvents", limit: 5 },
      { table: "agreements", limit: 5 },
    ]);
  });

  it("normalizes a user address and returns matching agreements, payments, and escrow events", async () => {
    const res = await request(makeApp()).get("/api/v1/indexer/user/ABC/events").expect(200);

    expect(res.body.userAddress).toBe(queryState.validUser);
    expect(res.body).toMatchObject({
      agreements: 2,
      payments: 2,
      escrowEvents: 2,
    });
    expect(res.body.data.agreements.map((row: { id: string }) => row.id)).toEqual([
      "agreement-employer",
      "agreement-contributor",
    ]);
    expect(res.body.data.payments.map((row: { id: string }) => row.id)).toEqual([
      "payment-from",
      "payment-to",
    ]);
    expect(res.body.data.escrowEvents.map((row: { id: string }) => row.id)).toEqual([
      "escrow-employer",
      "escrow-to",
    ]);
    expect(queryState.whereValues).toEqual([
      queryState.validUser,
      queryState.validUser,
      queryState.validUser,
    ]);
  });

  it("returns empty collections for an unknown user address", async () => {
    const res = await request(makeApp()).get("/api/v1/indexer/user/def/events").expect(200);

    expect(res.body.userAddress).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000def",
    );
    expect(res.body).toMatchObject({
      agreements: 0,
      payments: 0,
      escrowEvents: 0,
      data: {
        agreements: [],
        payments: [],
        escrowEvents: [],
      },
    });
  });
});

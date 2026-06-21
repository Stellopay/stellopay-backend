import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const { dbMock, schemaMock, queryState } = vi.hoisted(() => {
  type TableName = "payments" | "agreements" | "agreementEvents" | "escrowEvents";

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
    agreements: makeTable("agreements"),
    agreementEvents: makeTable("agreementEvents"),
    escrowEvents: makeTable("escrowEvents"),
  };

  const state = {
    rows: {
      payments: [] as Array<Record<string, unknown>>,
      agreements: [] as Array<Record<string, unknown>>,
      agreementEvents: [] as Array<Record<string, unknown>>,
      escrowEvents: [] as Array<Record<string, unknown>>,
    },
    eqValues: [] as string[],
    limitCalls: [] as number[],
  };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: { __name: TableName }) => {
        const rows = state.rows[table.__name] ?? [];
        // `where` is both directly awaitable (the agreement-id lookup) and
        // chainable through orderBy/limit (the list queries), so it returns a
        // thenable that also exposes the pagination chain.
        const chainable = {
          orderBy: vi.fn(() => ({
            limit: vi.fn((limit: number) => {
              state.limitCalls.push(limit);
              return Promise.resolve(rows);
            }),
          })),
          then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        return { where: vi.fn(() => chainable) };
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
  desc: vi.fn((column: unknown) => ({ type: "desc", column })),
  inArray: vi.fn((column: unknown, values: unknown) => ({ type: "inArray", column, values })),
}));

import { notificationsRouter } from "./notifications.js";
import { normalizeStarknetAddress } from "../utils/address.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", notificationsRouter);
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
  queryState.rows.agreements = [];
  queryState.rows.agreementEvents = [];
  queryState.rows.escrowEvents = [];
  queryState.eqValues = [];
  queryState.limitCalls = [];
});

describe("notifications route", () => {
  it("validates and normalizes the address and returns sorted notifications", async () => {
    queryState.rows.payments = [
      {
        id: "payment-1",
        eventType: "PaymentReceived",
        transactionHash: "0xpayment0001",
        amount: "1000000",
        token: undefined,
        createdAt: new Date("2026-03-02T00:00:00Z"),
      },
    ];
    queryState.rows.agreements = [{ id: "1" }];
    queryState.rows.agreementEvents = [
      {
        id: "event-1",
        eventType: "AgreementCreated",
        agreementId: "1",
        transactionHash: "0xevent0001",
        createdAt: new Date("2026-03-03T00:00:00Z"),
      },
    ];
    queryState.rows.escrowEvents = [
      {
        id: "escrow-1",
        eventType: "Funded",
        agreementId: "1",
        amount: "2000000",
        transactionHash: "0xescrow0001",
        createdAt: new Date("2026-03-01T00:00:00Z"),
      },
    ];

    const res = await request(makeApp()).get("/api/v1/notifications/abc").expect(200);

    expect(res.body.total).toBe(3);
    expect(res.body.notifications).toHaveLength(3);
    // Newest first: the agreement event (Mar 3) precedes the payment (Mar 2)
    // and the escrow event (Mar 1).
    expect(res.body.notifications.map((n: { id: string }) => n.id)).toEqual([
      "event-1",
      "payment-1",
      "escrow-1",
    ]);
    // The default limit of 10 is applied when no limit is supplied.
    expect(queryState.limitCalls.every((limit) => limit === 10)).toBe(true);
    // The canonical normalized address is what the DB filters on.
    expect(queryState.eqValues).toContain(normalizeStarknetAddress("abc"));
  });

  it("maps every payment, agreement, and escrow event type to its notification title", async () => {
    queryState.rows.payments = [
      {
        id: "payment-sent",
        eventType: "PaymentSent",
        transactionHash: "0xpaymentsent",
        amount: "500000",
        token: undefined,
        createdAt: new Date("2026-02-10T00:00:00Z"),
      },
    ];
    queryState.rows.agreements = [{ id: "1" }];
    queryState.rows.agreementEvents = [
      {
        id: "dispute-raised",
        eventType: "DisputeRaised",
        agreementId: "1",
        transactionHash: "0xa1",
        createdAt: new Date("2026-02-09T00:00:00Z"),
      },
      {
        id: "dispute-resolved",
        eventType: "DisputeResolved",
        agreementId: "1",
        transactionHash: "0xa2",
        createdAt: new Date("2026-02-08T00:00:00Z"),
      },
      {
        id: "activated",
        eventType: "AgreementActivated",
        agreementId: "1",
        transactionHash: "0xa3",
        createdAt: new Date("2026-02-07T00:00:00Z"),
      },
      {
        id: "cancelled",
        eventType: "AgreementCancelled",
        agreementId: "1",
        transactionHash: "0xa4",
        createdAt: new Date("2026-02-06T00:00:00Z"),
      },
    ];
    queryState.rows.escrowEvents = [
      {
        id: "released",
        eventType: "Released",
        agreementId: "1",
        amount: "700000",
        transactionHash: "0xe1",
        createdAt: new Date("2026-02-05T00:00:00Z"),
      },
      {
        id: "refunded",
        eventType: "Refunded",
        agreementId: "1",
        amount: "800000",
        transactionHash: "0xe2",
        createdAt: new Date("2026-02-04T00:00:00Z"),
      },
    ];

    const res = await request(makeApp()).get("/api/v1/notifications/abc").expect(200);

    const titles = res.body.notifications.map((n: { title: string }) => n.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Payment Sent",
        "Dispute Raised",
        "Dispute Resolved",
        "Agreement Activated",
        "Agreement Cancelled",
        "Funds Released",
        "Funds Refunded",
      ]),
    );
  });

  it("applies a valid in-range limit", async () => {
    await request(makeApp()).get("/api/v1/notifications/abc?limit=25").expect(200);
    expect(queryState.limitCalls.every((limit) => limit === 25)).toBe(true);
  });

  it("rejects a malformed address with 400 before any query runs", async () => {
    const res = await request(makeApp()).get("/api/v1/notifications/not-an-address").expect(400);
    expect(res.body.error).toBe("Validation failed");
    expect(queryState.eqValues).toHaveLength(0);
  });

  it("rejects a limit above the cap with 400", async () => {
    await request(makeApp()).get("/api/v1/notifications/abc?limit=51").expect(400);
  });

  it("rejects a zero or negative limit with 400", async () => {
    await request(makeApp()).get("/api/v1/notifications/abc?limit=0").expect(400);
    await request(makeApp()).get("/api/v1/notifications/abc?limit=-5").expect(400);
  });
});

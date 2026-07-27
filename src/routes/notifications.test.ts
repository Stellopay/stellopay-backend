import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

/**
 * Drizzle mock that resolves each `from()` call with the row array for that
 * table. The `limitCalls` recorder is asserted on in pagination tests so we
 * can verify the same clamp/limit was applied to every data-source query.
 *
 * The previous version of this file was structurally broken: dangling
 * `expect(...)` calls referenced an out-of-scope `res`, referred to routes
 * that do not exist in production (`/unread-count`, PATCH `/preferences`),
 * and relied on a `$count` mock the route never invokes. The rewrite below
 * only covers the production contract: the single GET endpoint and its two
 * exported helpers.
 */
const { dbMock, schemaMock, queryState, USDC_TOKEN_ADDRESS } = vi.hoisted(() => {
  type TableName = "payments" | "agreements" | "agreementEvents" | "escrowEvents";

  const USDC_TOKEN_ADDRESS =
    "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080";

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

  return { dbMock: db, schemaMock: schema, queryState: state, USDC_TOKEN_ADDRESS };
});

vi.mock("../config.js", () => ({
  env: {
    TOKEN_STRK: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    TOKEN_USDC: USDC_TOKEN_ADDRESS,
    TOKEN_USDT: "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb",
  },
}));

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

import {
  notificationsRouter,
  getDefaultNotificationPreferences,
  calculateUnreadCount,
} from "./notifications.js";
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

function makePayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "payment-1",
    eventType: "PaymentReceived",
    transactionHash: "0xpayment0001",
    amount: "1000000",
    token: undefined,
    createdAt: new Date("2026-03-02T00:00:00Z"),
    ...overrides,
  };
}

function makeAgreementEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "event-1",
    eventType: "AgreementCreated",
    agreementId: "1",
    transactionHash: "0xevent0001",
    createdAt: new Date("2026-03-03T00:00:00Z"),
    ...overrides,
  };
}

function makeEscrowEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "escrow-1",
    eventType: "Funded",
    agreementId: "1",
    amount: "2000000",
    transactionHash: "0xescrow0001",
    createdAt: new Date("2026-03-01T00:00:00Z"),
    ...overrides,
  };
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

describe("notification preferences & unread count helpers", () => {
  it("provides default notification preferences enabled for all categories", () => {
    const prefs = getDefaultNotificationPreferences();
    expect(prefs).toEqual({
      payments: true,
      agreements: true,
      escrow: true,
      disputes: true,
    });
  });

  it("returns a fresh default-preference object on every call", () => {
    // The contract is a value, not a shared singleton: callers can mutate
    // one returned object without poisoning other callers.
    const a = getDefaultNotificationPreferences();
    const b = getDefaultNotificationPreferences();
    a.payments = false;
    expect(b.payments).toBe(true);
  });

  it("calculates unread count correctly from notification objects", () => {
    const list = [{ read: false }, { read: true }, { read: false }];
    expect(calculateUnreadCount(list)).toBe(2);
  });

  it("returns zero unread items when every notification has read=true", () => {
    expect(calculateUnreadCount([{ read: true }, { read: true }])).toBe(0);
  });

  it("returns zero unread items for an empty list", () => {
    expect(calculateUnreadCount([])).toBe(0);
  });
});

describe("notifications route", () => {
  it("returns an empty aggregation when no events match the user", async () => {
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);

    expect(res.body).toEqual({ notifications: [], total: 0, unreadCount: 0 });
    expect(queryState.eqValues).toContain(normalizeStarknetAddress("abc"));
  });

  it("fires the four expected queries when the user has agreements and events (3 parallel + 1 dependent)", async () => {
    // Regression guard for the Promise.all refactor: three queries
    // (`payments`, `agreements`, `escrowEvents`) are independent and run
    // concurrently, and the dependent `agreementEvents` query runs as a
    // follow-up. The total `select()` call count is therefore exactly 4.
    queryState.rows.payments = [makePayment({ id: "payment-1" })];
    queryState.rows.agreements = [{ id: "1", token: USDC_TOKEN_ADDRESS }];
    queryState.rows.agreementEvents = [
      makeAgreementEvent({ id: "event-1", eventType: "AgreementCreated" }),
    ];
    queryState.rows.escrowEvents = [
      makeEscrowEvent({ id: "escrow-1", eventType: "Funded" }),
    ];

    await request(makeApp()).get("/api/v1/notifications/abc").expect(200);

    expect(dbMock.select).toHaveBeenCalledTimes(4);
  });

  it("skips the dependent agreementEvents query when the user has no agreements (3 parallel queries only)", async () => {
    queryState.rows.payments = [makePayment()];
    queryState.rows.escrowEvents = [makeEscrowEvent()];
    // No agreement rows → `agreementIds.length === 0` short-circuits the
    // dependent query. Total `select()` calls is therefore exactly 3.
    await request(makeApp()).get("/api/v1/notifications/abc").expect(200);
    expect(dbMock.select).toHaveBeenCalledTimes(3);
  });

  it("validates and normalizes the address, returning sorted notifications with unreadCount", async () => {
    queryState.rows.payments = [makePayment({ id: "payment-1" })];
    queryState.rows.agreements = [{ id: "1", token: USDC_TOKEN_ADDRESS }];
    queryState.rows.agreementEvents = [
      makeAgreementEvent({ id: "event-1", eventType: "AgreementCreated" }),
    ];
    queryState.rows.escrowEvents = [
      makeEscrowEvent({ id: "escrow-1", eventType: "Funded" }),
    ];

    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);

    expect(res.body.total).toBe(3);
    expect(res.body.unreadCount).toBe(3);
    expect(res.body.notifications).toHaveLength(3);
    // Date sort descending: 03-03 (event-1), 03-02 (payment-1), 03-01 (escrow-1).
    expect(res.body.notifications.map((n: { id: string }) => n.id)).toEqual([
      "event-1",
      "payment-1",
      "escrow-1",
    ]);
    expect(queryState.limitCalls.every((limit) => limit === 10)).toBe(true);
  });

  it("clamps the limit to the documented default of 10 when none is supplied", async () => {
    await request(makeApp()).get("/api/v1/notifications/abc").expect(200);
    expect(queryState.limitCalls.length).toBeGreaterThan(0);
    expect(queryState.limitCalls.every((limit) => limit === 10)).toBe(true);
  });

  it("passes the requested limit through when within the documented range", async () => {
    await request(makeApp()).get("/api/v1/notifications/abc?limit=3").expect(200);
    expect(queryState.limitCalls.every((limit) => limit === 3)).toBe(true);
  });

  it("rejects a limit above the documented maximum of 50 with 400", async () => {
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?limit=51")
      .expect(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("rejects a non-numeric limit with 400", async () => {
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?limit=not-a-number")
      .expect(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("rejects a zero or negative limit with 400", async () => {
    await request(makeApp()).get("/api/v1/notifications/abc?limit=0").expect(400);
    await request(makeApp()).get("/api/v1/notifications/abc?limit=-1").expect(400);
  });

  it("rejects an invalid Starknet address with 400", async () => {
    await request(makeApp())
      .get("/api/v1/notifications/not-a-hex-string!!")
      .expect(400);
  });

  it("formats a PaymentSent notification with the sent-prefix and tx-hash excerpt", async () => {
    queryState.rows.payments = [
      makePayment({
        id: "p1",
        eventType: "PaymentSent",
        transactionHash: "0x0123456789abcdef",
        amount: "1000000",
        token: USDC_TOKEN_ADDRESS,
      }),
    ];

    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);
    const item = res.body.notifications[0];
    expect(item.title).toBe("Payment Sent");
    expect(item.message).toContain("You sent");
    expect(item.message).toContain("0x01234567");
    expect(item.type).toBe("PaymentSent");
    expect(item.read).toBe(false);
    expect(item.txHash).toBe("0x0123456789abcdef");
  });

  it("formats a PaymentReceived notification with the received-prefix", async () => {
    queryState.rows.payments = [
      makePayment({
        id: "p2",
        eventType: "PaymentReceived",
      }),
    ];
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);
    const item = res.body.notifications[0];
    expect(item.title).toBe("Payment Received");
    expect(item.message).toContain("You received");
  });

  it("formats every important agreement event type with a human-readable title", async () => {
    queryState.rows.agreements = [{ id: "1", token: USDC_TOKEN_ADDRESS }];
    queryState.rows.agreementEvents = [
      makeAgreementEvent({
        id: "created",
        eventType: "AgreementCreated",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
      makeAgreementEvent({
        id: "activated",
        eventType: "AgreementActivated",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      }),
      makeAgreementEvent({
        id: "cancelled",
        eventType: "AgreementCancelled",
        createdAt: new Date("2026-01-03T00:00:00Z"),
      }),
      makeAgreementEvent({
        id: "raised",
        eventType: "DisputeRaised",
        createdAt: new Date("2026-01-04T00:00:00Z"),
      }),
      makeAgreementEvent({
        id: "resolved",
        eventType: "DisputeResolved",
        createdAt: new Date("2026-01-05T00:00:00Z"),
      }),
    ];

    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);

    expect(res.body.notifications.map((n: { title: string }) => n.title)).toEqual([
      "Dispute Resolved",
      "Dispute Raised",
      "Agreement Cancelled",
      "Agreement Activated",
      "Agreement Created",
    ]);
    // Title memoization is an internal detail, but rendering the same
    // eventType five times is the path that exercises the cache; we
    // sanity-check that all five come back with the expected format.
    expect(res.body.notifications.every((n: { title: string }) => /\s/.test(n.title))).toBe(
      true,
    );
  });

  it("preserves the AgreementCreated message with a #<id> prefix", async () => {
    queryState.rows.agreements = [{ id: "42", token: USDC_TOKEN_ADDRESS }];
    queryState.rows.agreementEvents = [
      makeAgreementEvent({ id: "e1", eventType: "AgreementCreated", agreementId: "42" }),
    ];
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);
    expect(res.body.notifications[0].message).toBe("Agreement #42 has been created");
  });

  it("uses the 'Agreement Funded' title for Funded escrow events and the 'Funds <type>' format otherwise", async () => {
    queryState.rows.agreements = [{ id: "1", token: USDC_TOKEN_ADDRESS }];
    queryState.rows.escrowEvents = [
      makeEscrowEvent({ id: "f", eventType: "Funded", createdAt: new Date("2026-01-01") }),
      makeEscrowEvent({
        id: "r",
        eventType: "Released",
        createdAt: new Date("2026-01-02"),
      }),
      makeEscrowEvent({
        id: "rf",
        eventType: "Refunded",
        createdAt: new Date("2026-01-03"),
      }),
    ];
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);
    const titles = res.body.notifications
      .map((n: { id: string; title: string }) => `${n.id}:${n.title}`)
      .sort();
    expect(titles).toEqual(["f:Agreement Funded", "r:Funds Released", "rf:Funds Refunded"]);
  });

  it("uses the agreement's token for escrow event message formatting even when many events share the same agreement", async () => {
    queryState.rows.agreements = [{ id: "1", token: USDC_TOKEN_ADDRESS }];
    // 5 escrow events on agreement 1 = 5 tokens sharing the same USDC token.
    // The per-request tokenInfoCache guarantees a single resolution of
    // getTokenInfo(USDC_TOKEN); behaviorally every event must format the
    // 6-decimal USDC amount identically.
    queryState.rows.escrowEvents = Array.from({ length: 5 }, (_, i) =>
      makeEscrowEvent({
        id: `escrow-${i}`,
        eventType: "Released",
        agreementId: "1",
        amount: String((i + 1) * 1_000_000),
        transactionHash: `0x${i}`,
        createdAt: new Date(`2026-01-0${i + 1}T00:00:00Z`),
      }),
    );
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);
    expect(res.body.total).toBe(5);
    // Each event formats exactly to "<integer>" under the 6-decimal USDC rule
    // (1_000_000 → 1, 2_000_000 → 2, ...).
    expect(
      res.body.notifications.map((n: { message: string }) => n.message),
    ).toEqual([
      "Agreement 1: Released of 5 tokens",
      "Agreement 1: Released of 4 tokens",
      "Agreement 1: Released of 3 tokens",
      "Agreement 1: Released of 2 tokens",
      "Agreement 1: Released of 1 tokens",
    ]);
  });

  it("falls back to integer-only formatting when the escrow agreement is unknown", async () => {
    // Escrow event referencing an agreement the user does not own → the
    // agreements map returns undefined → tokenInfoCache resolves with the
    // zero-decimal placeholder. `formatTokenAmount` with `decimals: 0`
    // returns the integer count of the amount (no fractional scaling),
    // matching the pre-refactor production behavior.
    queryState.rows.escrowEvents = [
      makeEscrowEvent({
        id: "orphan",
        eventType: "Released",
        agreementId: "999",
        amount: "1000000",
      }),
    ];
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);
    expect(res.body.notifications[0].message).toBe("Agreement 999: Released of 1000000 tokens");
  });
});

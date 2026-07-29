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
    failure: undefined as Error | undefined,
  };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: { __name: TableName }) => {
        const result = () =>
          state.failure ? Promise.reject(state.failure) : Promise.resolve(state.rows[table.__name] ?? []);
        const chainable = {
          orderBy: vi.fn(() => ({
            limit: vi.fn((limit: number) => {
              state.limitCalls.push(limit);
              return result();
            }),
          })),
          then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
            result().then(resolve, reject),
        };
        return { where: vi.fn(() => chainable) };
      }),
    })),
  };

  return { dbMock: db, schemaMock: schema, queryState: state, USDC_TOKEN_ADDRESS };
});

vi.mock("../config.js", () => ({
  env: {
    LOG_FORMAT: "json",
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
  NOTIFICATIONS_DEFAULT_LIMIT,
  NOTIFICATIONS_MAX_LIMIT,
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
  vi.restoreAllMocks();
  vi.clearAllMocks();
  queryState.rows.payments = [];
  queryState.rows.agreements = [];
  queryState.rows.agreementEvents = [];
  queryState.rows.escrowEvents = [];
  queryState.eqValues = [];
  queryState.limitCalls = [];
  queryState.failure = undefined;
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

  it("deduplicates notifications by id when computing unread count", () => {
    // Regression guard: calculateUnreadCount tracks unique IDs to avoid
    // double-counting the same notification if it appears twice in the list.
    const list = [
      { id: "notif-1", read: false },
      { id: "notif-2", read: false },
      { id: "notif-1", read: false }, // duplicate ID
    ];
    expect(calculateUnreadCount(list)).toBe(2);
  });

  it("counts notifications without id fields individually", () => {
    // Notifications without an `id` field cannot be deduplicated; each is
    // counted independently.
    const list = [
      { read: false },
      { read: false },
      { id: "notif-1", read: false },
    ];
    expect(calculateUnreadCount(list)).toBe(3);
  });

  it("handles mixed types of id (string and number) correctly", () => {
    const list = [
      { id: "notif-1", read: false },
      { id: 123, read: false },
      { id: "notif-1", read: false }, // duplicate string ID
      { id: 123, read: false }, // duplicate numeric ID
    ];
    expect(calculateUnreadCount(list)).toBe(2);
  });

  it("returns zero when duplicate IDs are all read", () => {
    // Regression guard: a list where every entry is read=true, including
    // duplicates, must yield 0 — the dedup path must not accidentally count
    // read items as unread when they appear more than once.
    const list = [
      { id: "notif-1", read: true },
      { id: "notif-1", read: true },
      { id: "notif-2", read: true },
    ];
    expect(calculateUnreadCount(list)).toBe(0);
  });

  it("treats numeric id 0 as a valid deduplication key", () => {
    // Edge case: id=0 is falsy in JS but must still be tracked as a unique key.
    const list = [
      { id: 0, read: false },
      { id: 0, read: false }, // duplicate of id 0
      { id: 1, read: false },
    ];
    expect(calculateUnreadCount(list)).toBe(2);
  });

  it("unreadCount always equals the number of items returned when all are unread", () => {
    // Invariant: since every notification has read=false, calculateUnreadCount
    // must equal the array length. This is the property the route depends on
    // to keep `unreadCount` in sync with `total`.
    const items = [
      { id: "a", read: false as const },
      { id: "b", read: false as const },
      { id: "c", read: false as const },
    ];
    expect(calculateUnreadCount(items)).toBe(items.length);
  });
});

describe("notifications route", () => {
  it("emits structured preference and unread-count telemetry for a successful response", async () => {
    queryState.rows.payments = [makePayment()];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await request(makeApp()).get("/api/v1/notifications/abc").expect(200);

    const telemetry = JSON.parse(info.mock.calls[0][0] as string);
    expect(telemetry).toMatchObject({
      metric: "notification_preferences_and_unread_count",
      operation: "notification_feed",
      status: "success",
      notification_count: 1,
      unread_count: 1,
      preferences_enabled: 4,
    });
    expect(telemetry).not.toHaveProperty("user_address");
  });

  it("emits a structured failure record when notification retrieval fails", async () => {
    queryState.failure = new Error("database unavailable");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await request(makeApp()).get("/api/v1/notifications/abc").expect(500);

    expect(JSON.parse(error.mock.calls[0][0] as string)).toMatchObject({
      metric: "notification_preferences_and_unread_count",
      operation: "notification_feed",
      status: "error",
      error: "database unavailable",
    });
  });

  it("returns an empty aggregation when no events match the user", async () => {
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);

    expect(res.body).toMatchObject({ notifications: [], total: 0, unreadCount: 0 });
    // Pagination envelope fields are echoed back even for empty results.
    expect(res.body.limit).toBe(NOTIFICATIONS_DEFAULT_LIMIT);
    expect(res.body.offset).toBe(0);
    expect(res.body.hasMore).toBe(false);
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

    const res = await request(makeApp()).get("/api/v1/notifications/abc").expect(200);
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
    // With offset=0, queryLimit = limit + offset = 3; the DB queries receive 3.
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

  it("preserves the response envelope shape for backward compatibility", async () => {
    // Backward-compatibility contract: the response must have exactly the
    // three documented top-level keys, and notifications must be an array.
    // Older callers destructure this shape and break if keys are renamed.
    queryState.rows.payments = [makePayment()];
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);

    expect(res.body).toHaveProperty("notifications");
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("unreadCount");
    expect(Array.isArray(res.body.notifications)).toBe(true);
    expect(typeof res.body.total).toBe("number");
    expect(typeof res.body.unreadCount).toBe("number");
  });

  it("preserves the notification item shape with all required fields", async () => {
    // Backward-compatibility contract: each notification item must have the
    // seven documented fields. Older callers reference these by name.
    queryState.rows.payments = [
      makePayment({
        id: "test-payment",
        eventType: "PaymentReceived",
        transactionHash: "0xtest",
        amount: "1000000",
        token: USDC_TOKEN_ADDRESS,
        createdAt: new Date("2026-07-28T12:00:00Z"),
      }),
    ];
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);

    const item = res.body.notifications[0];
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("title");
    expect(item).toHaveProperty("message");
    expect(item).toHaveProperty("read");
    expect(item).toHaveProperty("date");
    expect(item).toHaveProperty("type");
    expect(item).toHaveProperty("txHash");

    expect(typeof item.id).toBe("string");
    expect(typeof item.title).toBe("string");
    expect(typeof item.message).toBe("string");
    expect(typeof item.read).toBe("boolean");
    expect(typeof item.date).toBe("string");
    expect(typeof item.type).toBe("string");
    expect(typeof item.txHash).toBe("string");
  });

  it("always returns read=false for all notifications (no persistent read state)", async () => {
    // Backward-compatibility contract: every notification has `read: false`
    // since server-side read state is not yet persisted. Older callers may
    // rely on this behavior for client-side unread tracking.
    queryState.rows.payments = [makePayment(), makePayment({ id: "p2" })];
    queryState.rows.agreements = [{ id: "1", token: USDC_TOKEN_ADDRESS }];
    queryState.rows.agreementEvents = [makeAgreementEvent()];
    queryState.rows.escrowEvents = [makeEscrowEvent()];

    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);

    expect(res.body.notifications.length).toBeGreaterThan(0);
    expect(res.body.notifications.every((n: { read: boolean }) => n.read === false)).toBe(
      true,
    );
  });

  it("returns ISO 8601 timestamp strings in the date field", async () => {
    // Backward-compatibility contract: date field is an ISO 8601 string.
    // Older callers parse this with `new Date(item.date)` or similar.
    queryState.rows.payments = [
      makePayment({ createdAt: new Date("2026-07-28T14:30:00.000Z") }),
    ];
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);

    const item = res.body.notifications[0];
    expect(item.date).toBe("2026-07-28T14:30:00.000Z");
    // Verify it's a valid ISO 8601 string that Date can parse
    expect(new Date(item.date).toISOString()).toBe(item.date);
  });

  it("enforces the documented maximum limit of 50", async () => {
    // Backward-compatibility contract: limit=50 is the documented max.
    // Out-of-range values are rejected with 400 rather than silently clamped.
    await request(makeApp()).get("/api/v1/notifications/abc?limit=50").expect(200);
    await request(makeApp()).get("/api/v1/notifications/abc?limit=51").expect(400);
  });

  it("handles case-insensitive and unprefixed Starknet addresses", async () => {
    // StarknetAddress.parse normalizes various address formats.
    // Verify that both prefixed and unprefixed hex strings are accepted.
    await request(makeApp()).get("/api/v1/notifications/abc").expect(200);
    await request(makeApp())
      .get("/api/v1/notifications/0x0abc")
      .expect(200);
    await request(makeApp())
      .get("/api/v1/notifications/ABC")
      .expect(200);
  });

  it("accepts limit=1 (the minimum documented value) without error", async () => {
    // Boundary: limit=1 is the smallest valid page size. The Zod schema uses
    // .positive() which accepts 1. Confirm the route accepts it and returns
    // the correct envelope shape.
    queryState.rows.payments = [makePayment(), makePayment({ id: "p2" })];
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?limit=1")
      .expect(200);
    expect(res.body.limit).toBe(1);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.hasMore).toBe(true);
  });

  it("unreadCount always equals total in the response (read=false invariant)", async () => {
    // Invariant: every notification emitted by the route has read=false, so
    // unreadCount must equal total on every valid response. This is the
    // property callers rely on when using unreadCount as a badge count.
    queryState.rows.payments = [makePayment(), makePayment({ id: "p2" }), makePayment({ id: "p3" })];
    queryState.rows.agreements = [{ id: "1", token: USDC_TOKEN_ADDRESS }];
    queryState.rows.agreementEvents = [makeAgreementEvent()];
    queryState.rows.escrowEvents = [makeEscrowEvent()];

    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);

    expect(res.body.unreadCount).toBe(res.body.total);
  });

  it("telemetry preferences_enabled is always 4 (all default categories enabled)", async () => {
    // Regression guard: logNotificationsTelemetry receives
    // preferences_enabled = Object.values(getDefaultNotificationPreferences()).filter(Boolean).length
    // which must be exactly 4 (payments + agreements + escrow + disputes).
    // If getDefaultNotificationPreferences ever changed a default to false,
    // this test would catch the unintended telemetry regression.
    queryState.rows.payments = [makePayment()];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await request(makeApp()).get("/api/v1/notifications/abc").expect(200);

    const telemetry = JSON.parse(info.mock.calls[0][0] as string);
    expect(telemetry.preferences_enabled).toBe(4);
  });
});

describe("notifications pagination contract", () => {
  /**
   * Helper: seed N payments with descending dates so [0] is newest.
   * id is `p-<i>` with i=0 being the most recent.
   */
  function seedPayments(count: number): void {
    queryState.rows.payments = Array.from({ length: count }, (_, i) =>
      makePayment({
        id: `p-${i}`,
        createdAt: new Date(`2026-03-${String(count - i).padStart(2, "0")}T00:00:00Z`),
        transactionHash: `0x${i.toString().padStart(4, "0")}`,
      }),
    );
  }

  it("echoes limit and offset=0 (default) in the response envelope", async () => {
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?limit=5")
      .expect(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(0);
  });

  it("echoes the default limit when limit is omitted", async () => {
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc")
      .expect(200);
    expect(res.body.limit).toBe(NOTIFICATIONS_DEFAULT_LIMIT);
  });

  it("sets hasMore=false when the merged pool fits within the page", async () => {
    seedPayments(3);
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?limit=5")
      .expect(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.total).toBe(3);
  });

  it("sets hasMore=true when the merged pool exceeds limit+offset", async () => {
    // 6 payments, limit=3, offset=0 → pool has 6 > 3+0 → hasMore=true
    seedPayments(6);
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?limit=3")
      .expect(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.total).toBe(3);
    expect(res.body.notifications).toHaveLength(3);
  });

  it("passes queryLimit = limit+offset to each data-source query so the pool covers the requested page", async () => {
    // limit=3, offset=2 → queryLimit=5; every DB source should receive 5.
    seedPayments(5);
    await request(makeApp())
      .get("/api/v1/notifications/abc?limit=3&offset=2")
      .expect(200);
    // payments + escrowEvents both receive queryLimit in their .limit() calls.
    // agreements has no .limit() call (no orderBy); only 2 limitCalls expected.
    expect(queryState.limitCalls.every((l) => l === 5)).toBe(true);
  });

  it("returns the correct page when offset skips items", async () => {
    // 5 payments descending: p-0 (newest) … p-4 (oldest).
    // offset=2, limit=2 → items p-2 and p-3.
    seedPayments(5);
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?limit=2&offset=2")
      .expect(200);
    expect(res.body.notifications.map((n: { id: string }) => n.id)).toEqual(["p-2", "p-3"]);
    expect(res.body.offset).toBe(2);
    expect(res.body.total).toBe(2);
  });

  it("returns an empty page (not an error) when offset is beyond the pool", async () => {
    seedPayments(2);
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?limit=5&offset=10")
      .expect(200);
    expect(res.body.notifications).toHaveLength(0);
    expect(res.body.total).toBe(0);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.offset).toBe(10);
  });

  it("rejects a negative offset with 400", async () => {
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?offset=-1")
      .expect(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("rejects a non-numeric offset with 400", async () => {
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?offset=two")
      .expect(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("accepts offset=0 explicitly without error", async () => {
    await request(makeApp())
      .get("/api/v1/notifications/abc?offset=0")
      .expect(200);
  });

  it("hasMore is false on the exact last page (pool == offset+limit)", async () => {
    // 4 payments, limit=2, offset=2 → pool=4, offset+limit=4 → hasMore=false
    seedPayments(4);
    const res = await request(makeApp())
      .get("/api/v1/notifications/abc?limit=2&offset=2")
      .expect(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.total).toBe(2);
  });

  it("enforces NOTIFICATIONS_MAX_LIMIT constant matches the documented maximum of 50", () => {
    expect(NOTIFICATIONS_MAX_LIMIT).toBe(50);
  });

  it("enforces NOTIFICATIONS_DEFAULT_LIMIT constant matches the documented default of 10", () => {
    expect(NOTIFICATIONS_DEFAULT_LIMIT).toBe(10);
  });
});

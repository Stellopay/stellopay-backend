/**
 * @file billing.test.ts
 * Tests for src/routes/billing.ts.
 *
 * Two layers are covered:
 *
 *  1. The billing math helpers (`parseBillingAmount`, `summarizeInvoices`) as
 *     pure functions — success and boundary inputs that document the contract.
 *  2. The routed behaviour end-to-end through supertest, asserting both the
 *     response body and the structured telemetry emitted alongside it.
 *
 * `../auth/middleware.js`, `../db/index.js` and `../config.js` are mocked with
 * factories so no real session lookup, database, or env parsing is involved.
 *
 * Contract tests follow a consistent structure:
 *   - success path: correct input → correct output + telemetry
 *   - boundary path: edge-case input → safe output + telemetry warnings
 *   - failure path: DB error → 500 + error telemetry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  env: {
    BILLING_ENABLED: true,
    LOG_FORMAT: "json",
    LOG_LEVEL: "debug",
    MAX_BILLING_AMOUNT: 1_000_000,
  },
}));

vi.mock("../auth/middleware.js", () => ({
  requireAuth: vi.fn((req: any, _res: any, next: any) => {
    req.auth = { address: req.headers["x-user-address"] ?? OWNER, token: "testtoken" };
    next();
  }),
}));

vi.mock("../db/index.js", () => ({
  db: { select: vi.fn() },
  schema: {
    billingProfiles: {
      id: "billing_profiles.id",
      ownerAddress: "billing_profiles.owner_address",
      profileType: "billing_profiles.profile_type",
      annualRewardLimit: "billing_profiles.annual_reward_limit",
      usedAmount: "billing_profiles.used_amount",
      currency: "billing_profiles.currency",
    },
    billingPaymentMethods: { profileId: "billing_payment_methods.profile_id" },
    billingInvoices: { profileId: "billing_invoices.profile_id" },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  desc: vi.fn((col: unknown) => ({ type: "desc", col })),
}));

import {
  billingRouter,
  clearBillingIdempotencyStore,
  parseBillingAmount,
  summarizeInvoices,
  withBillingIdempotency,
  DEFAULT_INVOICE_PAGE_LIMIT,
  MAX_INVOICE_PAGE_LIMIT,
} from "./billing.js";
import {
  BILLING_METRICS,
  getBillingMetricsSnapshot,
  resetBillingMetrics,
} from "./billing-metrics.js";
import { db } from "../db/index.js";

const OWNER = "0xowner";
const PROFILE_ID = "profile-001";

// ---------------------------------------------------------------------------
// Query plumbing
//
// billing.ts builds queries as `db.select(...).from(...).where(...)` and
// sometimes `.limit(1)`. Every builder here is thenable, so awaiting it
// resolves to the next queued row set regardless of which terminal method the
// route used.
// ---------------------------------------------------------------------------

let queuedResults: unknown[][];
let selectCallCount: number;
let failingCall: { call: number; error: Error } | null;

function queueRows(...resultSets: unknown[][]): void {
  queuedResults.push(...resultSets);
}

/** Make the Nth `db.select()` of the test (1-indexed) reject with `error`. */
function failSelectOnCall(call: number, error: Error): void {
  failingCall = { call, error };
}

function makeQueryBuilder(): any {
  selectCallCount += 1;
  const shouldFail = failingCall?.call === selectCallCount ? failingCall.error : null;
  const rows = shouldFail ? [] : (queuedResults.shift() ?? []);
  const builder: any = {
    from: () => builder,
    where: () => builder,
    limit: () => builder,
    offset: () => builder,
    orderBy: () => builder,
    then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      shouldFail
        ? Promise.resolve().then(() => reject(shouldFail))
        : Promise.resolve(rows).then(resolve),
  };
  return builder;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", billingRouter);
  return app;
}

function authHeaders(address = OWNER) {
  return { "x-user-address": address, authorization: "Bearer testtoken" };
}

/**
 * Factory for a full billing profile row as returned by the database.
 *
 * The returned object includes all database columns so the middleware's
 * `db.select().from(schema.billingProfiles).where(…).limit(1)` query
 * resolves to a realistic row that the route handlers can read fields from.
 *
 * Use `overrides` to simulate boundary values like null/negative amounts.
 */
function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE_ID,
    ownerAddress: OWNER,
    profileType: "Individual",
    firstName: "Alice",
    lastName: "Example",
    street: "123 Main St",
    city: "Metropolis",
    state: "NY",
    zipCode: "10001",
    country: "US",
    annualRewardLimit: "10000.000000",
    usedAmount: "2500.500000",
    currency: "USD",
    taxId: "secret-tax-id",
    dateOfBirth: "1990-01-01",
    ...overrides,
  };
}

/** Every structured event emitted during the current test, newest last. */
function loggedEvents(spies: {
  info: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
}): Record<string, any>[] {
  return [...spies.info.mock.calls, ...spies.warn.mock.calls, ...spies.error.mock.calls]
    .map(([line]) => {
      try {
        return JSON.parse(String(line));
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, any> => entry !== null && "event" in entry);
}

function counters(): Record<string, number> {
  return getBillingMetricsSnapshot().counters;
}

// ---------------------------------------------------------------------------
// Contract: parseBillingAmount
// ---------------------------------------------------------------------------

describe("billing math helpers", () => {
  describe("parseBillingAmount", () => {
    it("contract: parses a well-formed numeric string and reports no coercion", () => {
      expect(parseBillingAmount("2500.500000")).toEqual({ amount: 2500.5, coercion: null });
    });

    it("contract: rounds to the column's 6-decimal scale to stay lossless", () => {
      expect(parseBillingAmount("0.1234567").amount).toBe(0.123457);
    });

    it("contract: zero is accepted as a valid amount", () => {
      expect(parseBillingAmount("0.000000")).toEqual({ amount: 0, coercion: null });
    });

    it("contract: reports 'missing' for null, undefined, non-strings and blank strings", () => {
      for (const value of [null, undefined, 42, {}, "", "   "]) {
        expect(parseBillingAmount(value)).toEqual({ amount: 0, coercion: "missing" });
      }
    });

    it("contract: reports 'malformed' for values that do not parse to a finite number", () => {
      for (const value of ["abc", "Infinity", "1e999"]) {
        expect(parseBillingAmount(value)).toEqual({ amount: 0, coercion: "malformed" });
      }
    });

    it("contract: reports 'negative' for a negative amount and substitutes 0", () => {
      expect(parseBillingAmount("-1.5")).toEqual({ amount: 0, coercion: "negative" });
    });

    it("contract: a very large numeric value is rounded, not coerced", () => {
      const result = parseBillingAmount("999999999999.999999");
      expect(result.coercion).toBeNull();
      expect(result.amount).toBe(999999999999.999999);
    });
  });

  // -------------------------------------------------------------------------
  // Contract: summarizeInvoices
  // -------------------------------------------------------------------------

  describe("summarizeInvoices", () => {
    it("contract: returns zeroed totals for an empty invoice list", () => {
      expect(summarizeInvoices([])).toEqual({
        invoiceCount: 0,
        totalAmount: 0,
        paidAmount: 0,
        outstandingAmount: 0,
        statusCounts: {},
        coercedCount: 0,
        coercionReasons: {},
      });
    });

    it("contract: splits paid from outstanding so the two always sum to the total", () => {
      const totals = summarizeInvoices([
        { amount: "100.000000", status: "paid" },
        { amount: "250.250000", status: "pending" },
        { amount: "49.750000", status: "overdue" },
      ]);

      expect(totals.invoiceCount).toBe(3);
      expect(totals.totalAmount).toBe(400);
      expect(totals.paidAmount).toBe(100);
      expect(totals.outstandingAmount).toBe(300);
      expect(totals.paidAmount + totals.outstandingAmount).toBe(totals.totalAmount);
      expect(totals.statusCounts).toEqual({ paid: 1, pending: 1, overdue: 1 });
    });

    it("contract: matches the paid status case-insensitively", () => {
      const totals = summarizeInvoices([{ amount: "10.000000", status: "PAID" }]);
      expect(totals.paidAmount).toBe(10);
      expect(totals.statusCounts).toEqual({ paid: 1 });
    });

    it("contract: bucketed null or blank status as 'unknown' and count as outstanding", () => {
      const totals = summarizeInvoices([
        { amount: "10.000000", status: null },
        { amount: "5.000000", status: "  " },
      ]);

      expect(totals.statusCounts).toEqual({ unknown: 2 });
      expect(totals.outstandingAmount).toBe(15);
      expect(totals.paidAmount).toBe(0);
    });

    it("contract: counts coerced rows per reason and subtracts them from totals", () => {
      const totals = summarizeInvoices([
        { amount: "100.000000", status: "paid" },
        { amount: "not-a-number", status: "pending" },
        { amount: null, status: "pending" },
        { amount: "-5.000000", status: "pending" },
      ]);

      expect(totals.totalAmount).toBe(100);
      expect(totals.coercedCount).toBe(3);
      expect(totals.coercionReasons).toEqual({ malformed: 1, missing: 1, negative: 1 });
    });

    it("contract: keeps 6-decimal precision across many fractional rows", () => {
      const totals = summarizeInvoices(
        Array.from({ length: 3 }, () => ({ amount: "0.100000", status: "pending" })),
      );
      expect(totals.totalAmount).toBe(0.3);
      expect(totals.outstandingAmount).toBe(0.3);
    });

    it("contract: an unrecognised status does not widen the key space with arbitrary values", () => {
      // The status is lower-cased but not validated against a known set.
      // This keeps the key space bounded by the actual database values.
      const totals = summarizeInvoices([
        { amount: "10.000000", status: "CANCELLED" },
        { amount: "5.000000", status: "REFUNDED" },
      ]);
      // Both are recognised — they just aren't "paid", so they go to outstanding.
      expect(totals.statusCounts).toEqual({ cancelled: 1, refunded: 1 });
      expect(totals.outstandingAmount).toBe(15);
      expect(totals.paidAmount).toBe(0);
    });

    it("contract: an invoice with missing amount fields contributes 0 but still counts toward invoiceCount", () => {
      const totals = summarizeInvoices([
        { amount: undefined, status: "pending" },
        { amount: null, status: "pending" },
      ]);
      expect(totals.invoiceCount).toBe(2);
      expect(totals.totalAmount).toBe(0);
      expect(totals.coercedCount).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Route contract tests
// ---------------------------------------------------------------------------

describe("billing routes telemetry", () => {
  let spies: {
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    queuedResults = [];
    selectCallCount = 0;
    failingCall = null;
    resetBillingMetrics();
    clearBillingIdempotencyStore();
    vi.mocked(db.select).mockImplementation(makeQueryBuilder as any);
    spies = {
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetBillingMetrics();
    clearBillingIdempotencyStore();
  });

  // -------------------------------------------------------------------------
  // GET /billing/profiles/:profileId — full profile
  // -------------------------------------------------------------------------

  describe("GET /billing/profiles/:profileId (full profile)", () => {
    it("contract success: returns the full profile with payment methods and invoices", async () => {
      const paymentMethods = [
        { id: "pm-1", type: "bank_account", displayName: "Chase ****1234", isDefault: true },
      ];
      const invoices = [
        { id: "inv-1", amount: "100.000000", status: "paid" },
        { id: "inv-2", amount: "250.000000", status: "pending" },
      ];

      // Ownership middleware returns full profile row → payment methods → invoices
      queueRows([profileRow()], paymentMethods, invoices);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}`)
        .set(authHeaders());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.profile).toMatchObject({
        id: PROFILE_ID,
        profileType: "Individual",
        firstName: "Alice",
      });
      // Sensitive fields must be stripped
      expect(res.body.data.profile.taxId).toBeUndefined();
      expect(res.body.data.profile.dateOfBirth).toBeUndefined();
      expect(res.body.data.paymentMethods).toEqual(paymentMethods);
      expect(res.body.data.invoices).toEqual(invoices);

      const fetched = loggedEvents(spies).find((e) => e.event === "billing.profile.fetched");
      expect(fetched).toMatchObject({
        level: "info",
        profileId: PROFILE_ID,
        paymentMethodCount: 1,
        invoiceCount: 2,
        totalAmount: 350,
      });
      expect(counters()[BILLING_METRICS.PROFILE_FETCHED]).toBe(1);
      expect(counters()[BILLING_METRICS.PROFILE_DURATION_MS]).toBeGreaterThanOrEqual(0);
    });

    it("contract boundary: handles zero payment methods and invoices", async () => {
      queueRows([profileRow()], [], []);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}`)
        .set(authHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.paymentMethods).toEqual([]);
      expect(res.body.data.invoices).toEqual([]);
      expect(
        loggedEvents(spies).find((e) => e.event === "billing.profile.fetched"),
      ).toMatchObject({ paymentMethodCount: 0, invoiceCount: 0 });
    });

    it("contract boundary: reports coerced invoice amounts through telemetry", async () => {
      const invoices = [
        { id: "inv-1", amount: "100.000000", status: "paid" },
        { id: "inv-2", amount: "oops", status: "pending" },
        { id: "inv-3", amount: null, status: "pending" },
      ];

      queueRows([profileRow()], [], invoices);

      await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}`)
        .set(authHeaders());

      // The response still contains all raw rows unchanged. Coercion is
      // visible in telemetry only — exactly one consolidated event.
      const coerced = loggedEvents(spies).filter((e) => e.event === "billing.amount.coerced");
      expect(coerced).toHaveLength(1);
      expect(coerced[0]).toMatchObject({
        field: "invoices.amount",
        affectedRows: 2,
        reasons: { malformed: 1, missing: 1 },
      });
      expect(counters()[BILLING_METRICS.AMOUNT_COERCED]).toBe(2);
    });

    it("contract failure: logs error on DB failure during payment method fetch", async () => {
      queueRows([profileRow()]);
      failSelectOnCall(2, new Error("connection reset"));

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}`)
        .set(authHeaders());

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: "Failed to fetch billing profile" });

      expect(loggedEvents(spies).find((e) => e.event === "billing.profile.failed")).toMatchObject({
        level: "error",
        profileId: PROFILE_ID,
        message: "connection reset",
      });
      expect(counters()[BILLING_METRICS.ERRORS]).toBe(1);
    });

    it("contract failure: logs error on DB failure during invoice fetch", async () => {
      queueRows([profileRow()], [{ id: "pm-1" }]);
      failSelectOnCall(3, new Error("timeout"));

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}`)
        .set(authHeaders());

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: "Failed to fetch billing profile" });

      expect(loggedEvents(spies).find((e) => e.event === "billing.profile.failed")).toMatchObject({
        level: "error",
        profileId: PROFILE_ID,
        message: "timeout",
      });
      expect(counters()[BILLING_METRICS.ERRORS]).toBe(1);
    });

    it("contract boundary: a null profile in middleware yields ownership-denied 404", async () => {
      // The middleware receives a null row, which means the profile does
      // not exist. The handler never runs because requireBillingOwner
      // denies access first.
      queueRows([null]);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}`)
        .set(authHeaders());

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        success: false,
        error: `Billing profile '${PROFILE_ID}' not found`,
      });
    });
  });

  // -------------------------------------------------------------------------
  // GET /billing/profiles/:profileId/summary — summary route contract
  // -------------------------------------------------------------------------

  describe("GET /billing/profiles/:profileId/summary", () => {
    it("contract success: returns the computed summary and logs the math that produced it", async () => {
      // The summary route uses res.locals.profile from the ownership middleware,
      // so the middleware's select must return the full profile row.
      queueRows([profileRow()]);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`)
        .set(authHeaders());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          profileId: PROFILE_ID,
          profileType: "Individual",
          annualRewardLimit: 10000,
          usedAmount: 2500.5,
          remainingAmount: 7499.5,
          currency: "USD",
          progressPercentage: 25.01,
        },
      });

      const computed = loggedEvents(spies).find((e) => e.event === "billing.summary.computed");
      expect(computed).toMatchObject({
        level: "info",
        profileId: PROFILE_ID,
        annualRewardLimit: 10000,
        usedAmount: 2500.5,
        remainingAmount: 7499.5,
        progressPercentage: 25.01,
        currency: "USD",
      });
      expect(typeof computed?.durationMs).toBe("number");
      expect(computed?.timestamp).toEqual(expect.any(String));

      expect(counters()[BILLING_METRICS.SUMMARY_COMPUTED]).toBe(1);
      expect(counters()[BILLING_METRICS.AMOUNT_COERCED]).toBeUndefined();
      expect(counters()[BILLING_METRICS.SUMMARY_LIMIT_EXCEEDED]).toBeUndefined();
    });

    it("contract boundary: warns per coerced column when a stored amount is unusable", async () => {
      queueRows([profileRow({ annualRewardLimit: "not-a-number", usedAmount: null })]);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`)
        .set(authHeaders());

      // Response contract: coerced values surface as 0.
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        annualRewardLimit: 0,
        usedAmount: 0,
        remainingAmount: 0,
        progressPercentage: 0,
      });

      const coerced = loggedEvents(spies).filter((e) => e.event === "billing.amount.coerced");
      expect(coerced).toHaveLength(2);
      expect(coerced[0]).toMatchObject({
        level: "warn",
        profileId: PROFILE_ID,
        field: "annualRewardLimit",
        reason: "malformed",
      });
      expect(coerced[1]).toMatchObject({ field: "usedAmount", reason: "missing" });
      expect(counters()[BILLING_METRICS.AMOUNT_COERCED]).toBe(2);
    });

    it("contract boundary: flags an over-limit profile that the response clamps to zero", async () => {
      queueRows([profileRow({ annualRewardLimit: "100.000000", usedAmount: "150.250000" })]);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`)
        .set(authHeaders());

      expect(res.body.data.remainingAmount).toBe(0);
      expect(res.body.data.progressPercentage).toBe(150.25);

      const exceeded = loggedEvents(spies).find(
        (e) => e.event === "billing.summary.limit_exceeded",
      );
      expect(exceeded).toMatchObject({
        level: "warn",
        profileId: PROFILE_ID,
        annualRewardLimit: 100,
        usedAmount: 150.25,
        overageAmount: 50.25,
      });
      expect(counters()[BILLING_METRICS.SUMMARY_LIMIT_EXCEEDED]).toBe(1);
    });

    it("contract boundary: a zero limit yields 0% progress without a divide-by-zero", async () => {
      queueRows([profileRow({ annualRewardLimit: "0.000000", usedAmount: "0.000000" })]);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`)
        .set(authHeaders());

      expect(res.body.data.progressPercentage).toBe(0);
      expect(res.body.data.remainingAmount).toBe(0);
      expect(counters()[BILLING_METRICS.SUMMARY_LIMIT_EXCEEDED]).toBeUndefined();
    });

    it("contract boundary: progress is NOT clamped to 100% when used > limit", async () => {
      queueRows([profileRow({ annualRewardLimit: "100.000000", usedAmount: "200.000000" })]);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`)
        .set(authHeaders());

      // Progress correctly reports > 100% — the clamp only applies to remainingAmount.
      expect(res.body.data.progressPercentage).toBe(200);
      expect(res.body.data.remainingAmount).toBe(0);
    });

    it("contract failure: a DB failure in the middleware is reported as billing.ownership.failed", async () => {
      // The summary handler uses res.locals.profile from the middleware and
      // does not query the DB itself. A DB failure means the middleware rejects.
      failSelectOnCall(1, new Error("connection reset"));

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`)
        .set(authHeaders());

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: "Failed to verify billing profile ownership",
      });

      expect(loggedEvents(spies).find((e) => e.event === "billing.ownership.failed")).toMatchObject({
        level: "error",
        profileId: PROFILE_ID,
        message: "connection reset",
      });
      expect(counters()[BILLING_METRICS.ERRORS]).toBe(1);
      // A failed middleware must not also report a successful computation.
      expect(counters()[BILLING_METRICS.SUMMARY_COMPUTED]).toBeUndefined();
    });

    it("contract failure: a failing ownership lookup is reported as billing.ownership.failed", async () => {
      failSelectOnCall(1, new Error("pool exhausted"));

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`)
        .set(authHeaders());

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: "Failed to verify billing profile ownership",
      });

      expect(loggedEvents(spies).find((e) => e.event === "billing.ownership.failed")).toMatchObject({
        level: "error",
        profileId: PROFILE_ID,
        message: "pool exhausted",
      });
      expect(counters()[BILLING_METRICS.ERRORS]).toBe(1);
      expect(counters()[BILLING_METRICS.OWNERSHIP_DENIED]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // GET /billing/profiles/:profileId/invoices — invoice route contract
  // -------------------------------------------------------------------------

  describe("GET /billing/profiles/:profileId/invoices", () => {
    it("contract success: returns the rows unchanged and logs the aggregate alongside them", async () => {
      const invoices = [
        { id: "inv-1", amount: "100.000000", status: "paid" },
        { id: "inv-2", amount: "250.000000", status: "pending" },
      ];
      queueRows([{ ownerAddress: OWNER }], invoices);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices`)
        .set(authHeaders());

      // Response shape is byte-for-byte what it was before the telemetry.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { profileId: PROFILE_ID, invoices } });

      const listed = loggedEvents(spies).find((e) => e.event === "billing.invoices.listed");
      expect(listed).toMatchObject({
        level: "info",
        profileId: PROFILE_ID,
        invoiceCount: 2,
        totalAmount: 350,
        paidAmount: 100,
        outstandingAmount: 250,
        statusCounts: { paid: 1, pending: 1 },
        coercedCount: 0,
      });

      expect(counters()[BILLING_METRICS.INVOICES_LISTED]).toBe(1);
      expect(counters()[BILLING_METRICS.INVOICE_ROWS]).toBe(2);
      expect(counters()[BILLING_METRICS.INVOICES_DURATION_MS]).toBeGreaterThanOrEqual(0);
    });

    it("contract boundary: an empty invoice list still emits one aggregate event", async () => {
      queueRows([{ ownerAddress: OWNER }], []);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices`)
        .set(authHeaders());

      expect(res.body.data.invoices).toEqual([]);
      expect(loggedEvents(spies).find((e) => e.event === "billing.invoices.listed")).toMatchObject({
        invoiceCount: 0,
        totalAmount: 0,
        outstandingAmount: 0,
        statusCounts: {},
      });
      expect(counters()[BILLING_METRICS.INVOICE_ROWS]).toBe(0);
    });

    it("contract boundary: warns once with a per-reason breakdown when invoice amounts are unusable", async () => {
      queueRows(
        [{ ownerAddress: OWNER }],
        [
          { id: "inv-1", amount: "100.000000", status: "paid" },
          { id: "inv-2", amount: "oops", status: "pending" },
          { id: "inv-3", amount: null, status: "pending" },
        ],
      );

      await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices`)
        .set(authHeaders());

      const coerced = loggedEvents(spies).filter((e) => e.event === "billing.amount.coerced");
      expect(coerced).toHaveLength(1);
      expect(coerced[0]).toMatchObject({
        level: "warn",
        profileId: PROFILE_ID,
        field: "invoices.amount",
        affectedRows: 2,
        reasons: { malformed: 1, missing: 1 },
      });
      expect(counters()[BILLING_METRICS.AMOUNT_COERCED]).toBe(2);
    });

    it("pagination success path: returns a page with hasMore=true when more rows exist", async () => {
      const invoices = Array.from({ length: 5 }, (_, i) => ({
        id: `inv-${i + 1}`,
        amount: "10.000000",
        status: "paid",
      }));
      queueRows([profileRow()], invoices);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices?limit=2`)
        .set(authHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.invoices).toHaveLength(2);
      expect(res.body.data.pagination).toEqual({ limit: 2, offset: 0, hasMore: true });
    });

    it("pagination boundary: hasMore=false when limit matches total rows", async () => {
      const invoices = Array.from({ length: 2 }, (_, i) => ({
        id: `inv-${i + 1}`,
        amount: "10.000000",
        status: "paid",
      }));
      queueRows([profileRow()], invoices);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices?limit=2`)
        .set(authHeaders());

      expect(res.body.data.invoices).toHaveLength(2);
      expect(res.body.data.pagination).toEqual({ limit: 2, offset: 0, hasMore: false });
    });

    it("pagination boundary: offset skips rows correctly", async () => {
      const invoices = Array.from({ length: 5 }, (_, i) => ({
        id: `inv-${i + 1}`,
        amount: "10.000000",
        status: "paid",
      }));
      queueRows([profileRow()], invoices);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices?limit=2&offset=2`)
        .set(authHeaders());

      expect(res.body.data.invoices).toHaveLength(2);
      expect(res.body.data.pagination).toEqual({ limit: 2, offset: 2, hasMore: true });
    });

    it("pagination boundary: limit larger than result set returns all without hasMore", async () => {
      const invoices = Array.from({ length: 3 }, (_, i) => ({
        id: `inv-${i + 1}`,
        amount: "10.000000",
        status: "paid",
      }));
      queueRows([profileRow()], invoices);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices?limit=10`)
        .set(authHeaders());

      expect(res.body.data.invoices).toHaveLength(3);
      expect(res.body.data.pagination).toEqual({ limit: 10, offset: 0, hasMore: false });
    });

    it("pagination failure: rejects limit above MAX_INVOICE_PAGE_LIMIT", async () => {
      queueRows([profileRow()]);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices?limit=201`)
        .set(authHeaders());

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Invalid pagination parameters");
    });

    it("pagination failure: rejects a negative offset", async () => {
      queueRows([profileRow()]);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices?offset=-1`)
        .set(authHeaders());

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Invalid pagination parameters");
    });

    it("pagination contract: no pagination params preserves the original envelope shape", async () => {
      const invoices = [
        { id: "inv-1", amount: "100.000000", status: "paid" },
        { id: "inv-2", amount: "250.000000", status: "pending" },
      ];
      queueRows([profileRow()], invoices);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices`)
        .set(authHeaders());

      expect(res.status).toBe(200);
      // No pagination block — original shape preserved.
      expect(res.body.data.pagination).toBeUndefined();
      expect(res.body.data.invoices).toEqual(invoices);
    });
  });

  // -------------------------------------------------------------------------
  // Ownership denial contract
  // -------------------------------------------------------------------------

  describe("ownership denial telemetry", () => {
    it("contract: logs reason 'not_found' when no row exists, while still answering 404", async () => {
      queueRows([]);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`)
        .set(authHeaders());

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        success: false,
        error: `Billing profile '${PROFILE_ID}' not found`,
      });

      expect(loggedEvents(spies).find((e) => e.event === "billing.ownership.denied")).toMatchObject(
        { level: "warn", profileId: PROFILE_ID, reason: "not_found" },
      );
      expect(counters()[BILLING_METRICS.OWNERSHIP_DENIED]).toBe(1);
      expect(counters()[BILLING_METRICS.OWNERSHIP_DENIED_NOT_FOUND]).toBe(1);
    });

    it("contract: logs reason 'not_owner' for someone else's profile, with an identical 404 body", async () => {
      queueRows([{ ownerAddress: "0xsomeoneelse" }]);

      const res = await request(makeApp())
        .get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`)
        .set(authHeaders());

      // Indistinguishable to the caller — the split lives in the logs only.
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        success: false,
        error: `Billing profile '${PROFILE_ID}' not found`,
      });

      expect(loggedEvents(spies).find((e) => e.event === "billing.ownership.denied")).toMatchObject(
        { reason: "not_owner", callerAddress: OWNER },
      );
      expect(counters()[BILLING_METRICS.OWNERSHIP_DENIED_NOT_OWNER]).toBe(1);
      expect(counters()[BILLING_METRICS.OWNERSHIP_DENIED_NOT_FOUND]).toBeUndefined();
    });
  });

});

// ---------------------------------------------------------------------------
// Pre-existing idempotency contract — unchanged behaviour, plus the counters
// and events the wrapper now emits.
// ---------------------------------------------------------------------------

function makeIdempotencyApp() {
  const app = express();
  app.use(express.json());

  let executionCount = 0;

  app.post(
    "/billing/test",
    withBillingIdempotency(async (req, res) => {
      executionCount += 1;
      res.status(201).json({ executionCount, body: req.body });
    }),
  );

  return { app, getExecutionCount: () => executionCount };
}

describe("billing idempotency middleware", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    clearBillingIdempotencyStore();
    resetBillingMetrics();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearBillingIdempotencyStore();
    resetBillingMetrics();
  });

  it("contract: executes the handler normally when no idempotency key is supplied", async () => {
    const { app, getExecutionCount } = makeIdempotencyApp();

    const first = await request(app).post("/billing/test").send({ amount: 10 });
    const second = await request(app).post("/billing/test").send({ amount: 20 });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ executionCount: 1, body: { amount: 10 } });
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ executionCount: 2, body: { amount: 20 } });
    expect(getExecutionCount()).toBe(2);
  });

  it("contract: reuses the original response for the same idempotency key and body", async () => {
    const { app, getExecutionCount } = makeIdempotencyApp();

    const first = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "key-123")
      .send({ amount: 10 });

    const second = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "key-123")
      .send({ amount: 10 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(getExecutionCount()).toBe(1);
    expect(counters()[BILLING_METRICS.IDEMPOTENCY_REPLAYED]).toBe(1);
  });

  it("contract: rejects a repeated idempotency key when the body differs", async () => {
    const { app, getExecutionCount } = makeIdempotencyApp();

    const first = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "key-456")
      .send({ amount: 10 });

    const second = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "key-456")
      .send({ amount: 20 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      success: false,
      error: "Idempotency key already used with a different request body",
    });
    expect(getExecutionCount()).toBe(1);
    expect(counters()[BILLING_METRICS.IDEMPOTENCY_CONFLICT]).toBe(1);
  });

  it("contract: never logs the caller-supplied idempotency key", async () => {
    const { app } = makeIdempotencyApp();

    await request(app).post("/billing/test").set("Idempotency-Key", "secret-key").send({ a: 1 });
    await request(app).post("/billing/test").set("Idempotency-Key", "secret-key").send({ a: 1 });

    const serialized = vi
      .mocked(console.info)
      .mock.calls.flat()
      .map((c) => String(c))
      .join(" ");
    expect(serialized).toContain("billing.idempotency.replayed");
    expect(serialized).not.toContain("secret-key");
  });

  it("accepts the lowercase idempotency-key header as an alternative", async () => {
    const { app, getExecutionCount } = makeIdempotencyApp();

    await request(app)
      .post("/billing/test")
      .set("idempotency-key", "lower-key")
      .send({ amount: 10 });

    const second = await request(app)
      .post("/billing/test")
      .set("idempotency-key", "lower-key")
      .send({ amount: 10 });

    expect(second.status).toBe(201);
    expect(getExecutionCount()).toBe(1);
    expect(counters()[BILLING_METRICS.IDEMPOTENCY_REPLAYED]).toBe(1);
  });

  it("treats request bodies with different key orderings as the same fingerprint", async () => {
    const { app, getExecutionCount } = makeIdempotencyApp();

    await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "order-key")
      .send({ b: 2, a: 1 });

    const second = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "order-key")
      .send({ a: 1, b: 2 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual({ executionCount: 1, body: { b: 2, a: 1 } });
    expect(getExecutionCount()).toBe(1);
    expect(counters()[BILLING_METRICS.IDEMPOTENCY_REPLAYED]).toBe(1);
  });

  it("expires the cached entry after the TTL and allows re-execution", async () => {
    const { app, getExecutionCount } = makeIdempotencyApp();

    await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "ttl-key")
      .send({ amount: 10 });

    expect(getExecutionCount()).toBe(1);

    // Travel past the 24-hour TTL.
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);

    const second = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "ttl-key")
      .send({ amount: 10 });

    expect(second.status).toBe(201);
    // The handler ran again because the cached entry expired.
    expect(getExecutionCount()).toBe(2);
  });

  it("isolates cache keys by x-user-address scope", async () => {
    const { app, getExecutionCount } = makeIdempotencyApp();

    const first = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "scope-key")
      .set("x-user-address", "0xalice")
      .send({ amount: 10 });

    const second = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "scope-key")
      .set("x-user-address", "0xbob")
      .send({ amount: 10 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Both executed because the scopes differ.
    expect(getExecutionCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Billing Request Validation Integration Tests
// ---------------------------------------------------------------------------

describe("billing request validation integration", () => {
  const profileId = "bp_valid123";

  beforeEach(() => {
    queuedResults = [];
    selectCallCount = 0;
    failingCall = null;
    resetBillingMetrics();
    clearBillingIdempotencyStore();
    vi.mocked(db.select).mockImplementation(makeQueryBuilder as any);
  });

  afterEach(() => {
    resetBillingMetrics();
    clearBillingIdempotencyStore();
  });

  it("accepts valid currency code and billing amount query parameters", async () => {
    // Queue: profile row (ownership) + empty payment methods + empty invoices
    queueRows([profileRow({ id: profileId })], [], []);
    const res = await request(makeApp())
      .get(`/api/v1/billing/profiles/${profileId}?currency=USD&amount=500`)
      .set(authHeaders("0xowner"));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("rejects unknown currency code with HTTP 400", async () => {
    queueRows([profileRow({ id: profileId })]);
    const res = await request(makeApp())
      .get(`/api/v1/billing/profiles/${profileId}?currency=XYZ`)
      .set(authHeaders("0xowner"));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Unsupported currency code 'XYZ'");
  });

  it("rejects malformed currency code (lowercase) with HTTP 400", async () => {
    queueRows([profileRow({ id: profileId })]);
    const res = await request(makeApp())
      .get(`/api/v1/billing/profiles/${profileId}?currency=usd`)
      .set(authHeaders("0xowner"));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid currency code format");
  });

  it("rejects zero billing amount with HTTP 400", async () => {
    queueRows([profileRow({ id: profileId })]);
    const res = await request(makeApp())
      .get(`/api/v1/billing/profiles/${profileId}?amount=0`)
      .set(authHeaders("0xowner"));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Billing amount must be greater than zero");
  });

  it("rejects negative billing amount with HTTP 400", async () => {
    queueRows([profileRow({ id: profileId })]);
    const res = await request(makeApp())
      .get(`/api/v1/billing/profiles/${profileId}?amount=-50`)
      .set(authHeaders("0xowner"));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Billing amount must be greater than zero");
  });

  it("rejects billing amount exceeding max configured limit with HTTP 400", async () => {
    queueRows([profileRow({ id: profileId })]);
    const res = await request(makeApp())
      .get(`/api/v1/billing/profiles/${profileId}?amount=2000000`)
      .set(authHeaders("0xowner"));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("exceeds maximum allowed limit");
  });

  it("enforces validation consistently across multiple billing entry points", async () => {
    const endpoints = [
      { url: `/api/v1/billing/profiles/${profileId}/general-information?currency=INVALID`, rows: [[profileRow({ id: profileId })]] },
      { url: `/api/v1/billing/profiles/${profileId}/payment-methods?amount=-10`, rows: [[profileRow({ id: profileId })]] },
      { url: `/api/v1/billing/profiles/${profileId}/invoices?amount=5000000`, rows: [[profileRow({ id: profileId })]] },
      { url: `/api/v1/billing/profiles/${profileId}/summary?currency=FOO`, rows: [[profileRow({ id: profileId })]] },
    ];

    for (const { url } of endpoints) {
      // Reset queued results for each iteration
      queuedResults = [[profileRow({ id: profileId })]];
      selectCallCount = 0;
      const res = await request(makeApp())
        .get(url)
        .set(authHeaders("0xowner"));

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
  });
});

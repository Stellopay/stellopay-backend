/**
 * billing.test.ts
 *
 * Backward-compatible contract tests for src/routes/billing.ts  (issue #304).
 *
 * Coverage:
 *   1. Feature-flag gate        – 501 when BILLING_ENABLED=false
 *   2. profileId validation     – 400 on invalid shapes
 *   3. Full profile endpoint    – success, sensitive-field redaction, 404, 500
 *   4. General-information      – fullAddress assembly, redaction, 404, 500
 *   5. Payment-methods          – success, empty list, 404, 500
 *   6. Invoices                 – success, empty list, 404, 500
 *   7. Summary / billing math   – remainingAmount, progressPercentage, all boundary cases
 *   8. Response envelope        – { success, data } vs { success, error } invariant
 *   9. Pure helpers             – computeBillingSummary, buildFullAddress unit tests
 */

import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before any import that transitively reads them
// ---------------------------------------------------------------------------
const { envMock, dbMock, schemaMock } = vi.hoisted(() => {
  function makeChain(result: unknown[]) {
    const chain: Record<string, unknown> & { then: Function } = {
      select: vi.fn(() => chain),
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  }

  const dbMock = { select: vi.fn(() => makeChain([])) };

  const schemaMock = {
    billingProfiles: {
      id: "id",
      profileType: "profileType",
      annualRewardLimit: "annualRewardLimit",
      usedAmount: "usedAmount",
      currency: "currency",
    },
    billingPaymentMethods: { profileId: "profileId" },
    billingInvoices: { profileId: "profileId" },
  };

  const envMock = { BILLING_ENABLED: true as boolean };

  return { envMock, dbMock, schemaMock };
});

vi.mock("../config.js", () => ({ env: envMock }));
vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn((col: unknown, val: unknown) => ({ col, val })) }));

import { billingRouter, computeBillingSummary, buildFullAddress } from "./billing.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE_ID = "profile-abc-123";

const BASE_PROFILE = {
  id: PROFILE_ID,
  ownerAddress: "0xdeadbeef",
  profileType: "Individual",
  annualRewardLimit: "1000.000000",
  usedAmount: "250.000000",
  currency: "USD",
  firstName: "Alice",
  lastName: "Liddell",
  email: "alice@example.com",
  phone: null,
  street: "123 Main St",
  city: "Wonderland",
  state: "WL",
  zipCode: "00001",
  country: "US",
  taxId: "123-45-6789",      // sensitive — must never appear in responses
  taxResidency: "US",
  dateOfBirth: "1990-01-01", // sensitive — must never appear in responses
  companyName: null,
  vatNumber: null,
  businessType: null,
  occupation: "Engineer",
  website: null,
  notes: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-06-01T00:00:00Z"),
};

const PAYMENT_METHOD = {
  id: "pm-1",
  profileId: PROFILE_ID,
  type: "bank_account",
  displayName: "Chase ****1234",
  maskedAccount: "****1234",
  maskedRouting: "****5678",
  email: null,
  isDefault: true,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

const INVOICE = {
  id: "inv-1",
  profileId: PROFILE_ID,
  invoiceNumber: "INV-2024-001",
  amount: "500.000000",
  currency: "USD",
  status: "paid",
  description: "Monthly retainer",
  issuedAt: new Date("2024-05-01T00:00:00Z"),
  paidAt: new Date("2024-05-05T00:00:00Z"),
  createdAt: new Date("2024-05-01T00:00:00Z"),
  updatedAt: new Date("2024-05-05T00:00:00Z"),
};

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", billingRouter);
  return app;
}

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

function mockSelectSequence(...sequences: unknown[][]) {
  let call = 0;
  dbMock.select.mockImplementation(() => {
    const result = sequences[call] ?? [];
    call++;
    const chain: Record<string, unknown> & { then: Function } = {
      select: vi.fn(() => chain),
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      then: (resolve: Function, reject?: Function) =>
        Promise.resolve(result).then(resolve as any, reject as any),
    };
    return chain;
  });
}

function mockSelectThrows(err: Error) {
  dbMock.select.mockImplementation(() => { throw err; });
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.BILLING_ENABLED = true;
});

// ===========================================================================
// 1. Feature-flag gate
// ===========================================================================

describe("BILLING_ENABLED feature flag", () => {
  it("returns 501 on every billing route when the flag is false", async () => {
    envMock.BILLING_ENABLED = false;
    const app = makeApp();
    const paths = [
      `/api/v1/billing/profiles/${PROFILE_ID}`,
      `/api/v1/billing/profiles/${PROFILE_ID}/general-information`,
      `/api/v1/billing/profiles/${PROFILE_ID}/payment-methods`,
      `/api/v1/billing/profiles/${PROFILE_ID}/invoices`,
      `/api/v1/billing/profiles/${PROFILE_ID}/summary`,
    ];
    for (const path of paths) {
      const res = await request(app).get(path);
      expect(res.status, `expected 501 for ${path}`).toBe(501);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/BILLING_ENABLED/i);
    }
  });

  it("passes through when the flag is true", async () => {
    mockSelectSequence([BASE_PROFILE], [], []);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}`);
    expect(res.status).not.toBe(501);
  });
});

// ===========================================================================
// 2. profileId validation
// ===========================================================================

describe("profileId validation", () => {
  it("rejects a profileId longer than 128 chars with 400", async () => {
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${"a".repeat(129)}/summary`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid profileId/i);
  });

  it("rejects profileIds containing dots with 400", async () => {
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/foo.bar/summary`);
    expect(res.status).toBe(400);
  });

  it("accepts alphanumeric-and-dash profileIds", async () => {
    mockSelectSequence([{ ...BASE_PROFILE, id: "valid-id-123" }]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/valid-id-123/summary`);
    expect(res.status).not.toBe(400);
  });
});

// ===========================================================================
// 3. GET /billing/profiles/:profileId
// ===========================================================================

describe("GET /billing/profiles/:profileId", () => {
  it("returns 200 with profile, paymentMethods, and invoices", async () => {
    mockSelectSequence([BASE_PROFILE], [PAYMENT_METHOD], [INVOICE]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.profile.id).toBe(PROFILE_ID);
    expect(res.body.data.paymentMethods).toHaveLength(1);
    expect(res.body.data.invoices).toHaveLength(1);
  });

  it("never exposes taxId", async () => {
    mockSelectSequence([BASE_PROFILE], [], []);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}`);
    expect(res.body.data.profile).not.toHaveProperty("taxId");
  });

  it("never exposes dateOfBirth", async () => {
    mockSelectSequence([BASE_PROFILE], [], []);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}`);
    expect(res.body.data.profile).not.toHaveProperty("dateOfBirth");
  });

  it("returns 404 when profile not found", async () => {
    mockSelectSequence([]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/unknown-id`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 500 without leaking error details on db throw", async () => {
    mockSelectThrows(new Error("connection refused"));
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to fetch billing profile");
    expect(JSON.stringify(res.body)).not.toContain("connection refused");
  });
});

// ===========================================================================
// 4. GET /billing/profiles/:profileId/general-information
// ===========================================================================

describe("GET /billing/profiles/:profileId/general-information", () => {
  it("returns fullAddress joining all present parts", async () => {
    mockSelectSequence([BASE_PROFILE]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/general-information`);
    expect(res.status).toBe(200);
    expect(res.body.data.fullAddress).toBe("123 Main St, Wonderland, WL, 00001, US");
  });

  it("sets fullAddress to null when all address parts are absent", async () => {
    mockSelectSequence([{ ...BASE_PROFILE, street: null, city: null, state: null, zipCode: null, country: null }]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/general-information`);
    expect(res.body.data.fullAddress).toBeNull();
  });

  it("builds fullAddress from only present parts", async () => {
    mockSelectSequence([{ ...BASE_PROFILE, street: null, city: "London", state: null, zipCode: null, country: "UK" }]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/general-information`);
    expect(res.body.data.fullAddress).toBe("London, UK");
  });

  it("never exposes taxId", async () => {
    mockSelectSequence([BASE_PROFILE]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/general-information`);
    expect(res.body.data).not.toHaveProperty("taxId");
  });

  it("never exposes dateOfBirth", async () => {
    mockSelectSequence([BASE_PROFILE]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/general-information`);
    expect(res.body.data).not.toHaveProperty("dateOfBirth");
  });

  it("returns 404 for unknown profileId", async () => {
    mockSelectSequence([]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/ghost/general-information`);
    expect(res.status).toBe(404);
  });

  it("returns 500 on db error", async () => {
    mockSelectThrows(new Error("db fail"));
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/general-information`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to fetch general information");
  });
});

// ===========================================================================
// 5. GET /billing/profiles/:profileId/payment-methods
// ===========================================================================

describe("GET /billing/profiles/:profileId/payment-methods", () => {
  it("returns 200 with profileId and paymentMethods array", async () => {
    mockSelectSequence([{ id: PROFILE_ID }], [PAYMENT_METHOD]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/payment-methods`);
    expect(res.status).toBe(200);
    expect(res.body.data.profileId).toBe(PROFILE_ID);
    expect(res.body.data.paymentMethods).toHaveLength(1);
    expect(res.body.data.paymentMethods[0].maskedAccount).toBe("****1234");
  });

  it("returns empty array when no payment methods exist", async () => {
    mockSelectSequence([{ id: PROFILE_ID }], []);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/payment-methods`);
    expect(res.status).toBe(200);
    expect(res.body.data.paymentMethods).toHaveLength(0);
  });

  it("returns 404 when profile does not exist", async () => {
    mockSelectSequence([]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/no-such-id/payment-methods`);
    expect(res.status).toBe(404);
  });

  it("returns 500 on db error", async () => {
    mockSelectThrows(new Error("pool exhausted"));
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/payment-methods`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to fetch payment methods");
  });
});

// ===========================================================================
// 6. GET /billing/profiles/:profileId/invoices
// ===========================================================================

describe("GET /billing/profiles/:profileId/invoices", () => {
  it("returns 200 with profileId and invoices array", async () => {
    mockSelectSequence([{ id: PROFILE_ID }], [INVOICE]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.data.invoices).toHaveLength(1);
    expect(res.body.data.invoices[0].invoiceNumber).toBe("INV-2024-001");
    expect(res.body.data.invoices[0].status).toBe("paid");
  });

  it("returns empty invoices array when none exist", async () => {
    mockSelectSequence([{ id: PROFILE_ID }], []);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.data.invoices).toHaveLength(0);
  });

  it("returns 404 when profile does not exist", async () => {
    mockSelectSequence([]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/no-such-id/invoices`);
    expect(res.status).toBe(404);
  });

  it("returns 500 on db error", async () => {
    mockSelectThrows(new Error("timeout"));
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/invoices`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to fetch invoices");
  });
});

// ===========================================================================
// 7. GET /billing/profiles/:profileId/summary — billing math
// ===========================================================================

describe("GET /billing/profiles/:profileId/summary – billing math", () => {
  function summaryRow(o: { annualRewardLimit?: string; usedAmount?: string }) {
    return { id: PROFILE_ID, profileType: "Individual", currency: "USD",
      annualRewardLimit: o.annualRewardLimit ?? "1000.000000",
      usedAmount: o.usedAmount ?? "250.000000" };
  }

  it("returns correct remainingAmount = limit − used", async () => {
    mockSelectSequence([summaryRow({ annualRewardLimit: "1000.000000", usedAmount: "250.000000" })]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.data.remainingAmount).toBe(750);
  });

  it("clamps remainingAmount to 0 when used > limit", async () => {
    mockSelectSequence([summaryRow({ annualRewardLimit: "500.000000", usedAmount: "600.000000" })]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`);
    expect(res.body.data.remainingAmount).toBe(0);
  });

  it("remainingAmount is 0 when used equals limit exactly", async () => {
    mockSelectSequence([summaryRow({ annualRewardLimit: "1000.000000", usedAmount: "1000.000000" })]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`);
    expect(res.body.data.remainingAmount).toBe(0);
  });

  it("progressPercentage is 0 when limit is 0 (no divide-by-zero)", async () => {
    mockSelectSequence([summaryRow({ annualRewardLimit: "0", usedAmount: "0" })]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`);
    expect(res.body.data.progressPercentage).toBe(0);
  });

  it("progressPercentage rounds to 2 decimal places (1/3 → 33.33)", async () => {
    mockSelectSequence([summaryRow({ annualRewardLimit: "3.000000", usedAmount: "1.000000" })]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`);
    expect(res.body.data.progressPercentage).toBe(33.33);
  });

  it("progressPercentage is 100 when fully used", async () => {
    mockSelectSequence([summaryRow({ annualRewardLimit: "500.000000", usedAmount: "500.000000" })]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`);
    expect(res.body.data.progressPercentage).toBe(100);
  });

  it("progressPercentage can exceed 100 when over-limit", async () => {
    mockSelectSequence([summaryRow({ annualRewardLimit: "500.000000", usedAmount: "600.000000" })]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`);
    expect(res.body.data.progressPercentage).toBe(120);
  });

  it("returns all required summary fields", async () => {
    mockSelectSequence([summaryRow({})]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`);
    const d = res.body.data;
    for (const key of ["profileId","profileType","annualRewardLimit","usedAmount","remainingAmount","currency","progressPercentage"]) {
      expect(d).toHaveProperty(key);
    }
  });

  it("returns 404 when profile does not exist", async () => {
    mockSelectSequence([]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/ghost/summary`);
    expect(res.status).toBe(404);
  });

  it("returns 500 without leaking details on db error", async () => {
    mockSelectThrows(new Error("ssl handshake failed"));
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}/summary`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to fetch billing summary");
    expect(JSON.stringify(res.body)).not.toContain("ssl handshake failed");
  });
});

// ===========================================================================
// 8. Response envelope contract
// ===========================================================================

describe("Response envelope contract", () => {
  it("success responses carry { success: true, data } and no error key", async () => {
    mockSelectSequence([BASE_PROFILE], [], []);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/${PROFILE_ID}`);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body).toHaveProperty("data");
    expect(res.body).not.toHaveProperty("error");
  });

  it("error responses carry { success: false, error } and no data key", async () => {
    mockSelectSequence([]);
    const res = await request(makeApp()).get(`/api/v1/billing/profiles/nobody/summary`);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body).toHaveProperty("error");
    expect(res.body).not.toHaveProperty("data");
  });
});

// ===========================================================================
// 9. Pure helper unit tests
// ===========================================================================

describe("computeBillingSummary (pure unit tests)", () => {
  it("normal case: limit=1000, used=250", () => {
    const r = computeBillingSummary("1000.000000", "250.000000");
    expect(r.remainingAmount).toBe(750);
    expect(r.progressPercentage).toBe(25);
  });

  it("zero limit: no divide-by-zero, progressPercentage=0", () => {
    const r = computeBillingSummary("0", "0");
    expect(r.remainingAmount).toBe(0);
    expect(r.progressPercentage).toBe(0);
  });

  it("null inputs treated as 0", () => {
    const r = computeBillingSummary(null, null);
    expect(r.limit).toBe(0);
    expect(r.used).toBe(0);
    expect(r.remainingAmount).toBe(0);
    expect(r.progressPercentage).toBe(0);
  });

  it("over-limit: remainingAmount=0, progressPercentage=120", () => {
    const r = computeBillingSummary("500.000000", "600.000000");
    expect(r.remainingAmount).toBe(0);
    expect(r.progressPercentage).toBe(120);
  });

  it("rounds progressPercentage to 2dp", () => {
    expect(computeBillingSummary("3.000000", "1.000000").progressPercentage).toBe(33.33);
  });
});

describe("buildFullAddress (pure unit tests)", () => {
  it("joins all parts in order", () => {
    expect(buildFullAddress("123 Main St", "Springfield", "IL", "62701", "US"))
      .toBe("123 Main St, Springfield, IL, 62701, US");
  });

  it("returns null when all parts are null", () => {
    expect(buildFullAddress(null, null, null, null, null)).toBeNull();
  });

  it("skips null parts", () => {
    expect(buildFullAddress(null, "London", null, null, "UK")).toBe("London, UK");
  });

  it("returns single part with no trailing comma", () => {
    expect(buildFullAddress(null, "Paris", null, null, null)).toBe("Paris");
  });
});

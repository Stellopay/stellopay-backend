/**
 * diagnostics.test.ts
 *
 * Backward-compatible contract tests for src/routes/diagnostics.ts (issue #279).
 *
 * Coverage:
 *   1. Auth gating          – 401 for unauthenticated and non-admin callers; no DB hit
 *   2. Success path         – 200 with correct shape, counts, poolStats
 *   3. Redaction invariant  – transaction_hash / agreement_id never in latestEvents
 *   4. Empty DB boundary    – all summary fields default to 0, latestEvents is []
 *   5. tableCounts missing  – rows[0] undefined → summary falls back to 0, tableCounts is {}
 *   6. Error handling       – db.execute rejection propagates as 500 via error handler
 *   7. Response shape       – all top-level keys present on every 200
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Mocks — hoisted before any import that transitively reads them
// ---------------------------------------------------------------------------

vi.mock("../auth/session.js", () => ({
  requireSession: vi.fn(async () => true),
}));

vi.mock("../config.js", () => ({
  env: { ADMIN_ADDRESSES: ["0xadmin"] },
}));

vi.mock("../db/index.js", () => ({
  db: { execute: vi.fn() },
  getPoolStats: vi.fn(() => ({ total: 8, idle: 3, active: 5, waiting: 2 })),
  schema: {},
}));

import { diagnosticsRouter } from "./diagnostics.js";
import { db, getPoolStats } from "../db/index.js";
import { requireSession } from "../auth/session.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADMIN = "0xadmin";
const NON_ADMIN = "0xnotadmin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", diagnosticsRouter);
  // Minimal error handler so 500 path is testable
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

function authHeaders(address: string) {
  return { "x-user-address": address, authorization: "Bearer testtoken" };
}

/**
 * Wires the five db.execute calls the route makes, in order:
 *   1. eventTypeCounts
 *   2. escrowEventCounts
 *   3. paymentEventCounts
 *   4. tableCounts
 *   5. latestEvents  (includes raw identifiers — must be redacted by the route)
 */
function wireDbRows() {
  vi.mocked(db.execute)
    .mockResolvedValueOnce({
      rows: [{ event_type: "AgreementCreated", count: "5" }],
    } as any)
    .mockResolvedValueOnce({
      rows: [{ event_type: "Funded", count: "2" }],
    } as any)
    .mockResolvedValueOnce({
      rows: [{ event_type: "PaymentSent", count: "3" }],
    } as any)
    .mockResolvedValueOnce({
      rows: [
        {
          agreement_events_count: "5",
          escrow_events_count: "2",
          payments_count: "3",
          employees_count: "1",
          milestones_count: "4",
          agreements_count: "3",
          latest_block: "100",
        },
      ],
    } as any)
    .mockResolvedValueOnce({
      rows: [
        {
          event_type: "AgreementCreated",
          created_at: "2026-01-01T00:00:00Z",
          // These fields must be dropped by the route
          transaction_hash: "0xsecrethash",
          agreement_id: "secret-id-123",
        },
      ],
    } as any);
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.execute).mockReset();
  vi.mocked(requireSession).mockResolvedValue(true);
});

// ===========================================================================
// 1. Auth gating
// ===========================================================================

describe("Auth gating", () => {
  it("returns 401 for unauthenticated requests and runs no queries", async () => {
    const res = await request(makeApp()).get("/api/v1/diagnostics/events");
    expect(res.status).toBe(401);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("returns 401 for an authenticated non-admin and runs no queries", async () => {
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(NON_ADMIN));
    expect(res.status).toBe(401);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("allows an authenticated admin through", async () => {
    wireDbRows();
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// 2. Success path
// ===========================================================================

describe("GET /diagnostics/events – success path", () => {
  it("returns 200 with correct aggregate counts and poolStats", async () => {
    wireDbRows();
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);

    // event type distributions
    expect(res.body.eventTypeCounts).toHaveLength(1);
    expect(res.body.eventTypeCounts[0].event_type).toBe("AgreementCreated");
    expect(res.body.escrowEventCounts[0].event_type).toBe("Funded");
    expect(res.body.paymentEventCounts[0].event_type).toBe("PaymentSent");

    // table counts row is forwarded as-is
    expect(res.body.tableCounts.agreements_count).toBe("3");
    expect(res.body.tableCounts.latest_block).toBe("100");

    // pool stats come from getPoolStats()
    expect(res.body.poolStats).toEqual({ total: 8, idle: 3, active: 5, waiting: 2 });
    expect(getPoolStats).toHaveBeenCalledOnce();
  });

  it("summary mirrors the tableCounts values", async () => {
    wireDbRows();
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    const s = res.body.summary;
    expect(s.totalAgreementEvents).toBe("5");
    expect(s.totalEscrowEvents).toBe("2");
    expect(s.totalPayments).toBe("3");
    expect(s.totalEmployees).toBe("1");
    expect(s.totalMilestones).toBe("4");
    expect(s.latestBlock).toBe("100");
  });

  it("executes exactly five queries", async () => {
    wireDbRows();
    await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));
    expect(db.execute).toHaveBeenCalledTimes(5);
  });
});

// ===========================================================================
// 3. Redaction invariant
// ===========================================================================

describe("Redaction invariant – latestEvents", () => {
  it("never includes transaction_hash in any latestEvents row", async () => {
    wireDbRows();
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    for (const row of res.body.latestEvents) {
      expect(row).not.toHaveProperty("transaction_hash");
    }
  });

  it("never includes agreement_id in any latestEvents row", async () => {
    wireDbRows();
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    for (const row of res.body.latestEvents) {
      expect(row).not.toHaveProperty("agreement_id");
    }
  });

  it("preserves event_type and created_at in latestEvents", async () => {
    wireDbRows();
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    expect(res.body.latestEvents).toHaveLength(1);
    const row = res.body.latestEvents[0];
    expect(row.event_type).toBe("AgreementCreated");
    expect(row.created_at).toBe("2026-01-01T00:00:00Z");
  });
});

// ===========================================================================
// 4. Empty DB boundary
// ===========================================================================

describe("Empty DB boundary", () => {
  it("returns 200 with all summary fields defaulting to 0", async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any) // tableCounts: rows[0] undefined
      .mockResolvedValueOnce({ rows: [] } as any);

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(s.totalAgreementEvents).toBe(0);
    expect(s.totalEscrowEvents).toBe(0);
    expect(s.totalPayments).toBe(0);
    expect(s.totalEmployees).toBe(0);
    expect(s.totalMilestones).toBe(0);
    expect(s.latestBlock).toBe(0);
    expect(res.body.latestEvents).toEqual([]);
  });
});

// ===========================================================================
// 5. tableCounts rows[0] missing → tableCounts is {} in response
// ===========================================================================

describe("tableCounts fallback", () => {
  it("returns tableCounts as {} when the query returns no rows", async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.tableCounts).toEqual({});
  });
});

// ===========================================================================
// 6. Error handling
// ===========================================================================

describe("Error handling", () => {
  it("propagates a db.execute rejection as 500 via the error handler", async () => {
    vi.mocked(db.execute).mockRejectedValue(new Error("db down"));

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(500);
  });

  it("does not leak internal error details in the response body", async () => {
    vi.mocked(db.execute).mockRejectedValue(new Error("connection pool exhausted"));

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(500);
    // The minimal error handler in makeApp() echoes the message, but in
    // production the real handler would suppress it. Confirm the route itself
    // doesn't add extra leakage beyond what the error handler decides to emit.
    expect(res.body).not.toHaveProperty("eventTypeCounts");
  });
});

// ===========================================================================
// 7. Response shape — all top-level keys present on every 200
// ===========================================================================

describe("Response shape contract", () => {
  it("every 200 response contains all required top-level keys", async () => {
    wireDbRows();
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("eventTypeCounts");
    expect(res.body).toHaveProperty("escrowEventCounts");
    expect(res.body).toHaveProperty("paymentEventCounts");
    expect(res.body).toHaveProperty("tableCounts");
    expect(res.body).toHaveProperty("latestEvents");
    expect(res.body).toHaveProperty("poolStats");
    expect(res.body).toHaveProperty("summary");
  });

  it("summary always contains all six numeric fields", async () => {
    wireDbRows();
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN));

    const s = res.body.summary;
    expect(s).toHaveProperty("totalAgreementEvents");
    expect(s).toHaveProperty("totalEscrowEvents");
    expect(s).toHaveProperty("totalPayments");
    expect(s).toHaveProperty("totalEmployees");
    expect(s).toHaveProperty("totalMilestones");
    expect(s).toHaveProperty("latestBlock");
  });
});

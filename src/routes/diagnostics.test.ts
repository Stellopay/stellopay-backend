/**
 * @file diagnostics.test.ts
 * Tests for the operator-only GET /diagnostics/events route.
 *
 * The real requireAuth + requireAdmin middleware run here (only their
 * dependencies, the session check and the admin list, are mocked) so the
 * gating itself is exercised. db.execute is mocked to return canned rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../auth/session.js", () => ({
  requireSession: vi.fn(async () => true),
}));

vi.mock("../config.js", () => ({
  env: { ADMIN_ADDRESSES: ["0xabc1"] },
}));

vi.mock("../db/index.js", () => ({
  db: { execute: vi.fn() },
  getPoolStats: vi.fn(() => ({ total: 8, idle: 3, active: 5, waiting: 2 })),
  schema: {},
}));

import { redactRecentEvent, fetchDiagnosticsData, diagnosticsRouter } from "./diagnostics.js";
import { db, getPoolStats } from "../db/index.js";
import { requireSession } from "../auth/session.js";

// Use valid-hex addresses: the auth middleware now compares the
// principal against the admin allowlist through normalizeStarknetAddress,
// which rejects anything outside [0-9a-f] (e.g. `m`, `n`, `o`, `t`).
const ADMIN = "0xabc1";
const NON_ADMIN = "0xdef2";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", diagnosticsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

function authHeaders(address: string) {
  return { "x-user-address": address, authorization: "Bearer testtoken" };
}

/** Queue the five db.execute results the route reads, in call order. */
function wireDbRows() {
  vi.mocked(db.execute)
    .mockResolvedValueOnce({ rows: [{ event_type: "AgreementCreated", count: "5" }] } as any)
    .mockResolvedValueOnce({ rows: [] } as any)
    .mockResolvedValueOnce({ rows: [] } as any)
    .mockResolvedValueOnce({
      rows: [
        {
          agreement_events_count: "5",
          escrow_events_count: "0",
          payments_count: "0",
          employees_count: "0",
          milestones_count: "0",
          agreements_count: "3",
          latest_block: "100",
        },
      ],
    } as any)
    // The recent-events query returns sensitive identifiers; the route must
    // redact them out of the response.
    .mockResolvedValueOnce({
      rows: [
        {
          event_type: "AgreementCreated",
          transaction_hash: "0xsecrethash",
          agreement_id: "123",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    } as any);
}

describe("redactRecentEvent helper", () => {
  it("strips sensitive transaction hashes, agreement IDs, and extra fields", () => {
    const rawRow = {
      event_type: "EscrowFunded",
      created_at: "2026-07-26T18:00:00Z",
      transaction_hash: "0xsecrettx",
      agreement_id: "ag-999",
      employer: "0xemployer",
    };

    const redacted = redactRecentEvent(rawRow);

    expect(redacted).toEqual({
      event_type: "EscrowFunded",
      created_at: "2026-07-26T18:00:00Z",
    });
    expect(redacted).not.toHaveProperty("transaction_hash");
    expect(redacted).not.toHaveProperty("agreement_id");
    expect(redacted).not.toHaveProperty("employer");
  });
});

describe("fetchDiagnosticsData helper", () => {
  it("executes read queries concurrently and returns structured telemetry", async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ event_type: "AgreementCreated", count: "10" }] })
        .mockResolvedValueOnce({ rows: [{ event_type: "Funded", count: "4" }] })
        .mockResolvedValueOnce({ rows: [{ event_type: "PaymentSent", count: "8" }] })
        .mockResolvedValueOnce({
          rows: [
            {
              agreement_events_count: "10",
              escrow_events_count: "4",
              payments_count: "8",
              employees_count: "2",
              milestones_count: "5",
              agreements_count: "6",
              latest_block: "500",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              event_type: "AgreementCreated",
              transaction_hash: "0xrawtx",
              agreement_id: "ag-10",
              created_at: "2026-07-26T18:10:00Z",
            },
          ],
        }),
    };

    const data = await fetchDiagnosticsData(mockDb as any);

    expect(mockDb.execute).toHaveBeenCalledTimes(5);
    expect(data.eventTypeCounts).toEqual([{ event_type: "AgreementCreated", count: "10" }]);
    expect(data.escrowEventCounts).toEqual([{ event_type: "Funded", count: "4" }]);
    expect(data.paymentEventCounts).toEqual([{ event_type: "PaymentSent", count: "8" }]);
    expect(data.summary.totalAgreementEvents).toBe("10");
    expect(data.summary.latestBlock).toBe("500");
    expect(data.latestEvents).toEqual([
      { event_type: "AgreementCreated", created_at: "2026-07-26T18:10:00Z" },
    ]);
  });
});

describe("GET /diagnostics/events – admin gating and redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.execute).mockReset();
    vi.mocked(requireSession).mockResolvedValue(true);
  });

  it("rejects an unauthenticated request with 401 and runs no queries", async () => {
    const res = await request(makeApp()).get("/api/v1/diagnostics/events");

    expect(res.status).toBe(401);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("rejects an authenticated non-admin with 403 and runs no queries", async () => {
    // requireAuth was satisfied by the session mock, but requireAdmin
    // denies because NON_ADMIN is not in the admin allowlist. The 401/403
    // split in src/auth/middleware.ts intentionally distinguishes "no
    // session" from "wrong role".
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(NON_ADMIN));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("rejects requests when requireSession invalidates session", async () => {
    vi.mocked(requireSession).mockResolvedValueOnce(false);

    const res = await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

    expect(res.status).toBe(401);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("rejects requests missing authorization header or missing address header", async () => {
    const resNoAuth = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set({ "x-user-address": ADMIN });

    expect(resNoAuth.status).toBe(401);

    const resNoAddress = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set({ authorization: "Bearer testtoken" });

    expect(resNoAddress.status).toBe(401);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("allows an admin and returns aggregate counts", async () => {
    wireDbRows();

    const res = await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.summary.totalAgreementEvents).toBe("5");
    expect(res.body.summary.latestBlock).toBe("100");
    expect(res.body.tableCounts.agreements_count).toBe("3");
    expect(res.body.poolStats).toEqual({ total: 8, idle: 3, active: 5, waiting: 2 });
    expect(getPoolStats).toHaveBeenCalledOnce();
  });

  it("handles case-insensitive admin address matching", async () => {
    wireDbRows();

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(ADMIN.toUpperCase()));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalled();
  });

  it("redacts transaction hashes and agreement ids from recent events", async () => {
    wireDbRows();

    const res = await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.latestEvents).toHaveLength(1);

    const row = res.body.latestEvents[0];
    expect(row.event_type).toBe("AgreementCreated");
    expect(row.created_at).toBeDefined();
    expect(row).not.toHaveProperty("transaction_hash");
    expect(row).not.toHaveProperty("agreement_id");
  });

  it("returns zero counts and no recent events when the tables are empty", async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any) // tableCounts empty: rows[0] undefined
      .mockResolvedValueOnce({ rows: [] } as any);

    const res = await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.summary.totalAgreementEvents).toBe(0);
    expect(res.body.summary.latestBlock).toBe(0);
    expect(res.body.latestEvents).toEqual([]);
  });

  it("surfaces a 500 through the error handler when a query fails", async () => {
    vi.mocked(db.execute).mockRejectedValue(new Error("db down"));

    const res = await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

    expect(res.status).toBe(500);
  });
});

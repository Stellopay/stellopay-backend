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
  env: { ADMIN_ADDRESSES: ["0xadmin"] },
}));

vi.mock("../db/index.js", () => ({
  db: { execute: vi.fn() },
  schema: {},
}));

import { diagnosticsRouter } from "./diagnostics.js";
import { db } from "../db/index.js";
import { requireSession } from "../auth/session.js";

const ADMIN = "0xadmin";
const NON_ADMIN = "0xnotadmin";

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

  it("rejects an authenticated non-admin with 401 and runs no queries", async () => {
    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events")
      .set(authHeaders(NON_ADMIN));

    expect(res.status).toBe(401);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("allows an admin and returns aggregate counts", async () => {
    wireDbRows();

    const res = await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.summary.totalAgreementEvents).toBe("5");
    expect(res.body.summary.latestBlock).toBe("100");
    expect(res.body.tableCounts.agreements_count).toBe("3");
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

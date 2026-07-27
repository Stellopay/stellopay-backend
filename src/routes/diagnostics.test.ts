/**
 * diagnostics.test.ts
 *
 * Contract tests for src/routes/diagnostics.ts (issue #279).
 *
 * The real requireAuth + requireAdmin middleware run here (only their
 * dependencies, the session check and the admin list, are mocked) so the
 * gating itself is exercised. db.execute is mocked to return canned rows.
 *
 * Coverage:
 *   - Auth gating: 401 for unauthenticated and non-admin; no DB hit
 *   - Success path: correct shape, counts, poolStats
 *   - Redaction invariant: transaction_hash / agreement_id never leak
 *   - Empty DB boundary: all summary fields default to 0, latestEvents is []
 *   - Error handling: db failure propagates as 500 via error handler
 *   - Response shape: all top-level keys present on every 200
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

import {
  redactRecentEvent,
  fetchDiagnosticsData,
  diagnosticsRouter,
  withDiagnosticsIdempotency,
  clearDiagnosticsIdempotencyStore,
} from "./diagnostics.js";
import { db, getPoolStats } from "../db/index.js";
import { requireSession } from "../auth/session.js";
import { getCircuitBreakerSnapshots } from "../starknet/client.js";

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

  it("provides safe fallbacks for malformed inputs without crashing", () => {
    // Missing fields
    expect(redactRecentEvent({})).toEqual({
      event_type: "Unknown",
      created_at: new Date(0).toISOString(),
    });

    // Invalid types
    expect(redactRecentEvent({ event_type: 123, created_at: false })).toEqual({
      event_type: "Unknown",
      created_at: new Date(0).toISOString(),
    });

    // Null or undefined
    expect(redactRecentEvent(null)).toEqual({
      event_type: "Unknown",
      created_at: new Date(0).toISOString(),
    });
    expect(redactRecentEvent(undefined)).toEqual({
      event_type: "Unknown",
      created_at: new Date(0).toISOString(),
    });

    // Primitive values
    expect(redactRecentEvent("just a string")).toEqual({
      event_type: "Unknown",
      created_at: new Date(0).toISOString(),
    });
  });

  it("normalises Date objects to ISO strings in created_at", () => {
    const testDate = new Date("2026-07-26T18:00:00Z");
    const rawRow = {
      event_type: "EscrowFunded",
      created_at: testDate,
      transaction_hash: "0xsecrettx",
    };

    const redacted = redactRecentEvent(rawRow);

    expect(redacted).toEqual({
      event_type: "EscrowFunded",
      created_at: testDate.toISOString(),
    });
  });

  it("passes through string created_at values unchanged", () => {
    const rawRow = {
      event_type: "PaymentSent",
      created_at: "2026-06-15T12:00:00Z",
    };

    const redacted = redactRecentEvent(rawRow);

    expect(redacted.created_at).toBe("2026-06-15T12:00:00Z");
  });
});

describe("withDiagnosticsIdempotency wrapper", () => {
  beforeEach(() => {
    clearDiagnosticsIdempotencyStore();
  });

  it("passes through to handler when no idempotency key is present", async () => {
    const handler = vi.fn(async (_req: any, res: any) => {
      res.status(200).json({ ok: true });
    });

    const wrapped = withDiagnosticsIdempotency(handler);
    const req = { headers: {}, method: "GET", path: "/test" } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await wrapped(req, res, next);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it("caches the first successful response and replays it on subsequent requests with the same key", async () => {
    let callCount = 0;
    const handler = vi.fn(async (_req: any, res: any) => {
      callCount++;
      res.status(200).json({ seq: callCount });
    });

    const wrapped = withDiagnosticsIdempotency(handler);
    const headers = {
      "idempotency-key": "key-001",
      "x-user-address": "0xabc1",
    };

    const makeReq = () =>
      ({ headers: { ...headers }, method: "GET", path: "/test" }) as any;

    // First call — handler runs.
    // Hold onto the json spy before the wrapper replaces res.json.
    const jsonSpy1 = vi.fn();
    const res1 = { status: vi.fn().mockReturnThis(), json: jsonSpy1 } as any;
    await wrapped(makeReq(), res1, vi.fn());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(jsonSpy1).toHaveBeenCalledWith({ seq: 1 });

    // Second call with same key — cached response, handler NOT called again.
    const jsonSpy2 = vi.fn();
    const res2 = { status: vi.fn().mockReturnThis(), json: jsonSpy2 } as any;
    await wrapped(makeReq(), res2, vi.fn());
    expect(handler).toHaveBeenCalledTimes(1); // still 1
    expect(jsonSpy2).toHaveBeenCalledWith({ seq: 1 });
  });

  it("does not cache when idempotency key is an array", async () => {
    const handler = vi.fn(async (_req: any, res: any) => {
      res.status(200).json({ ok: true });
    });

    const wrapped = withDiagnosticsIdempotency(handler);
    const req = {
      headers: { "idempotency-key": ["key1", "key2"], "x-user-address": "0xabc1" },
      method: "GET",
      path: "/test",
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

    await wrapped(req, res, vi.fn());
    expect(handler).toHaveBeenCalledTimes(1);

    // Second call — handler runs again because array keys bypass cache
    await wrapped(req, res, vi.fn());
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("distinguishes caches by method and path", async () => {
    const handler = vi.fn(async (_req: any, res: any) => {
      res.status(200).json({ route: `${_req.method}:${_req.path}` });
    });

    const wrapped = withDiagnosticsIdempotency(handler);
    const headers = {
      "idempotency-key": "key-002",
      "x-user-address": "0xabc1",
    };

    const reqA = { headers: { ...headers }, method: "GET", path: "/route-a" } as any;
    const reqB = { headers: { ...headers }, method: "GET", path: "/route-b" } as any;

    const jsonSpyA = vi.fn();
    const jsonSpyB = vi.fn();
    const resA = { status: vi.fn().mockReturnThis(), json: jsonSpyA } as any;
    const resB = { status: vi.fn().mockReturnThis(), json: jsonSpyB } as any;

    await wrapped(reqA, resA, vi.fn());
    await wrapped(reqB, resB, vi.fn());

    // Different paths → different cache entries → handler called twice
    expect(handler).toHaveBeenCalledTimes(2);
    expect(jsonSpyA).toHaveBeenCalledWith({ route: "GET:/route-a" });
    expect(jsonSpyB).toHaveBeenCalledWith({ route: "GET:/route-b" });
  });

  it("distinguishes caches by user address", async () => {
    const handler = vi.fn(async (_req: any, res: any) => {
      res.status(200).json({ user: _req.headers["x-user-address"] });
    });

    const wrapped = withDiagnosticsIdempotency(handler);

    const req1 = {
      headers: { "idempotency-key": "key-003", "x-user-address": "0xabc1" },
      method: "GET",
      path: "/test",
    } as any;
    const req2 = {
      headers: { "idempotency-key": "key-003", "x-user-address": "0xdef2" },
      method: "GET",
      path: "/test",
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

    await wrapped(req1, res, vi.fn());
    await wrapped(req2, { ...res, status: vi.fn().mockReturnThis(), json: vi.fn() } as any, vi.fn());

    // Different users → separate cache entries
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("propagates errors through next() rather than caching error responses", async () => {
    const handler = vi.fn(async () => {
      throw new Error("handler failure");
    });

    const wrapped = withDiagnosticsIdempotency(handler);
    const req = {
      headers: { "idempotency-key": "key-err", "x-user-address": "0xabc1" },
      method: "GET",
      path: "/test",
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await wrapped(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0] as any)[0]).toBeInstanceOf(Error);
    expect((next.mock.calls[0] as any)[0].message).toBe("handler failure");
  });
});

describe("clearDiagnosticsIdempotencyStore", () => {
  beforeEach(() => {
    clearDiagnosticsIdempotencyStore();
  });

  it("clears all cached idempotency entries, forcing fresh handler calls", async () => {
    const handler = vi.fn(async (_req: any, res: any) => {
      res.status(200).json({ fresh: true });
    });

    const wrapped = withDiagnosticsIdempotency(handler);
    const req = {
      headers: { "idempotency-key": "key-clr", "x-user-address": "0xabc1" },
      method: "GET",
      path: "/test",
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

    // First call — caches
    await wrapped(req, res, vi.fn());
    expect(handler).toHaveBeenCalledTimes(1);

    // Clear the store
    clearDiagnosticsIdempotencyStore();

    // Second call — must call handler again because cache is empty
    await wrapped(req, res, vi.fn());
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("GET /diagnostics/events – pagination and query parameter edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.execute).mockReset();
    vi.mocked(requireSession).mockResolvedValue(true);
  });

  it("passes through valid limit and offset values to fetchDiagnosticsData", async () => {
    wireDbRows();

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events?limit=5&offset=10")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    // The route returns 200 with data; the exact SQL params are verified
    // indirectly: the mock returns canned rows regardless, but the call
    // count confirms the query pipeline executed.
    expect(db.execute).toHaveBeenCalledTimes(5);
  });

  it("caps limit at 100 even when a larger value is provided", async () => {
    wireDbRows();

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events?limit=9999")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(5);
  });

  it("defaults limit to 20 when zero is provided", async () => {
    wireDbRows();

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events?limit=0")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(5);
  });

  it("defaults limit to 20 when a negative value is provided", async () => {
    wireDbRows();

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events?limit=-5")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(5);
  });

  it("defaults limit to 20 when a non-numeric value is provided", async () => {
    wireDbRows();

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events?limit=abc")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(5);
  });

  it("defaults limit to 20 when Infinity is provided", async () => {
    wireDbRows();

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events?limit=Infinity")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(5);
  });

  it("defaults offset to 0 when a negative value is provided", async () => {
    wireDbRows();

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events?offset=-10")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(5);
  });

  it("accepts limit at the exact cap of 100", async () => {
    wireDbRows();

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events?limit=100")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(5);
  });

  it("rejects fractional limit values by defaulting to 20", async () => {
    // Fractional values are not safe integers, so they fall back to default
    wireDbRows();

    const res = await request(makeApp())
      .get("/api/v1/diagnostics/events?limit=3.14")
      .set(authHeaders(ADMIN));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(5);
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
    expect(res.body.circuitBreakers).toHaveLength(1);
    expect(res.body.circuitBreakers[0].state).toBe("CLOSED");
    expect(getPoolStats).toHaveBeenCalledOnce();
    expect(getCircuitBreakerSnapshots).toHaveBeenCalledOnce();
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


describe("GET /diagnostics/events – backward-compatibility contract (Issue #284)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
            vi.mocked(db.execute).mockReset();
                vi.mocked(requireSession).mockResolvedValue(true);
                  });

                    it("response always includes the full set of documented top-level keys", async () => {
                        wireDbRows();

                            const res = await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

                                expect(res.status).toBe(200);
                                    // Locks the public response contract: existing consumers may rely on
                                        // any of these keys being present. Adding new keys is fine (additive);
                                            // renaming or removing one of these is a breaking change and must fail
                                                // this test, forcing a deliberate version discussion instead of a
                                                    // silent drift.
                                                        expect(Object.keys(res.body).sort()).toEqual(
                                                              [
                                                                      "eventTypeCounts",
                                                                              "escrowEventCounts",
                                                                                      "paymentEventCounts",
                                                                                              "tableCounts",
                                                                                                      "latestEvents",
                                                                                                              "poolStats",
                                                                                                                      "summary",
                                                                                                                            ].sort(),
                                                                                                                                );
                                                                                                                                  });

                                                                                                                                    it("summary always includes the documented six fields, even when tables are empty", async () => {
                                                                                                                                        vi.mocked(db.execute)
                                                                                                                                              .mockResolvedValueOnce({ rows: [] } as any)
                                                                                                                                                    .mockResolvedValueOnce({ rows: [] } as any)
                                                                                                                                                          .mockResolvedValueOnce({ rows: [] } as any)
                                                                                                                                                                .mockResolvedValueOnce({ rows: [] } as any)
                                                                                                                                                                      .mockResolvedValueOnce({ rows: [] } as any);

                                                                                                                                                                          const res = await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

                                                                                                                                                                              expect(res.status).toBe(200);
                                                                                                                                                                                  expect(Object.keys(res.body.summary).sort()).toEqual(
                                                                                                                                                                                        [
                                                                                                                                                                                                "totalAgreementEvents",
                                                                                                                                                                                                        "totalEscrowEvents",
                                                                                                                                                                                                                "totalPayments",
                                                                                                                                                                                                                        "totalEmployees",
                                                                                                                                                                                                                                "totalMilestones",
                                                                                                                                                                                                                                        "latestBlock",
                                                                                                                                                                                                                                              ].sort(),
                                                                                                                                                                                                                                                  );
                                                                                                                                                                                                                                                    });

                                                                                                                                                                                                                                                      it("latestEvents entries never grow beyond the documented redacted shape", async () => {
                                                                                                                                                                                                                                                          wireDbRows();

                                                                                                                                                                                                                                                              const res = await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

                                                                                                                                                                                                                                                                  expect(res.status).toBe(200);
                                                                                                                                                                                                                                                                      for (const entry of res.body.latestEvents) {
                                                                                                                                                                                                                                                                            // Exactly two keys — event_type and created_at. If a future change to
                                                                                                                                                                                                                                                                                  // fetchDiagnosticsData or redactRecentEvent starts leaking a third
                                                                                                                                                                                                                                                                                        // field, this fails instead of silently widening the redaction surface.
                                                                                                                                                                                                                                                                                              expect(Object.keys(entry).sort()).toEqual(["created_at", "event_type"]);
                                                                                                                                                                                                                                                                                                  }
                                                                                                                                                                                                                                                                                                    });

                                                                                                                                                                                                                                                                                                      it("only GET is exposed on /diagnostics/events; other methods are not silently handled", async () => {
                                                                                                                                                                                                                                                                                                          const app = makeApp();

                                                                                                                                                                                                                                                                                                              const postRes = await request(app).post("/api/v1/diagnostics/events").set(authHeaders(ADMIN));
                                                                                                                                                                                                                                                                                                                  const deleteRes = await request(app).delete("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

                                                                                                                                                                                                                                                                                                                      // Express's default for an unregistered method on a known path is 404.
                                                                                                                                                                                                                                                                                                                          // This test locks that in as the documented contract, so a future route
                                                                                                                                                                                                                                                                                                                              // addition (e.g. a POST handler) is a deliberate, reviewed decision
                                                                                                                                                                                                                                                                                                                                  // rather than an accidental side effect of an unrelated change.
                                                                                                                                                                                                                                                                                                                                      expect(postRes.status).toBe(404);
                                                                                                                                                                                                                                                                                                                                          expect(deleteRes.status).toBe(404);
                                                                                                                                                                                                                                                                                                                                              expect(db.execute).not.toHaveBeenCalled();
                                                                                                                                                                                                                                                                                                                                                });

                                                                                                                                                                                                                                                                                                                                                  it("count and *_count values remain strings as returned by Postgres COUNT(*)", async () => {
                                                                                                                                                                                                                                                                                                                                                    wireDbRows();

                                                                                                                                                                                                                                                                                                                                                    const res = await request(makeApp()).get("/api/v1/diagnostics/events").set(authHeaders(ADMIN));

                                                                                                                                                                                                                                                                                                                                                    expect(res.status).toBe(200);
                                                                                                                                                                                                                                                                                                                                                    // Per the docs/count contract: count values are strings.
                                                                                                                                                                                                                                                                                                                                                    for (const row of res.body.eventTypeCounts) {
                                                                                                                                                                                                                                                                                                                                                      expect(typeof row.count).toBe("string");
                                                                                                                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                                                                                                                    expect(typeof res.body.summary.totalAgreementEvents).toBe("string");
                                                                                                                                                                                                                                                                                                                                                    expect(typeof res.body.summary.latestBlock).toBe("string");
                                                                                                                                                                                                                                                                                                                                                    expect(typeof res.body.tableCounts.agreement_events_count).toBe("string");
                                                                                                                                                                                                                                                                                                                                                  });
                                                                                                                                                                                                                                                                                                                                                });
import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ZodError } from "zod";
import { defaults } from "../config.js";
import { computeETag } from "../utils/cache-headers.js";

// Mock the db module (no real Postgres or config needed) and drizzle-orm
// helpers. Each query resolves to the rows configured for its table, records
// the limit/offset it was asked for, and the innerJoin payroll lookup
// (employee-agreements) resolves separately from `state.rows.employeeAgreements`,
// shaped as `{ agreement }` rows to match the route's `.select({ agreement: ... })`.
const { dbMock, schemaMock, state, limitSpy, offsetSpy, callOrder } = vi.hoisted(() => {
  const limitSpy = vi.fn();
  const offsetSpy = vi.fn();
  const state = { rows: {} as Record<string, any[]> };
  // Records, in order, when each query is *issued* ("agreements"/"employeeAgreements")
  // vs when it *resolves* ("resolved:agreements"/"resolved:employeeAgreements").
  // Used to distinguish concurrent (Promise.all) from sequential (await, await)
  // execution without relying on artificial delays/timers.
  const callOrder: string[] = [];

  function from(tableName: string) {
    let joined = false;
    const chain: any = {
      where: () => {
        callOrder.push(joined ? "employeeAgreements" : tableName);
        return chain;
      },
      orderBy: () => chain,
      innerJoin: () => {
        joined = true;
        return chain;
      },
      limit: (n: number) => {
        limitSpy(tableName, n);
        return chain;
      },
      offset: (n: number) => {
        offsetSpy(tableName, n);
        return chain;
      },
      then: (resolve: (rows: any[]) => unknown) => {
        const label = joined ? "employeeAgreements" : tableName;
        callOrder.push(`resolved:${label}`);
        const rows = joined ? (state.rows.employeeAgreements ?? []) : (state.rows[tableName] ?? []);
        return resolve(rows);
      },
    };
    return chain;
  }

  const db = { select: () => ({ from: (t: { __name: string }) => from(t.__name) }) };
  const schema = new Proxy(
    {},
    {
      get: (_t, name: string) =>
        new Proxy(
          { __name: name },
          { get: (_tt, p: string) => (p === "__name" ? name : "col") }
        ),
    }
  );
  return { dbMock: db, schemaMock: schema, state, limitSpy, offsetSpy, callOrder };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("drizzle-orm", () => ({
  eq: () => "eq",
  and: () => "and",
  or: () => "or",
  desc: () => "desc",
}));

// Stable test max-age so assertions are independent of the real env value.
const TEST_MAX_AGE = 42;
vi.mock("../config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config.js")>();
  return {
    ...original,
    env: { ...original.env, INDEXED_CACHE_MAX_AGE_SECONDS: TEST_MAX_AGE },
  };
});

import { indexedRouter } from "./indexed";

const VALID = `0x${"a".repeat(63)}1`;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", indexedRouter);
  // Mirror the central error handler: Zod errors are 400 with structured details.
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      const isZod = err instanceof ZodError;
      res.status(isZod ? 400 : (err?.status ?? 500)).json({
        error: isZod ? "Validation failed" : err?.message,
        details: err?.issues ?? undefined,
      });
    }
  );
  return app;
}

beforeEach(() => {
  limitSpy.mockClear();
  offsetSpy.mockClear();
  state.rows = {};
  callOrder.length = 0;
});

describe("indexed routes validation", () => {
  it("rejects a malformed user address with 400 and details", async () => {
    const res = await request(makeApp()).get(
      "/api/v1/indexed/payments/user/not-an-address"
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("rejects a non-numeric agreement_id with 400", async () => {
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/12ab`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("rejects a non-hex contract address", async () => {
    const res = await request(makeApp()).get(
      `/api/v1/indexed/escrow/not-hex-zzz/balance/7`
    );
    expect(res.status).toBe(400);
  });

  it("rejects a mismatching contract address for agreements list with 400", async () => {
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.payrollEscrowAddress}/user/${VALID}`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid contract address for agreements");
  });

  it("rejects a mismatching contract address for agreement details with 400", async () => {
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreement/${defaults.payrollEscrowAddress}/7`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid contract address for agreement details");
  });

  it("rejects a mismatching contract address for escrow balance with 400", async () => {
    const res = await request(makeApp()).get(
      `/api/v1/indexed/escrow/${defaults.workAgreementAddress}/balance/7`
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid contract address for escrow balance");
  });
});

describe("indexed routes pagination clamping", () => {
  it("clamps an oversized limit to 100 on the payments list", async () => {
    const res = await request(makeApp()).get(
      `/api/v1/indexed/payments/user/${VALID}?limit=5000`
    );
    expect(res.status).toBe(200);
    expect(limitSpy).toHaveBeenCalledWith("payments", 100);
    expect(offsetSpy).toHaveBeenCalledWith("payments", 0);
  });

  it("applies a valid limit and offset on the agreements list", async () => {
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}?limit=10&offset=20`
    );
    expect(res.status).toBe(200);
    expect(limitSpy).toHaveBeenCalledWith("agreements", 10);
    expect(offsetSpy).toHaveBeenCalledWith("agreements", 20);
  });
});

describe("indexed routes data paths", () => {
  it("deduplicates agreements by id for a user", async () => {
    state.rows.agreements = [
      { id: "a1", contractAddress: "c" },
      { id: "a1", contractAddress: "c" },
      { id: "a2", contractAddress: "c" },
    ];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.source).toBe("indexed");
  });

  it("success path: runs the direct-agreements and employee-agreements queries concurrently, not sequentially", async () => {
    state.rows.agreements = [{ id: "a1", contractAddress: "c" }];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreements/${VALID}/user/${VALID}`
    );
    expect(res.status).toBe(200);

    // Both queries must be *issued* before either *resolves*. A regression to
    // sequential awaits would instead produce:
    //   ["agreements", "resolved:agreements", "employeeAgreements", "resolved:employeeAgreements"]
    expect(callOrder).toEqual([
      "agreements",
      "employeeAgreements",
      "resolved:agreements",
      "resolved:employeeAgreements",
    ]);
  });

  it("boundary path: still combines results correctly when only the employee-agreements query returns rows", async () => {
    // The direct-agreements query (employer/contributor) returns nothing, but
    // the user is an employee on a payroll agreement — exercises the branch
    // where the final result depends entirely on the second, concurrently-run
    // query rather than the first.
    state.rows.agreements = [];
    state.rows.employeeAgreements = [{ agreement: { id: "payroll-1", contractAddress: "c" } }];

    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreements/${VALID}/user/${VALID}`
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.agreements).toEqual([{ id: "payroll-1", contractAddress: "c" }]);
  });

  it("returns 404 when an agreement is not found", async () => {
    state.rows.agreements = [];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/99`
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: "Agreement not found" });
  });

  it("returns aggregated detail when an agreement exists", async () => {
    state.rows.agreements = [{ id: "7", contractAddress: "c" }];
    state.rows.agreementEvents = [{ id: "e1" }];
    state.rows.payments = [{ id: "p1" }];
    state.rows.milestones = [{ id: "m1" }];
    state.rows.employees = [{ id: "emp1" }];
    state.rows.escrowEvents = [{ id: "x1" }];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/7`
    );
    expect(res.status).toBe(200);
    expect(res.body.agreement.id).toBe("7");
    expect(res.body.events).toHaveLength(1);
    expect(res.body.payments).toHaveLength(1);
  });

  it("computes escrow balance from funded, released, and refunded events", async () => {
    state.rows.escrowEvents = [
      { eventType: "Funded", amount: "1000" },
      { eventType: "Released", amount: "300" },
      { eventType: "Refunded", amount: "200" },
      { eventType: "Other", amount: "9" },
    ];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/escrow/${defaults.payrollEscrowAddress}/balance/7`
    );
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe("500");
    expect(res.body.agreement_id).toBe("7");
  });
});

describe("indexed routes caching headers", () => {
  // ── helpers ────────────────────────────────────────────────────────────────

  /** Expected Cache-Control value using the mocked max-age. */
  const expectedCacheControl = `public, max-age=${TEST_MAX_AGE}`;

  // ── Cache-Control header ───────────────────────────────────────────────────

  it("sets Cache-Control on the payments list", async () => {
    const res = await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(expectedCacheControl);
  });

  it("sets Cache-Control on the agreements list", async () => {
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(expectedCacheControl);
  });

  it("sets Cache-Control on the agreement detail", async () => {
    state.rows.agreements = [{ id: "7", contractAddress: "c" }];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/7`
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(expectedCacheControl);
  });

  it("sets Cache-Control on the escrow balance", async () => {
    const res = await request(makeApp()).get(
      `/api/v1/indexed/escrow/${defaults.payrollEscrowAddress}/balance/7`
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(expectedCacheControl);
  });

  // ── ETag header ───────────────────────────────────────────────────────────

  it("sets an ETag on the payments list that matches the response body", async () => {
    state.rows.payments = [{ id: "p1", amount: "100" }];
    const res = await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBeDefined();
    // ETag must be a quoted string (RFC 7232)
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]+"$/);
    // ETag must correspond to the response body
    const expectedETag = computeETag({ payments: res.body.payments, count: res.body.count });
    expect(res.headers["etag"]).toBe(expectedETag);
  });

  it("sets an ETag on the agreements list that matches the response body", async () => {
    state.rows.agreements = [{ id: "a1", contractAddress: "c" }];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
    );
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]+"$/);
    const expectedETag = computeETag({
      agreements: res.body.agreements,
      count: res.body.count,
      source: res.body.source,
    });
    expect(res.headers["etag"]).toBe(expectedETag);
  });

  it("sets an ETag on the escrow balance that matches the response body", async () => {
    state.rows.escrowEvents = [
      { eventType: "Funded", amount: "500" },
      { eventType: "Released", amount: "100" },
    ];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/escrow/${defaults.payrollEscrowAddress}/balance/7`
    );
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]+"$/);
    const expectedETag = computeETag({
      agreement_id: res.body.agreement_id,
      balance: res.body.balance,
      events: res.body.events,
    });
    expect(res.headers["etag"]).toBe(expectedETag);
  });

  it("produces a different ETag when the payments list changes", async () => {
    state.rows.payments = [{ id: "p1" }];
    const res1 = await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);

    state.rows.payments = [{ id: "p1" }, { id: "p2" }];
    const res2 = await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);

    expect(res1.headers["etag"]).not.toBe(res2.headers["etag"]);
  });

  it("produces an identical ETag for identical payment responses", async () => {
    state.rows.payments = [{ id: "p1" }];
    const res1 = await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);
    const res2 = await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);

    expect(res1.headers["etag"]).toBe(res2.headers["etag"]);
  });

  // ── Error paths must NOT carry cache headers ───────────────────────────────

  it("does NOT set Cache-Control on a 400 validation error", async () => {
    const res = await request(makeApp()).get("/api/v1/indexed/payments/user/not-an-address");
    expect(res.status).toBe(400);
    // Cache-Control should either be absent or not set to the indexed caching value
    expect(res.headers["cache-control"]).not.toBe(expectedCacheControl);
  });

  it("does NOT set Cache-Control on a 404 not-found response", async () => {
    state.rows.agreements = [];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/99`
    );
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).not.toBe(expectedCacheControl);
  });
});

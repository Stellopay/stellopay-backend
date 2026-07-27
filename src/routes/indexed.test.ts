import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ZodError } from "zod";

const { ADMIN_ADDRESS, NON_ADMIN_ADDRESS, VALID_TOKEN } = vi.hoisted(() => ({
  ADMIN_ADDRESS: "0x" + "1".repeat(64),
  NON_ADMIN_ADDRESS: "0x" + "2".repeat(64),
  VALID_TOKEN: "valid-session-token",
}));

vi.mock("../auth/session.js", () => ({
  requireSession: vi.fn(async (_address: string, token: string) => token === VALID_TOKEN),
}));

vi.mock("../config.js", () => ({
  env: { ADMIN_ADDRESSES: [ADMIN_ADDRESS] },
  defaults: {
    workAgreementAddress: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
    payrollEscrowAddress: "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
  },
  abiPaths: { agreement: "/fake/agreement.json", escrow: "/fake/escrow.json" },
}));

const { dbMock, schemaMock, state, limitSpy, offsetSpy, callOrder } = vi.hoisted(() => {
  const limitSpy = vi.fn();
  const offsetSpy = vi.fn();
  const state = { rows: {} as Record<string, any[]> };
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

  const db = {
    select: (_fields?: any) => ({
      from: (t: { __name: string }) => {
        callOrder.push(`select:${t.__name}`);
        return from(t.__name);
      },
    }),
  };

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

import {
  indexedRouter,
  deriveSyncCheckpoint,
  authorizeIndexedFreshness,
  INDEXED_DATA_SOURCE,
  MAX_INTERNAL_LIMIT,
} from "./indexed";
import { defaults } from "../config.js";

const VALID = "0x" + "3".repeat(64);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", indexedRouter);
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
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

describe("indexer freshness and sync checkpoint authorization boundary", () => {
  it("rejects unauthenticated requests with 401 Unauthorized", async () => {
    const resFreshness = await request(makeApp()).get("/api/v1/indexed/freshness");
    expect(resFreshness.status).toBe(401);
    expect(resFreshness.body).toEqual({ error: "Unauthorized" });

    const resCheckpoint = await request(makeApp()).get("/api/v1/indexed/checkpoint");
    expect(resCheckpoint.status).toBe(401);
    expect(resCheckpoint.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects requests with invalid session token with 401 Unauthorized", async () => {
    const res = await request(makeApp())
      .get("/api/v1/indexed/freshness")
      .set("x-user-address", ADMIN_ADDRESS)
      .set("Authorization", "Bearer invalid-token");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects authenticated non-admin requests with 403 Forbidden", async () => {
    const res = await request(makeApp())
      .get("/api/v1/indexed/freshness")
      .set("x-user-address", NON_ADMIN_ADDRESS)
      .set("Authorization", `Bearer ${VALID_TOKEN}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("evaluates authorization BEFORE executing route logic or DB access", async () => {
    await request(makeApp()).get("/api/v1/indexed/freshness");
    expect(callOrder).toHaveLength(0);

    await request(makeApp())
      .get("/api/v1/indexed/freshness")
      .set("x-user-address", NON_ADMIN_ADDRESS)
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(callOrder).toHaveLength(0);
  });

  it("prevents sensitive state leakage in failure responses", async () => {
    const resUnauth = await request(makeApp()).get("/api/v1/indexed/freshness");
    expect(resUnauth.body).toEqual({ error: "Unauthorized" });
    expect(resUnauth.body.checkpointBlock).toBeUndefined();
    expect(resUnauth.body.source).toBeUndefined();

    const resForbidden = await request(makeApp())
      .get("/api/v1/indexed/checkpoint")
      .set("x-user-address", NON_ADMIN_ADDRESS)
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(resForbidden.body).toEqual({ error: "Forbidden" });
    expect(resForbidden.body.checkpointBlock).toBeUndefined();
  });

  it("allows authorized admin requests to succeed", async () => {
    state.rows.agreementEvents = [
      { blockNumber: 1500 },
      { blockNumber: 1200 },
    ];

    const res = await request(makeApp())
      .get("/api/v1/indexed/freshness")
      .set("x-user-address", ADMIN_ADDRESS)
      .set("Authorization", `Bearer ${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe(INDEXED_DATA_SOURCE);
    expect(res.body.checkpointBlock).toBe(1500);
    expect(res.body.freshness).toBe("synced");
  });

  it("exports authorizeIndexedFreshness middleware array", () => {
    expect(Array.isArray(authorizeIndexedFreshness)).toBe(true);
    expect(authorizeIndexedFreshness.length).toBe(2);
  });
});

describe("indexed routes validation", () => {
  it("rejects a malformed user address with 400", async () => {
    const res = await request(makeApp()).get("/api/v1/indexed/payments/user/not-an-address");
    expect(res.status).toBe(400);
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

describe("indexed routes pagination and bounding", () => {
  it("clamps an oversized limit to 100 on the payments list", async () => {
    await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}?limit=5000`);
    expect(limitSpy).toHaveBeenCalledWith("payments", 100);
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
      { id: "a1", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() },
      { id: "a1", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() },
    ];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.source).toBe("indexed");
  });

  it("success path: runs the direct-agreements and employee-agreements queries concurrently, not sequentially", async () => {
    state.rows.agreements = [{ id: "a1", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() }];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
    );
    expect(res.status).toBe(200);

    expect(callOrder).toEqual([
      "select:agreements",
      "agreements",
      "select:agreements",
      "employeeAgreements",
      "resolved:agreements",
      "resolved:employeeAgreements",
    ]);
  });

  it("boundary path: still combines results correctly when only the employee-agreements query returns rows", async () => {
    state.rows.agreements = [];
    state.rows.employeeAgreements = [
      { agreement: { id: "payroll-1", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 1, createdAt: new Date() } },
    ];

    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.agreements[0].id).toBe("payroll-1");
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
    state.rows.agreements = [{ id: "7", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() }];
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
    expect(res.headers["cache-control"]).toContain("public, max-age=");
    expect(res.headers.etag).toBeDefined();
  });

  it("computes escrow balance from funded, released, and refunded events", async () => {
    state.rows.escrowEvents = [
      { eventType: "Funded", amount: "1000" },
      { eventType: "Released", amount: "400" },
    ];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/escrow/${defaults.payrollEscrowAddress}/balance/7`
    );
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe("600");
    expect(res.body.agreement_id).toBe("7");
  });
});

describe("indexer freshness and sync checkpoint helpers", () => {
  it("exposes expected indexer contract constants", () => {
    expect(INDEXED_DATA_SOURCE).toBe("indexed");
    expect(MAX_INTERNAL_LIMIT).toBe(200);
  });

  describe("deriveSyncCheckpoint", () => {
    it("success path: derives maximum block number from numeric and bigint block numbers", () => {
      const records = [
        { blockNumber: 100 },
        { blockNumber: BigInt(500) },
        { blockNumber: 250 },
      ];
      expect(deriveSyncCheckpoint(records)).toBe(500);
    });

    it("boundary path: returns 0 for empty, null, or undefined records input", () => {
      expect(deriveSyncCheckpoint([])).toBe(0);
      expect(deriveSyncCheckpoint(null as any)).toBe(0);
      expect(deriveSyncCheckpoint(undefined as any)).toBe(0);
    });

    it("boundary path: returns 0 when no valid block numbers exist in records", () => {
      const records = [
        {},
        { blockNumber: null },
        { blockNumber: undefined },
        { blockNumber: NaN },
      ];
      expect(deriveSyncCheckpoint(records)).toBe(0);
    });

    it("boundary path: ignores invalid or negative block numbers and finds max positive block", () => {
      const records = [
        { blockNumber: -10 },
        { blockNumber: 12345 },
        { blockNumber: null },
      ];
      expect(deriveSyncCheckpoint(records)).toBe(12345);
    });
  });
});
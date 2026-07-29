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
  env: { ADMIN_ADDRESSES: [ADMIN_ADDRESS], INDEXED_CACHE_MAX_AGE_SECONDS: 12, LOG_FORMAT: "json", LOG_LEVEL: "info" },
  defaults: {
    workAgreementAddress: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
    payrollEscrowAddress: "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
  },
  abiPaths: { agreement: "/fake/agreement.json", escrow: "/fake/escrow.json" },
}));

const { dbMock, schemaMock, state, limitSpy, offsetSpy, callOrder } = vi.hoisted(() => {
  (globalThis as any).isPlainObject = (val: unknown): val is Record<string, unknown> =>
    !!val && typeof val === "object" && !Array.isArray(val);
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
  MAX_ESCROW_EVENTS_LIMIT,
  INDEXED_OPS,
  INDEXED_METRICS,
  logIndexedEvent,
  incIndexedMetric,
  getIndexedMetricsSnapshot,
  resetIndexedMetrics,
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
  resetIndexedMetrics();
  vi.restoreAllMocks();
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

describe("/indexed/freshness vs /indexed/checkpoint differentiation", () => {
  it("/indexed/freshness includes freshness field in the response body", async () => {
    state.rows.agreementEvents = [{ blockNumber: 100 }];

    const res = await request(makeApp())
      .get("/api/v1/indexed/freshness")
      .set("x-user-address", ADMIN_ADDRESS)
      .set("Authorization", `Bearer ${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("freshness");
    expect(res.body.freshness).toBe("synced");
  });

  it("/indexed/checkpoint omits freshness field in the response body", async () => {
    state.rows.agreementEvents = [{ blockNumber: 100 }];

    const res = await request(makeApp())
      .get("/api/v1/indexed/checkpoint")
      .set("x-user-address", ADMIN_ADDRESS)
      .set("Authorization", `Bearer ${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("freshness");
    expect(res.body.source).toBe(INDEXED_DATA_SOURCE);
    expect(res.body.checkpointBlock).toBe(100);
  });

  it("both endpoints set the x-indexer-sync-checkpoint header", async () => {
    state.rows.agreementEvents = [{ blockNumber: 42 }];

    const [resFreshness, resCheckpoint] = await Promise.all([
      request(makeApp())
        .get("/api/v1/indexed/freshness")
        .set("x-user-address", ADMIN_ADDRESS)
        .set("Authorization", `Bearer ${VALID_TOKEN}`),
      request(makeApp())
        .get("/api/v1/indexed/checkpoint")
        .set("x-user-address", ADMIN_ADDRESS)
        .set("Authorization", `Bearer ${VALID_TOKEN}`),
    ]);

    expect(resFreshness.headers["x-indexer-sync-checkpoint"]).toBe("42");
    expect(resCheckpoint.headers["x-indexer-sync-checkpoint"]).toBe("42");
  });

  it("boundary: returns freshness=empty and checkpointBlock=0 when no records exist", async () => {
    state.rows.agreementEvents = [];

    const [resFreshness, resCheckpoint] = await Promise.all([
      request(makeApp())
        .get("/api/v1/indexed/freshness")
        .set("x-user-address", ADMIN_ADDRESS)
        .set("Authorization", `Bearer ${VALID_TOKEN}`),
      request(makeApp())
        .get("/api/v1/indexed/checkpoint")
        .set("x-user-address", ADMIN_ADDRESS)
        .set("Authorization", `Bearer ${VALID_TOKEN}`),
    ]);

    expect(resFreshness.status).toBe(200);
    expect(resFreshness.body.freshness).toBe("empty");
    expect(resFreshness.body.checkpointBlock).toBe(0);
    expect(resFreshness.headers["x-indexer-sync-checkpoint"]).toBe("0");

    expect(resCheckpoint.status).toBe(200);
    expect(resCheckpoint.body.checkpointBlock).toBe(0);
    expect(resCheckpoint.body).not.toHaveProperty("freshness");
    expect(resCheckpoint.headers["x-indexer-sync-checkpoint"]).toBe("0");
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
    expect(MAX_ESCROW_EVENTS_LIMIT).toBe(500);
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

    it("idempotency: same input produces identical output on repeated calls", () => {
      const records = [
        { blockNumber: 10 },
        { blockNumber: 20 },
        { blockNumber: 30 },
      ];
      const first = deriveSyncCheckpoint(records);
      const second = deriveSyncCheckpoint(records);
      const third = deriveSyncCheckpoint([...records]);
      expect(first).toBe(30);
      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    it("string coercion: derives checkpoint from numeric string block numbers", () => {
      const records = [
        { blockNumber: "100" },
        { blockNumber: "250" },
      ];
      expect(deriveSyncCheckpoint(records)).toBe(250);
    });

    it("string coercion: handles hex-prefixed string block numbers", () => {
      const records = [
        { blockNumber: "0x1a" },
        { blockNumber: "0x64" },
      ];
      expect(deriveSyncCheckpoint(records)).toBe(100);
    });

    it("boundary path: ignores Infinity, -Infinity, and NaN block numbers", () => {
      const records = [
        { blockNumber: Infinity },
        { blockNumber: -Infinity },
        { blockNumber: NaN },
        { blockNumber: 42 },
      ];
      expect(deriveSyncCheckpoint(records)).toBe(42);
    });

    it("boundary path: skips records with unexpected blockNumber types", () => {
      const records = [
        { blockNumber: { obj: true } },
        { blockNumber: [1, 2, 3] },
        { blockNumber: true },
        { blockNumber: 99 },
      ];
      expect(deriveSyncCheckpoint(records)).toBe(99);
    });

    it("boundary path: handles null records in the array", () => {
      const records = [
        null,
        { blockNumber: 50 },
        undefined,
      ] as any;
      expect(deriveSyncCheckpoint(records)).toBe(50);
    });
  });

  describe("indexer freshness and sync checkpoint route headers", () => {
    it("success path: returns maximum block number in x-indexer-sync-checkpoint header", async () => {
      state.rows.agreements = [
        { id: "a1", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date(), blockNumber: 120 },
        { id: "a2", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date(), blockNumber: 350 },
      ];
      const res = await request(makeApp()).get(
        `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
      );
      expect(res.status).toBe(200);
      expect(res.headers["x-indexer-sync-checkpoint"]).toBe("350");
    });

    it("boundary path: returns 0 in x-indexer-sync-checkpoint header if no records exist", async () => {
      state.rows.agreements = [];
      const res = await request(makeApp()).get(
        `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
      );
      expect(res.status).toBe(200);
      expect(res.headers["x-indexer-sync-checkpoint"]).toBe("0");
    });

    it("success path: agreement details endpoint derives sync checkpoint from all details records", async () => {
      state.rows.agreements = [{ id: "7", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date(), blockNumber: 100 }];
      state.rows.agreementEvents = [{ id: "e1", blockNumber: 200 }];
      state.rows.payments = [{ id: "p1", blockNumber: 300 }];
      state.rows.milestones = [{ id: "m1", blockNumber: 400 }];
      state.rows.employees = [{ id: "emp1", blockNumber: 500 }];
      state.rows.escrowEvents = [{ id: "x1", blockNumber: 600 }];
      const res = await request(makeApp()).get(
        `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/7`
      );
      expect(res.status).toBe(200);
      expect(res.headers["x-indexer-sync-checkpoint"]).toBe("600");
    });

    it("boundary path: agreement details endpoint returns 0 in x-indexer-sync-checkpoint header when records lack block numbers", async () => {
      state.rows.agreements = [{ id: "7", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() }];
      const res = await request(makeApp()).get(
        `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/7`
      );
      expect(res.status).toBe(200);
      expect(res.headers["x-indexer-sync-checkpoint"]).toBe("0");
    });
  });

  describe("idempotency of indexed routes", () => {
    it("idempotency: repeated GET /indexed/freshness returns identical body for same DB state", async () => {
      state.rows.agreementEvents = [{ blockNumber: 500 }];

      const opts = () =>
        request(makeApp())
          .get("/api/v1/indexed/freshness")
          .set("x-user-address", ADMIN_ADDRESS)
          .set("Authorization", `Bearer ${VALID_TOKEN}`);

      const [res1, res2] = await Promise.all([opts(), opts()]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(res1.body);
    });

    it("idempotency: repeated GET /indexed/checkpoint returns identical body for same DB state", async () => {
      state.rows.agreementEvents = [{ blockNumber: 500 }];

      const opts = () =>
        request(makeApp())
          .get("/api/v1/indexed/checkpoint")
          .set("x-user-address", ADMIN_ADDRESS)
          .set("Authorization", `Bearer ${VALID_TOKEN}`);

      const [res1, res2] = await Promise.all([opts(), opts()]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(res1.body);
    });

    it("idempotency: repeated GET /indexed/agreements/:contract_address/user/:user_address returns identical body for same DB state", async () => {
      state.rows.agreements = [
        { id: "a1", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date(), blockNumber: 100 },
      ];

      const opts = () =>
        request(makeApp()).get(
          `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
        );

      const [res1, res2] = await Promise.all([opts(), opts()]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(res1.body);
    });

    it("idempotency: repeated GET /indexed/agreement/:contract_address/:agreement_id returns identical body for same DB state", async () => {
      state.rows.agreements = [{ id: "7", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date(), blockNumber: 100 }];
      state.rows.agreementEvents = [{ id: "e1", blockNumber: 200 }];
      state.rows.payments = [{ id: "p1", blockNumber: 300 }];
      state.rows.milestones = [{ id: "m1", blockNumber: 400 }];
      state.rows.employees = [{ id: "emp1", blockNumber: 500 }];
      state.rows.escrowEvents = [{ id: "x1", blockNumber: 600 }];

      const opts = () =>
        request(makeApp()).get(
          `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/7`
        );

      const [res1, res2] = await Promise.all([opts(), opts()]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(res1.body);
    });

    it("idempotency: repeated GET /indexed/payments/user/:user_address returns identical body for same DB state", async () => {
      state.rows.payments = [{ id: "p1", blockNumber: 100 }];

      const opts = () =>
        request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);

      const [res1, res2] = await Promise.all([opts(), opts()]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(res1.body);
    });

    it("idempotency: repeated GET /indexed/escrow/:contract_address/balance/:agreement_id returns identical body for same DB state", async () => {
      state.rows.escrowEvents = [
        { eventType: "Funded", amount: "1000", blockNumber: 10 },
      ];

      const opts = () =>
        request(makeApp()).get(
          `/api/v1/indexed/escrow/${defaults.payrollEscrowAddress}/balance/7`
        );

      const [res1, res2] = await Promise.all([opts(), opts()]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(res1.body);
    });
  });
});

describe("freshness and checkpoint cache headers", () => {
  it("freshness: sets Cache-Control and ETag headers", async () => {
    state.rows.agreementEvents = [{ blockNumber: 500 }];

    const res = await request(makeApp())
      .get("/api/v1/indexed/freshness")
      .set("x-user-address", ADMIN_ADDRESS)
      .set("Authorization", `Bearer ${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("public, max-age=");
    expect(res.headers.etag).toBeDefined();
  });

  it("checkpoint: sets Cache-Control and ETag headers", async () => {
    state.rows.agreementEvents = [{ blockNumber: 500 }];

    const res = await request(makeApp())
      .get("/api/v1/indexed/checkpoint")
      .set("x-user-address", ADMIN_ADDRESS)
      .set("Authorization", `Bearer ${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("public, max-age=");
    expect(res.headers.etag).toBeDefined();
  });

  it("ETag stability: same DB state produces same ETag on freshness", async () => {
    state.rows.agreementEvents = [{ blockNumber: 500 }];

    const opts = () =>
      request(makeApp())
        .get("/api/v1/indexed/freshness")
        .set("x-user-address", ADMIN_ADDRESS)
        .set("Authorization", `Bearer ${VALID_TOKEN}`);

    const [res1, res2] = await Promise.all([opts(), opts()]);
    expect(res1.headers.etag).toBe(res2.headers.etag);
  });

  it("ETag stability: same DB state produces same ETag on checkpoint", async () => {
    state.rows.agreementEvents = [{ blockNumber: 500 }];

    const opts = () =>
      request(makeApp())
        .get("/api/v1/indexed/checkpoint")
        .set("x-user-address", ADMIN_ADDRESS)
        .set("Authorization", `Bearer ${VALID_TOKEN}`);

    const [res1, res2] = await Promise.all([opts(), opts()]);
    expect(res1.headers.etag).toBe(res2.headers.etag);
  });
});

// ---------------------------------------------------------------------------
// Observability tests (Issue #250)
// ---------------------------------------------------------------------------

describe("logIndexedEvent", () => {
  it("emits JSON to stdout when LOG_FORMAT is json", async () => {
    // In the test environment, the mocked config has LOG_FORMAT: "json",
    // so logIndexedEvent should emit JSON by default.
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    logIndexedEvent("info", "test.op", { foo: "bar" });

    expect(spy).toHaveBeenCalled();
    const logged = JSON.parse(spy.mock.calls[spy.mock.calls.length - 1][0]);
    expect(logged.level).toBe("info");
    expect(logged.op).toBe("test.op");
    expect(logged.foo).toBe("bar");
    expect(logged.timestamp).toBeDefined();
  });

  it("uses console.error for error level", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logIndexedEvent("error", "test.op", { error: "boom" });

    expect(spy).toHaveBeenCalled();
    const logged = JSON.parse(spy.mock.calls[spy.mock.calls.length - 1][0]);
    expect(logged.level).toBe("error");
    expect(logged.error).toBe("boom");
  });
});

describe("incIndexedMetric / getIndexedMetricsSnapshot / resetIndexedMetrics", () => {
  it("increments a counter and returns snapshot", () => {
    incIndexedMetric("my_counter");
    incIndexedMetric("my_counter");
    incIndexedMetric("other", 5);

    const snapshot = getIndexedMetricsSnapshot();
    expect(snapshot.my_counter).toBe(2);
    expect(snapshot.other).toBe(5);
  });

  it("creates counter on first write", () => {
    const snapshot1 = getIndexedMetricsSnapshot();
    expect(snapshot1.brand_new).toBeUndefined();

    incIndexedMetric("brand_new", 3);
    expect(getIndexedMetricsSnapshot().brand_new).toBe(3);
  });

  it("resetIndexedMetrics clears all counters", () => {
    incIndexedMetric("a", 10);
    incIndexedMetric("b", 20);
    resetIndexedMetrics();

    const snapshot = getIndexedMetricsSnapshot();
    expect(snapshot.a).toBeUndefined();
    expect(snapshot.b).toBeUndefined();
  });

  it("returns a shallow copy (mutations do not affect internal state)", () => {
    incIndexedMetric("protected", 1);
    const snapshot = getIndexedMetricsSnapshot();
    snapshot.protected = 999;

    expect(getIndexedMetricsSnapshot().protected).toBe(1);
  });
});

describe("observability constants", () => {
  it("INDEXED_OPS covers all six route handlers", () => {
    expect(INDEXED_OPS.FRESHNESS).toBe("indexed.freshness");
    expect(INDEXED_OPS.CHECKPOINT).toBe("indexed.checkpoint");
    expect(INDEXED_OPS.AGREEMENTS_FOR_USER).toBe("indexed.agreements_for_user");
    expect(INDEXED_OPS.AGREEMENT_DETAIL).toBe("indexed.agreement_detail");
    expect(INDEXED_OPS.PAYMENTS_FOR_USER).toBe("indexed.payments_for_user");
    expect(INDEXED_OPS.ESCROW_BALANCE).toBe("indexed.escrow_balance");
  });

  it("INDEXED_METRICS has the expected counter names", () => {
    expect(INDEXED_METRICS.REQUESTS).toBe("indexed_requests_total");
    expect(INDEXED_METRICS.ROWS_FOUND).toBe("indexed_rows_found_total");
    expect(INDEXED_METRICS.SYNC_CHECKPOINT_OBSERVED).toBe("indexed_sync_checkpoint_observed_total");
    expect(INDEXED_METRICS.ERRORS).toBe("indexed_errors_total");
  });
});

describe("route handler metric integration", () => {
  it("increments REQUESTS counter on agreements-for-user", async () => {
    state.rows.agreements = [{ id: "a1", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() }];
    await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
    );
    const snapshot = getIndexedMetricsSnapshot();
    expect(snapshot[INDEXED_METRICS.REQUESTS]).toBe(1);
  });

  it("increments ROWS_FOUND when agreements are returned", async () => {
    state.rows.agreements = [{ id: "a1", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() }];
    await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
    );
    const snapshot = getIndexedMetricsSnapshot();
    expect(snapshot[INDEXED_METRICS.ROWS_FOUND]).toBe(1);
  });

  it("increments REQUESTS on agreement detail", async () => {
    state.rows.agreements = [{ id: "7", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() }];
    state.rows.agreementEvents = [];
    state.rows.payments = [];
    state.rows.milestones = [];
    state.rows.employees = [];
    state.rows.escrowEvents = [];
    await request(makeApp()).get(
      `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/7`
    );
    const snapshot = getIndexedMetricsSnapshot();
    expect(snapshot[INDEXED_METRICS.REQUESTS]).toBe(1);
  });

  it("increments REQUESTS on payments-for-user", async () => {
    state.rows.payments = [{ blockNumber: 100 }];
    await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);
    const snapshot = getIndexedMetricsSnapshot();
    expect(snapshot[INDEXED_METRICS.REQUESTS]).toBe(1);
  });

  it("increments REQUESTS on escrow-balance", async () => {
    state.rows.escrowEvents = [{ eventType: "Funded", amount: "500" }];
    await request(makeApp()).get(
      `/api/v1/indexed/escrow/${defaults.payrollEscrowAddress}/balance/7`
    );
    const snapshot = getIndexedMetricsSnapshot();
    expect(snapshot[INDEXED_METRICS.REQUESTS]).toBe(1);
  });
});

describe("sync checkpoint logging integration", () => {
  it("emits a structured log with syncCheckpoint > 0 on agreements-for-user", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    state.rows.agreements = [{ id: "a1", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date(), blockNumber: 42 }];

    await request(makeApp()).get(
      `/api/v1/indexed/agreements/${defaults.workAgreementAddress}/user/${VALID}`
    );

    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    const logged = JSON.parse(lastCall[0]);
    expect(logged.op).toBe(INDEXED_OPS.AGREEMENTS_FOR_USER);
    expect(logged.syncCheckpoint).toBe(42);
    expect(logged.durationMs).toBeGreaterThanOrEqual(0);
    expect(logged.httpStatus).toBe(200);
  });

  it("emits a structured log with sub-resource counts on agreement detail", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    state.rows.agreements = [{ id: "7", contractAddress: defaults.workAgreementAddress, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() }];
    state.rows.agreementEvents = [{ id: "e1", blockNumber: 300 }];
    state.rows.payments = [{ id: "p1", blockNumber: 200 }];
    state.rows.milestones = [{ id: "m1" }];
    state.rows.employees = [{ id: "emp1" }];
    state.rows.escrowEvents = [{ id: "x1", blockNumber: 250 }];

    await request(makeApp()).get(
      `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/7`
    );

    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    const logged = JSON.parse(lastCall[0]);
    expect(logged.op).toBe(INDEXED_OPS.AGREEMENT_DETAIL);
    expect(logged.syncCheckpoint).toBe(300);
    expect(logged.eventsCount).toBe(1);
    expect(logged.paymentsCount).toBe(1);
    expect(logged.employeesCount).toBe(1);
    expect(logged.escrowEventsCount).toBe(1);
  });

  it("emits a structured log on payments-for-user with sync checkpoint", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    state.rows.payments = [{ blockNumber: 555 }];

    await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);

    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    const logged = JSON.parse(lastCall[0]);
    expect(logged.op).toBe(INDEXED_OPS.PAYMENTS_FOR_USER);
    expect(logged.syncCheckpoint).toBe(555);
  });

  it("emits a structured log on escrow-balance with events count", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    state.rows.escrowEvents = [
      { eventType: "Funded", amount: "1000", blockNumber: 10 },
      { eventType: "Released", amount: "200", blockNumber: 20 },
    ];

    await request(makeApp()).get(
      `/api/v1/indexed/escrow/${defaults.payrollEscrowAddress}/balance/7`
    );

    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    const logged = JSON.parse(lastCall[0]);
    expect(logged.op).toBe(INDEXED_OPS.ESCROW_BALANCE);
    expect(logged.syncCheckpoint).toBe(20);
    expect(logged.eventsCount).toBe(2);
    expect(logged.balance).toBe("800");
  });
});

describe("error path observability", () => {
  it("increments ERRORS counter when db query throws on payments route", async () => {
    // Save the original select mock.
    // NOTE: This couples to the hoisted mock's internal shape — if the mock
    // structure changes, this test will need updating.
    const origSelect = (dbMock as any).select;

    // Make the db mock throw on the next query chain.
    (dbMock as any).select = () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () => ({
                then: (_resolve: any, reject: any) => reject(new Error("DB connection lost")),
              }),
            }),
          }),
        }),
      }),
    });

    try {
      const res = await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);
      expect(res.status).toBe(500);
    } finally {
      // Restore original mock
      (dbMock as any).select = origSelect;
    }

    const snapshot = getIndexedMetricsSnapshot();
    expect(snapshot[INDEXED_METRICS.ERRORS]).toBe(1);
    expect(snapshot[INDEXED_METRICS.REQUESTS]).toBe(1);
  });

  it("emits an error-level log when a route throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Save the original select mock.
    // NOTE: Coupled to hoisted mock shape — see note above.
    const origSelect = (dbMock as any).select;

    (dbMock as any).select = () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () => ({
                then: (_resolve: any, reject: any) => reject(new Error("DB boom")),
              }),
            }),
          }),
        }),
      }),
    });

    try {
      await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}`);
    } finally {
      (dbMock as any).select = origSelect;
    }

    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    const logged = JSON.parse(lastCall[0]);
    expect(logged.level).toBe("error");
    expect(logged.error).toBe("DB boom");
    expect(logged.httpStatus).toBe(500);
  });

  it("does NOT increment ERRORS on 404 agreement-not-found", async () => {
    state.rows.agreements = [];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreement/${defaults.workAgreementAddress}/99`
    );
    expect(res.status).toBe(404);
    // 404 is not a server error — ERRORS metric must remain untouched.
    expect(getIndexedMetricsSnapshot()[INDEXED_METRICS.ERRORS]).toBeUndefined();
  });
});

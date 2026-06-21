import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ZodError } from "zod";

// Mock the db module (no real Postgres or config needed) and drizzle-orm
// helpers. Each query resolves to the rows configured for its table, records
// the limit/offset it was asked for, and returns [] for the innerJoin payroll
// lookup so the dedup path stays simple.
const { dbMock, schemaMock, state, limitSpy, offsetSpy } = vi.hoisted(() => {
  const limitSpy = vi.fn();
  const offsetSpy = vi.fn();
  const state = { rows: {} as Record<string, any[]> };

  function from(tableName: string) {
    let joined = false;
    const chain: any = {
      where: () => chain,
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
      then: (resolve: (rows: any[]) => unknown) =>
        resolve(joined ? [] : (state.rows[tableName] ?? [])),
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
  return { dbMock: db, schemaMock: schema, state, limitSpy, offsetSpy };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("drizzle-orm", () => ({
  eq: () => "eq",
  and: () => "and",
  or: () => "or",
  desc: () => "desc",
}));

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
      `/api/v1/indexed/agreement/${VALID}/12ab`
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
      `/api/v1/indexed/agreements/${VALID}/user/${VALID}?limit=10&offset=20`
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
      `/api/v1/indexed/agreements/${VALID}/user/${VALID}`
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.source).toBe("indexed");
  });

  it("returns 404 when an agreement is not found", async () => {
    state.rows.agreements = [];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreement/${VALID}/99`
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agreement not found");
  });

  it("returns aggregated detail when an agreement exists", async () => {
    state.rows.agreements = [{ id: "7", contractAddress: "c" }];
    state.rows.agreementEvents = [{ id: "e1" }];
    state.rows.payments = [{ id: "p1" }];
    state.rows.milestones = [{ id: "m1" }];
    state.rows.employees = [{ id: "emp1" }];
    state.rows.escrowEvents = [{ id: "x1" }];
    const res = await request(makeApp()).get(
      `/api/v1/indexed/agreement/${VALID}/7`
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
      `/api/v1/indexed/escrow/${VALID}/balance/7`
    );
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe("500");
    expect(res.body.agreement_id).toBe("7");
  });
});

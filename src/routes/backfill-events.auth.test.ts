import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Must use valid hex addresses — normalizeStarknetAddress rejects non-hex chars.
const { mockAdminAddress, mockNonAdminAddress, mockValidToken } = vi.hoisted(() => ({
  mockAdminAddress: "0x000000000000000000000000000000000000000000000000000000000000abc1",
  mockNonAdminAddress: "0x000000000000000000000000000000000000000000000000000000000000def2",
  mockValidToken: "valid-session-token",
}));

vi.mock("../config.js", () => ({
  env: { ADMIN_ADDRESSES: [mockAdminAddress] },
}));

vi.mock("../auth/session.js", () => ({
  requireSession: vi.fn(async (_address: string, token: string) => token === mockValidToken),
}));

vi.mock("../db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue({}),
    onConflictDoUpdate: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    transaction: vi.fn(async (cb: any) => cb({ insert: vi.fn().mockReturnThis() })),
  },
  schema: {
    agreementEvents: {
      id: "agreementEvents",
      eventType: "EmployeeAdded",
      blockNumber: "blockNumber",
      eventIndex: "eventIndex",
    },
    backfillProgress: {
      __table: "backfillProgress",
      jobName: "job_name",
    },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn((column: unknown, value: string) => ({ type: "eq", column, value })),
  };
});

import { backfillEventsRouter } from "./backfill-events.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", backfillEventsRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

const protectedRoutes: { path: string }[] = [
  { path: "/backfill/employee-events" },
  { path: "/backfill/milestone-events" },
];

describe("Backfill Events — authorization boundary, real middleware (Issue #263)", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
  });

  describe("no credentials → 401", () => {
    for (const route of protectedRoutes) {
      it(`POST ${route.path}`, async () => {
        const res = await request(app).post(`/api/v1${route.path}`);
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
      });
    }
  });

  describe("valid session but non-admin address → 403", () => {
    for (const route of protectedRoutes) {
      it(`POST ${route.path}`, async () => {
        const res = await request(app)
          .post(`/api/v1${route.path}`)
          .set("x-user-address", mockNonAdminAddress)
          .set("Authorization", `Bearer ${mockValidToken}`);
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: "Forbidden" });
      });
    }
  });

  describe("admin address but invalid session token → 401", () => {
    for (const route of protectedRoutes) {
      it(`POST ${route.path}`, async () => {
        const res = await request(app)
          .post(`/api/v1${route.path}`)
          .set("x-user-address", mockAdminAddress)
          .set("Authorization", "Bearer wrong-token");
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
      });
    }
  });

  describe("valid admin session → passes the auth gate", () => {
    for (const route of protectedRoutes) {
      it(`POST ${route.path} is not rejected by auth`, async () => {
        const res = await request(app)
          .post(`/api/v1${route.path}`)
          .set("x-user-address", mockAdminAddress)
          .set("Authorization", `Bearer ${mockValidToken}`);
        // Downstream logic may still fail (mocked DB returns empty
        // data) — this only asserts the auth gate itself let the request through.
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });
    }
  });
});

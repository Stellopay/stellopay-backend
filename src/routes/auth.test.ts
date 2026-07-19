import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import crypto from "node:crypto";

const { dbMock, schemaMock, mockState, eqMock, orMock, ltMock, isNotNullMock, mockProvider } = vi.hoisted(() => {
  const mockState = {
    sessions: [] as any[],
  };

  const mockProvider = {
    verifyMessageInStarknet: vi.fn(),
  };

  const schema = {
    sessions: {
      tokenHash: "tokenHash",
      address: "address",
      createdAt: "createdAt",
      expiresAt: "expiresAt",
      absoluteExpiresAt: "absoluteExpiresAt",
      revokedAt: "revokedAt",
      lastSeen: "lastSeen",
    },
  };

  const eqMock = (col: string, val: any) => (row: any) => row[col] === val;
  const orMock = (...fns: Array<(row: any) => boolean>) => (row: any) => fns.some((fn) => fn(row));
  const ltMock = (col: string, val: Date) => (row: any) =>
    row[col] instanceof Date ? row[col].getTime() < val.getTime() : false;
  const isNotNullMock = (col: string) => (row: any) =>
    row[col] !== null && row[col] !== undefined;

  const db = {
    insert: (table: any) => ({
      values: async (data: any) => {
        mockState.sessions.push({
          ...data,
          revokedAt: data.revokedAt || null,
          lastSeen: data.lastSeen || null,
        });
      },
    }),
    select: () => ({
      from: (table: any) => ({
        where: (conditionFn: (row: any) => boolean) => ({
          limit: (n: number) => {
            const filtered = mockState.sessions.filter(conditionFn);
            return {
              then: (resolve: any) => resolve(filtered.slice(0, n)),
            };
          },
        }),
      }),
    }),
    update: (table: any) => ({
      set: (updateData: any) => ({
        where: async (conditionFn: (row: any) => boolean) => {
          for (const row of mockState.sessions) {
            if (conditionFn(row)) {
              Object.assign(row, updateData);
            }
          }
        },
      }),
    }),
    delete: (table: any) => ({
      where: (conditionFn: (row: any) => boolean) => ({
        returning: async (returningFields: any) => {
          const matching: any[] = [];
          const remaining: any[] = [];
          for (const row of mockState.sessions) {
            if (conditionFn(row)) {
              matching.push(row);
            } else {
              remaining.push(row);
            }
          }
          mockState.sessions = remaining;
          return matching.map((row) => {
            const ret: any = {};
            for (const key of Object.keys(returningFields)) {
              ret[key] = row[key];
            }
            return ret;
          });
        },
      }),
    }),
  };

  return { dbMock: db, schemaMock: schema, mockState, eqMock, orMock, ltMock, isNotNullMock, mockProvider };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("../db/schema.js", () => ({ sessions: schemaMock.sessions }));
vi.mock("drizzle-orm", () => ({
  eq: eqMock,
  or: orMock,
  lt: ltMock,
  isNotNull: isNotNullMock,
}));

vi.mock("../starknet/client.js", () => ({
  provider: mockProvider,
  getCachedNetworkInfo: vi.fn().mockResolvedValue({ chainId: "0x534e5f5345504f4c4941" }),
}));

import { authRouter } from "./auth";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", authRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe("Auth Routes Integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockState.sessions = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles the complete authentication lifecycle including challenge, verification, validation, and logout", async () => {
    const address = "0x123456789abcdef";
    const appInstance = makeApp();

    // 1. Request a challenge nonce
    const challengeRes = await request(appInstance)
      .post("/api/v1/auth/challenge")
      .send({ address });

    expect(challengeRes.status).toBe(200);
    expect(challengeRes.body.address).toBe(address);
    expect(challengeRes.body.nonce).toBeDefined();
    expect(challengeRes.body.expires_in_ms).toBe(300000);

    const nonce = challengeRes.body.nonce;

    // Mock Starknet verifyMessageInStarknet to succeed
    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);

    // 2. Verify challenge signature and create session
    const verifyRes = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({
        address,
        signature: ["0xsignature1", "0xsignature2"],
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.ok).toBe(true);
    expect(verifyRes.body.session_token).toBeDefined();
    expect(verifyRes.body.expires_in_ms).toBeDefined();

    const sessionToken = verifyRes.body.session_token;

    // Verify database only has the SHA-256 hash
    expect(mockState.sessions).toHaveLength(1);
    const storedSession = mockState.sessions[0];
    const expectedHash = crypto.createHash("sha256").update(sessionToken).digest("hex");
    expect(storedSession.tokenHash).toBe(expectedHash);
    expect(storedSession.tokenHash).not.toBe(sessionToken);

    // 3. Validate session (valid token)
    const validateRes = await request(appInstance)
      .post("/api/v1/auth/session/validate")
      .send({
        address,
        session_token: sessionToken,
      });

    expect(validateRes.status).toBe(200);
    expect(validateRes.body.ok).toBe(true);
    expect(validateRes.body.address).toBe(address);

    // 4. Logout (revoke session)
    const logoutRes = await request(appInstance)
      .post("/api/v1/auth/logout")
      .set("x-user-address", address)
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.ok).toBe(true);

    // Verify revokedAt is set
    expect(storedSession.revokedAt).toBeInstanceOf(Date);

    // 5. Try to validate again (should fail because session is revoked)
    const validatePostLogoutRes = await request(appInstance)
      .post("/api/v1/auth/session/validate")
      .send({
        address,
        session_token: sessionToken,
      });

    expect(validatePostLogoutRes.status).toBe(401);
    expect(validatePostLogoutRes.body.ok).toBe(false);

    // 6. Try to logout again (should return 401 because session is revoked)
    const logoutPostLogoutRes = await request(appInstance)
      .post("/api/v1/auth/logout")
      .set("x-user-address", address)
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(logoutPostLogoutRes.status).toBe(401);
  });

  it("rejects verify once the challenge TTL has elapsed", async () => {
    const address = "0xExpiredChallenge";
    const appInstance = makeApp();

    const challengeRes = await request(appInstance)
      .post("/api/v1/auth/challenge")
      .send({ address });
    expect(challengeRes.status).toBe(200);

    vi.advanceTimersByTime(challengeRes.body.expires_in_ms + 1);

    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);
    const verifyRes = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({ address, signature: ["0xsig1", "0xsig2"] });

    expect(verifyRes.status).toBe(400);
    expect(verifyRes.body.error).toMatch(/No active challenge/);
  });

  it("rejects a replayed verify call reusing an already-consumed challenge", async () => {
    const address = "0xReplayAttempt";
    const appInstance = makeApp();

    const challengeRes = await request(appInstance)
      .post("/api/v1/auth/challenge")
      .send({ address });
    expect(challengeRes.status).toBe(200);

    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);

    const firstVerify = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({ address, signature: ["0xsig1", "0xsig2"] });
    expect(firstVerify.status).toBe(200);
    expect(firstVerify.body.ok).toBe(true);

    // Replay: same address/signature submitted again after the challenge was consumed.
    const secondVerify = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({ address, signature: ["0xsig1", "0xsig2"] });

    expect(secondVerify.status).toBe(400);
    expect(secondVerify.body.error).toMatch(/No active challenge/);
    // Only one session should have ever been created from the one valid challenge.
    expect(mockState.sessions).toHaveLength(1);
  });

  it("accepts a valid challenge exactly once, even when verify is attempted concurrently", async () => {
    const address = "0xConcurrentVerify";
    const appInstance = makeApp();

    const challengeRes = await request(appInstance)
      .post("/api/v1/auth/challenge")
      .send({ address });
    expect(challengeRes.status).toBe(200);

    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);

    // Fire two verify requests concurrently off the same still-valid challenge.
    const [res1, res2] = await Promise.all([
      request(appInstance)
        .post("/api/v1/auth/verify")
        .send({ address, signature: ["0xsig1", "0xsig2"] }),
      request(appInstance)
        .post("/api/v1/auth/verify")
        .send({ address, signature: ["0xsig1", "0xsig2"] }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // Exactly one succeeds; the other finds the challenge already consumed.
    expect(statuses).toEqual([200, 400]);
    expect(mockState.sessions).toHaveLength(1);
  });

  it("returns 401 for unauthorized endpoints with generic message", async () => {
    const appInstance = makeApp();

    const logoutRes = await request(appInstance)
      .post("/api/v1/auth/logout")
      .set("x-user-address", "0xabc")
      .set("Authorization", "Bearer invalidtoken12345");

    expect(logoutRes.status).toBe(401);
    expect(logoutRes.body.error).toBe("Unauthorized");
  });
});
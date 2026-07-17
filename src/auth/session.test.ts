import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const { dbMock, schemaMock, mockState, eqMock, orMock, ltMock, isNotNullMock } = vi.hoisted(() => {
  const mockState = {
    sessions: [] as any[],
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

  return { dbMock: db, schemaMock: schema, mockState, eqMock, orMock, ltMock, isNotNullMock };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("../db/schema.js", () => ({ sessions: schemaMock.sessions }));
vi.mock("drizzle-orm", () => ({
  eq: eqMock,
  or: orMock,
  lt: ltMock,
  isNotNull: isNotNullMock,
}));

import {
  createChallenge,
  getChallenge,
  clearChallenge,
  consumeChallenge,
  createSession,
  requireSession,
  revokeSession,
  sweepExpiredSessions,
} from "./session";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

describe("challenges", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues an active challenge that is readable before the TTL", () => {
    const { nonce, expires_in_ms } = createChallenge("0xAbC");
    expect(nonce).toMatch(/^0x[0-9a-f]{32}$/);
    expect(expires_in_ms).toBe(CHALLENGE_TTL_MS);
    expect(getChallenge("0xabc")?.nonce).toBe(nonce);
  });

  it("expires the challenge once the TTL elapses", () => {
    createChallenge("0xdead");
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    expect(getChallenge("0xdead")).toBeNull();
  });

  it("returns null after a challenge is cleared", () => {
    createChallenge("0xfeed");
    clearChallenge("0xfeed");
    expect(getChallenge("0xfeed")).toBeNull();
  });

  it("consumeChallenge returns the record exactly once, then null on reuse", () => {
    const { nonce } = createChallenge("0xC0FFEE");
    const first = consumeChallenge("0xc0ffee");
    expect(first?.nonce).toBe(nonce);
    const second = consumeChallenge("0xc0ffee");
    expect(second).toBeNull();
  });

  it("consumeChallenge rejects an expired challenge instead of returning it", () => {
    createChallenge("0xdeadbeef");
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    expect(consumeChallenge("0xdeadbeef")).toBeNull();
  });

  it("consumeChallenge deletes before any caller can read it again (closes the replay race)", () => {
    createChallenge("0xrace");
    // Simulates two concurrent /auth/verify requests reading the same nonce:
    // only the first should ever see a non-null record.
    const attempt1 = consumeChallenge("0xrace");
    const attempt2 = consumeChallenge("0xrace");
    expect(attempt1).not.toBeNull();
    expect(attempt2).toBeNull();
    expect(getChallenge("0xrace")).toBeNull();
  });
});

describe("sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockState.sessions = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates a token for its address (case-insensitive)", async () => {
    const { token } = await createSession("0xABCDEF");
    expect(await requireSession("0xabcdef", token)).toBe(true);
  });

  it("rejects an unknown token", async () => {
    expect(await requireSession("0xabc", "not-a-real-token")).toBe(false);
  });

  it("rejects a valid token used with a different address", async () => {
    const { token } = await createSession("0xaaa");
    expect(await requireSession("0xbbb", token)).toBe(false);
  });

  it("returns a real expires_in_ms instead of null", async () => {
    const { expires_in_ms } = await createSession("0x111");
    expect(expires_in_ms).toBeGreaterThan(0);
  });

  it("rejects and removes a session once its TTL elapses", async () => {
    const { token, expires_in_ms } = await createSession("0x222");
    vi.advanceTimersByTime(expires_in_ms + 1);
    expect(await requireSession("0x222", token)).toBe(false);
  });

  it("keeps a token valid at the exact expiry boundary", async () => {
    const { token, expires_in_ms } = await createSession("0x444");
    vi.advanceTimersByTime(expires_in_ms);
    expect(await requireSession("0x444", token)).toBe(true);
  });

  it("slides expiry forward each time a live session is used", async () => {
    const { token, expires_in_ms } = await createSession("0x333");
    vi.advanceTimersByTime(expires_in_ms - 1);
    expect(await requireSession("0x333", token)).toBe(true);
    vi.advanceTimersByTime(expires_in_ms - 1);
    expect(await requireSession("0x333", token)).toBe(true);
  });

  it("sweepExpiredSessions purges only expired/revoked entries and returns the count", async () => {
    const a = await createSession("0xa");
    const b = await createSession("0xb");
    vi.advanceTimersByTime(a.expires_in_ms + 1);
    const c = await createSession("0xc");
    await revokeSession(b.token); // revoke b
    expect(await sweepExpiredSessions()).toBe(2); // a (expired) and b (revoked)
    expect(await requireSession("0xc", c.token)).toBe(true);
  });

  it("persists only token hashes, never raw tokens", async () => {
    const { token } = await createSession("0xSecureUser");
    expect(mockState.sessions).toHaveLength(1);
    const stored = mockState.sessions[0];
    expect(stored.tokenHash).not.toBe(token);
    const hashed = crypto.createHash("sha256").update(token).digest("hex");
    expect(stored.tokenHash).toBe(hashed);
  });

  it("rejects a revoked session token", async () => {
    const { token } = await createSession("0xAddress");
    await revokeSession(token);
    expect(await requireSession("0xAddress", token)).toBe(false);
  });

  it("caps sliding expiry at the absolute expiry boundary", async () => {
    const { token } = await createSession("0xabc");
    // Standard session TTL is 24h, max absolute TTL is 7 days.
    // Slide it by accessing it every 12 hours for 6 days
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(12 * 60 * 60 * 1000);
      const ok = await requireSession("0xabc", token);
      expect(ok).toBe(true);
    }

    const stored = mockState.sessions[0];
    // Next expiresAt would normally be: 6 days + 24h = 7 days.
    // Let's verify it matches absoluteExpiresAt exactly.
    expect(stored.expiresAt.getTime()).toBe(stored.absoluteExpiresAt.getTime());
  });

  it("rejects a session after the absolute expiry boundary", async () => {
    const { token } = await createSession("0xabc");
    // Advance past 7 days limit
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1);

    const ok = await requireSession("0xabc", token);
    expect(ok).toBe(false);
  });
});
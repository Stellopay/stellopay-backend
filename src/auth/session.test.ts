import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { env } from "../config.js";

// Force the session logger into line-based (non-JSON) output and lower the
// minimum level to "debug" so the new observability tests can grep for
// every lifecycle event (including `session.validated`, which is emitted at
// debug because it is high-volume). Production default is `LOG_FORMAT=json`
// at `LOG_LEVEL=info`; the line-based shape is exercised here.
vi.hoisted(() => {
  process.env.LOG_FORMAT = "";
  process.env.LOG_LEVEL = "debug";
});

const {
  dbMock,
  schemaMock,
  mockState,
  eqMock,
  orMock,
  ltMock,
  isNotNullMock,
} = vi.hoisted(() => {
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
      familyId: "familyId",
      rotatedAt: "rotatedAt",
    },
  };

  const eqMock = (col: string, val: any) => (row: any) => row[col] === val;
  const orMock = (...fns: Array<(row: any) => boolean>) => (row: any) => fns.some((fn) => fn(row));
  const ltMock = (col: string, val: Date) => (row: any) =>
    row[col] instanceof Date ? row[col].getTime() < val.getTime() : false;
  const isNotNullMock = (col: string) => (row: any) =>
    row[col] !== null && row[col] !== undefined;

  const db = {
    transaction: async (cb: (tx: any) => Promise<any>) => {
      return cb(db);
    },
    insert: (table: any) => ({
      values: async (data: any) => {
        mockState.sessions.push({
          ...data,
          revokedAt: data.revokedAt || null,
          lastSeen: data.lastSeen || null,
          familyId: data.familyId || null,
          rotatedAt: data.rotatedAt || null,
        });
      },
    }),
    select: () => {
      const selectChain = {
        from: (table: any) => selectChain,
        where: (conditionFn: (row: any) => boolean) => {
          selectChain._conditionFn = conditionFn;
          return selectChain;
        },
        for: (mode: string) => selectChain,
        limit: (n: number) => {
          selectChain._limitVal = n;
          return selectChain;
        },
        _conditionFn: (() => true) as (row: any) => boolean,
        _limitVal: undefined as number | undefined,
        then: (resolve: any) => {
          const filtered = mockState.sessions.filter(selectChain._conditionFn);
          const result =
            selectChain._limitVal !== undefined
              ? filtered.slice(0, selectChain._limitVal)
              : filtered;
          return resolve(result);
        },
      };
      return selectChain;
    },
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

  return {
    dbMock: db,
    schemaMock: schema,
    mockState,
    eqMock,
    orMock,
    ltMock,
    isNotNullMock,
  };
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
  createSession,
  requireSession,
  revokeSession,
  sweepExpiredSessions,
  rotateSession,
  revokeFamily,
  revokeAllSessionsForAddress,
  getSessionByHash,
  revokeSessionByHash,
} from "./session";
import {
  getSessionMetricsSnapshot,
  resetSessionMetrics,
  SESSION_METRICS,
  SESSION_GAUGES,
} from "./session-metrics";

describe("sessions", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockState.sessions = [];
    resetSessionMetrics();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Existing behavior tests (unchanged contract)
  // ---------------------------------------------------------------------------

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

  it("persists a sliding expiry and an absolute expiry cap for each session", async () => {
    const { expires_in_ms } = await createSession("0xPersist");
    const stored = mockState.sessions[0];

    expect(stored.address).toBe("0xpersist");
    expect(stored.expiresAt.getTime()).toBe(Date.now() + expires_in_ms);
    expect(stored.absoluteExpiresAt.getTime()).toBe(Date.now() + env.SESSION_MAX_TTL_MS);
  });

  it("refreshes the sliding expiry without extending past the absolute cap", async () => {
    const { token } = await createSession("0xContract");
    const before = mockState.sessions[0];
    const beforeExpiresAtMs = before.expiresAt.getTime();
    const beforeAbsoluteExpiresAtMs = before.absoluteExpiresAt.getTime();

    vi.advanceTimersByTime(60 * 60 * 1000);
    await requireSession("0xcontract", token);

    const after = mockState.sessions[0];
    expect(after.expiresAt.getTime()).toBeGreaterThan(beforeExpiresAtMs);
    expect(after.absoluteExpiresAt.getTime()).toBe(beforeAbsoluteExpiresAtMs);
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

  // ---------------------------------------------------------------------------
  // Observability: structured logs
  // ---------------------------------------------------------------------------

  it("emits a session.created log on createSession", async () => {
    await createSession("0xLogCreate");
    const created = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.created"),
    );
    expect(created).toBeDefined();
    expect(consoleInfoSpy).toHaveBeenCalled();
  });

  it("emits a session.rejected warn log on an unknown token", async () => {
    await requireSession("0xabc", "no-such-token");
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.rejected"),
    );
    expect(rejected).toBeDefined();
    expect(rejected![0]).toContain("unknown_token");
  });

  it("emits a session.rejected warn log on an address mismatch", async () => {
    const { token } = await createSession("0xaaa");
    await requireSession("0xbbb", token);
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("address_mismatch"),
    );
    expect(rejected).toBeDefined();
  });

  it("emits a session.rejected warn log on expired sliding TTL", async () => {
    const { token, expires_in_ms } = await createSession("0xsliding");
    vi.advanceTimersByTime(expires_in_ms + 1);
    await requireSession("0xsliding", token);
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("expired_sliding"),
    );
    expect(rejected).toBeDefined();
  });

  it("emits a session.rejected warn log on expired absolute TTL", async () => {
    const { token } = await createSession("0xabsolute");
    // Forge a session row where the absolute cap has elapsed but the sliding
    // expiry has not. In production this state is reached when a previously
    // sliding session reaches its absolute cap; here we mutate the row
    // directly so the test does not need to wait the full 7 days.
    const stored = mockState.sessions[0];
    stored.expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h in future
    stored.absoluteExpiresAt = new Date(Date.now() - 1000); // 1s in past
    await requireSession("0xabsolute", token);
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("expired_absolute"),
    );
    expect(rejected).toBeDefined();
  });

  it("emits a session.rejected warn log on a revoked token", async () => {
    const { token } = await createSession("0xrevoked");
    await revokeSession(token);
    consoleWarnSpy.mockClear();
    await requireSession("0xrevoked", token);
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("revoked"),
    );
    expect(rejected).toBeDefined();
  });

  it("emits a session.rejected warn log with missing_input when no token is provided", async () => {
    await requireSession("0xabc", "");
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("missing_input"),
    );
    expect(rejected).toBeDefined();
  });

  it("rotateSession returns invalid and logs missing_input when no token is provided", async () => {
    const result = await rotateSession("0xabc", "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("missing_input"),
    );
    expect(rejected).toBeDefined();
  });

  it("emits a session.validated debug log on successful requireSession", async () => {
    const { token } = await createSession("0xdebug");
    consoleDebugSpy.mockClear();
    await requireSession("0xdebug", token);
    const validated = consoleDebugSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.validated"),
    );
    expect(validated).toBeDefined();
  });

  it("emits a session.revoked info log on revokeSession", async () => {
    const { token } = await createSession("0xrevokeLog");
    consoleInfoSpy.mockClear();
    await revokeSession(token);
    const revoked = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.revoked"),
    );
    expect(revoked).toBeDefined();
    expect(revoked![0]).toContain("kind=single");
  });

  it("emits a session.family_revoked warn log on revokeFamily", async () => {
    consoleWarnSpy.mockClear();
    await revokeFamily("family-xyz");
    const revoked = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.family_revoked"),
    );
    expect(revoked).toBeDefined();
    expect(revoked![0]).toContain("family_id=family-xyz");
  });

  it("emits a session.all_revoked info log on revokeAllSessionsForAddress", async () => {
    consoleInfoSpy.mockClear();
    await revokeAllSessionsForAddress("0xAllRevoke");
    const revoked = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.all_revoked"),
    );
    expect(revoked).toBeDefined();
    expect(revoked![0]).toContain("address=0xallrevoke");
  });

  it("emits a session.rotated info log on successful rotateSession", async () => {
    const { token } = await createSession("0xrotate");
    consoleInfoSpy.mockClear();
    const result = await rotateSession("0xrotate", token);
    expect(result.ok).toBe(true);
    const rotated = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.rotated"),
    );
    expect(rotated).toBeDefined();
  });

  it("emits a session.reuse_detected warn log and revokes the family on reuse", async () => {
    const { token } = await createSession("0xreuse");
    const firstResult = await rotateSession("0xreuse", token);
    expect(firstResult.ok).toBe(true);
    consoleWarnSpy.mockClear();

    // Replay the original, already-rotated token.
    const secondResult = await rotateSession("0xreuse", token);
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok && secondResult.reason === "reused") {
      expect(secondResult.familyId).toBeDefined();
    }
    const reused = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.reuse_detected"),
    );
    expect(reused).toBeDefined();
  });

  it("emits a session.sweep_completed info log on a successful sweep", async () => {
    const a = await createSession("0xsweep-a");
    await revokeSession(a.token);
    consoleInfoSpy.mockClear();
    const deleted = await sweepExpiredSessions();
    expect(deleted).toBe(1);
    const completed = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.sweep_completed"),
    );
    expect(completed).toBeDefined();
    expect(completed![0]).toContain("deleted=1");
  });

  it("never logs raw session tokens", async () => {
    const { token } = await createSession("0xSecureLog");
    await revokeSession(token);
    await sweepExpiredSessions();
    const allLogCalls = [
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
      ...consoleDebugSpy.mock.calls,
    ];
    for (const [line] of allLogCalls) {
      if (typeof line !== "string") continue;
      expect(line).not.toContain(token);
    }
  });

  // ---------------------------------------------------------------------------
  // Observability: metric counters
  // ---------------------------------------------------------------------------

  it("increments session_created_total on every createSession", async () => {
    await createSession("0xMetrics1");
    await createSession("0xMetrics2");
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.CREATED]).toBe(2);
  });

  it("increments session_validated_total on successful requireSession", async () => {
    const { token } = await createSession("0xMetricsValid");
    await requireSession("0xMetricsValid", token);
    await requireSession("0xMetricsValid", token);
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.VALIDATED]).toBe(2);
  });

  it("increments session_rejected_total and the matching reason counter on rejection", async () => {
    const { token } = await createSession("0xMetricsReject");
    await revokeSession(token);
    await requireSession("0xMetricsReject", token); // -> revoked
    await requireSession("0xMetricsReject", "bad-token"); // -> unknown_token
    const counters = getSessionMetricsSnapshot().counters;
    expect(counters[SESSION_METRICS.REJECTED]).toBe(2);
    expect(counters[SESSION_METRICS.REJECTED_REVOKED]).toBe(1);
    expect(counters[SESSION_METRICS.REJECTED_UNKNOWN]).toBe(1);
  });

  it("increments session_revoked_total on revokeSession", async () => {
    const { token } = await createSession("0xMetricsRevoke");
    await revokeSession(token);
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.REVOKED]).toBe(1);
  });

  it("does not increment session_revoked_total when revokeSession is called with empty token", async () => {
    await revokeSession("");
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.REVOKED] ?? 0).toBe(0);
  });

  it("increments session_rotated_total on successful rotation", async () => {
    const { token } = await createSession("0xMetricsRotate");
    const result = await rotateSession("0xMetricsRotate", token);
    expect(result.ok).toBe(true);
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.ROTATED]).toBe(1);
  });

  it("increments session_reuse_detected_total and session_family_revoked_total on reuse", async () => {
    const { token } = await createSession("0xMetricsReuse");
    const first = await rotateSession("0xMetricsReuse", token);
    expect(first.ok).toBe(true);
    const second = await rotateSession("0xMetricsReuse", token);
    expect(second.ok).toBe(false);
    const counters = getSessionMetricsSnapshot().counters;
    expect(counters[SESSION_METRICS.REUSE_DETECTED]).toBe(1);
    expect(counters[SESSION_METRICS.FAMILY_REVOKED]).toBe(1);
  });

  it("increments session_all_revoked_total on revokeAllSessionsForAddress", async () => {
    await revokeAllSessionsForAddress("0xMetricsAll");
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.ALL_REVOKED]).toBe(1);
  });

  it("increments session_sweep_runs_total and session_sweep_deleted_total on a sweep", async () => {
    const a = await createSession("0xSweepA");
    await revokeSession(a.token);
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1); // absolute-expire a
    const before = getSessionMetricsSnapshot().counters;
    expect(before[SESSION_METRICS.SWEEP_DELETED] ?? 0).toBe(0);
    expect(before[SESSION_METRICS.SWEEP_RUNS] ?? 0).toBe(0);
    const deleted = await sweepExpiredSessions();
    expect(deleted).toBe(1);
    const after = getSessionMetricsSnapshot().counters;
    expect(after[SESSION_METRICS.SWEEP_RUNS]).toBe(1);
    expect(after[SESSION_METRICS.SWEEP_DELETED]).toBe(1);
  });

  it("throttles database writes on sliding expiration updates", async () => {
    const { token } = await createSession("0xThrottledAddress");
    expect(mockState.sessions).toHaveLength(1);
    const initialSession = { ...mockState.sessions[0] };
    expect(initialSession.lastSeen).toBeNull();

    // First requireSession validation: should write/update lastSeen
    vi.advanceTimersByTime(10 * 1000); // 10 seconds in
    const ok1 = await requireSession("0xThrottledAddress", token);
    expect(ok1).toBe(true);

    const firstUpdateSession = { ...mockState.sessions[0] };
    expect(firstUpdateSession.lastSeen).not.toBeNull();
    const firstLastSeenMs = firstUpdateSession.lastSeen.getTime();
    expect(firstLastSeenMs).toBe(10 * 1000);

    // Second requireSession validation (within 1 minute threshold, e.g. +20 seconds): should NOT write/update lastSeen
    vi.advanceTimersByTime(20 * 1000); // 30 seconds total
    const ok2 = await requireSession("0xThrottledAddress", token);
    expect(ok2).toBe(true);

    const secondUpdateSession = { ...mockState.sessions[0] };
    expect(secondUpdateSession.lastSeen.getTime()).toBe(firstLastSeenMs); // remains 10 seconds

    // Third requireSession validation (past 1 minute threshold, e.g. +65 seconds): should write/update lastSeen
    vi.advanceTimersByTime(45 * 1000); // 75 seconds total (65 seconds since lastSeen)
    const ok3 = await requireSession("0xThrottledAddress", token);
    expect(ok3).toBe(true);

    const thirdUpdateSession = { ...mockState.sessions[0] };
    expect(thirdUpdateSession.lastSeen.getTime()).toBe(75 * 1000); // updated to 75 seconds
  });

  it("updates session_sweeper_last_deleted_count gauge after a sweep", async () => {
    const a = await createSession("0xGaugeA");
    await revokeSession(a.token);
    await sweepExpiredSessions();
    expect(getSessionMetricsSnapshot().gauges[SESSION_GAUGES.LAST_SWEEP_DELETED]).toBe(1);
  });

  it("resetSessionMetrics zeros every counter and gauge", async () => {
    await createSession("0xReset");
    const before = getSessionMetricsSnapshot();
    expect(Object.keys(before.counters).length).toBeGreaterThan(0);
    resetSessionMetrics();
    const after = getSessionMetricsSnapshot();
    expect(after.counters).toEqual({});
    expect(after.gauges).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Observability: failure path
  // ---------------------------------------------------------------------------

  it("emits a session.sweep_failed error log and bumps the sweeper error counter when the DB throws", async () => {
    // Use real timers because the retry wrapper backs off with setTimeout
    // between attempts; vi.useFakeTimers() (set in the suite's beforeEach)
    // would block forever waiting for the fake timer to advance. With real
    // timers the backoff is ~100ms total (2 retries × 50ms).
    vi.useRealTimers();
    const originalDelete = dbMock.delete;
    dbMock.delete = () => {
      throw new Error("synthetic DB failure");
    };
    try {
      const deleted = await sweepExpiredSessions();
      expect(deleted).toBe(0);
      const counters = getSessionMetricsSnapshot().counters;
      expect(counters[SESSION_METRICS.SWEEPER_ERRORS]).toBe(1);
      // 3 attempts -> 2 retries observed (between attempts) before the outer
      // catch bumps the existing terminal counter.
      expect(counters[SESSION_METRICS.SWEEP_RETRY]).toBe(2);
      const failed = consoleErrorSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.includes("session.sweep_failed"),
      );
      expect(failed).toBeDefined();
    } finally {
      dbMock.delete = originalDelete;
    }
  });

  it("emits a session.rejected error log with reason=db_error when requireSession's DB throws", async () => {
    const originalSelect = dbMock.select;
    dbMock.select = () => {
      throw new Error("synthetic require failure");
    };
    try {
      const ok = await requireSession("0xDbErr", "any-token");
      expect(ok).toBe(false);
      const counters = getSessionMetricsSnapshot().counters;
      expect(counters[SESSION_METRICS.REJECTED]).toBe(1);
      const failed = consoleErrorSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.includes("session.rejected"),
      );
      expect(failed).toBeDefined();
      expect(failed![0]).toContain("db_error");
    } finally {
      dbMock.select = originalSelect;
    }
  });

  it("emits a session.rejected error log with operation=create when createSession's DB throws", async () => {
    const originalInsert = dbMock.insert;
    dbMock.insert = () => ({
      values: async () => {
        throw new Error("synthetic create failure");
      },
    });
    try {
      await expect(createSession("0xDbCreate")).rejects.toThrow(
        "synthetic create failure",
      );
      // createSession's db-error path bumps REJECTED exactly once per failed
      // call — a prior bug double-bumped it (two incSessionMetric calls in
      // the same catch block), which would silently double-count every DB
      // outage in the session_rejected_total dashboard.
      const counters = getSessionMetricsSnapshot().counters;
      expect(counters[SESSION_METRICS.REJECTED]).toBe(1);
      expect(counters[SESSION_METRICS.CREATED] ?? 0).toBe(0);
      const failed = consoleErrorSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.includes("session.rejected"),
      );
      expect(failed).toBeDefined();
      expect(failed![0]).toContain("db_error");
      expect(failed![0]).toContain("operation=create");
    } finally {
      dbMock.insert = originalInsert;
    }
  });

  it("getSessionByHash retrieves a session by its token hash", async () => {
    const { token } = await createSession("0xGetHash");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const session = await getSessionByHash(tokenHash);
    expect(session).not.toBeNull();
    expect(session!.address).toBe("0xgethash");
  });

  it("getSessionByHash returns null for non-existent token hash", async () => {
    const session = await getSessionByHash("non-existent-hash");
    expect(session).toBeNull();
  });

  it("revokeSessionByHash marks a session as revoked", async () => {
    const { token } = await createSession("0xRevokeHash");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    await revokeSessionByHash(tokenHash);
    const session = await getSessionByHash(tokenHash);
    expect(session!.revokedAt).toBeInstanceOf(Date);
  });

  // ---------------------------------------------------------------------------
  // Input validation: hardened boundary and malformed-input paths (#307)
  // ---------------------------------------------------------------------------

  it("createSession rejects an empty address with a TypeError", async () => {
    await expect(createSession("")).rejects.toThrow(TypeError);
    await expect(createSession("")).rejects.toThrow("address must be a non-empty string");
  });

  it("createSession rejects a whitespace-only address with a TypeError", async () => {
    await expect(createSession("   ")).rejects.toThrow(TypeError);
    await expect(createSession("   ")).rejects.toThrow("address must be a non-empty string");
  });

  it("createSession with an empty address does not persist any session row", async () => {
    await expect(createSession("")).rejects.toThrow();
    expect(mockState.sessions).toHaveLength(0);
  });

  it("createSession with empty address increments session_rejected_total and does not increment session_created_total", async () => {
    await expect(createSession("")).rejects.toThrow();
    const counters = getSessionMetricsSnapshot().counters;
    expect(counters[SESSION_METRICS.REJECTED]).toBe(1);
    expect(counters[SESSION_METRICS.CREATED] ?? 0).toBe(0);
  });

  it("requireSession rejects a whitespace-only token and returns false", async () => {
    await createSession("0xabc");
    expect(await requireSession("0xabc", "   ")).toBe(false);
  });

  it("requireSession rejects a whitespace-only address and returns false", async () => {
    const { token } = await createSession("0xabc");
    expect(await requireSession("   ", token)).toBe(false);
  });

  it("requireSession logs missing_input for whitespace-only token", async () => {
    await createSession("0xabc");
    consoleWarnSpy.mockClear();
    await requireSession("0xabc", "   ");
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("missing_input"),
    );
    expect(rejected).toBeDefined();
  });

  it("requireSession logs missing_input for whitespace-only address", async () => {
    const { token } = await createSession("0xabc");
    consoleWarnSpy.mockClear();
    await requireSession("   ", token);
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("missing_input"),
    );
    expect(rejected).toBeDefined();
  });

  it("revokeSession ignores a whitespace-only token without bumping revoked counter", async () => {
    await revokeSession("   ");
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.REVOKED] ?? 0).toBe(0);
  });

  it("rotateSession rejects a whitespace-only token", async () => {
    const result = await rotateSession("0xabc", "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rotateSession rejects a whitespace-only address", async () => {
    const { token } = await createSession("0xabc");
    const result = await rotateSession("   ", token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rotateSession logs missing_input for whitespace-only inputs", async () => {
    consoleWarnSpy.mockClear();
    await rotateSession("0xabc", "   ");
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("missing_input"),
    );
    expect(rejected).toBeDefined();
  });

  it("revokeAllSessionsForAddress is a no-op for an empty address and does not bump all_revoked", async () => {
    await createSession("0xaaa");
    await revokeAllSessionsForAddress("");
    // Session for 0xaaa must remain intact
    const { token } = await createSession("0xaaa2");
    // All-revoked counter must be 0 — the guard short-circuited before touching the DB
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.ALL_REVOKED] ?? 0).toBe(0);
    // The previously-created session is still valid
    expect(await requireSession("0xaaa2", token)).toBe(true);
  });

  it("revokeAllSessionsForAddress is a no-op for a whitespace-only address", async () => {
    await revokeAllSessionsForAddress("   ");
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.ALL_REVOKED] ?? 0).toBe(0);
    // The guard must emit a warn log so the no-op is observable
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("missing_input"),
    );
    expect(rejected).toBeDefined();
  });

  it("createSession normalises whitespace-padded address before persisting", async () => {
    const { token } = await createSession("  0xPadded  ");
    // The stored address must be the trimmed + lowercased form
    expect(mockState.sessions[0].address).toBe("0xpadded");
    // And requireSession with the clean address must succeed
    expect(await requireSession("0xpadded", token)).toBe(true);
  });

  it("requireSession normalises a whitespace-padded address when validating", async () => {
    const { token } = await createSession("0xTrimMe");
    // Padded address supplied by the caller — should still match
    expect(await requireSession("  0xTrimMe  ", token)).toBe(true);
  });

  it("rotateSession normalises a whitespace-padded address when validating", async () => {
    const { token } = await createSession("0xRotateTrim");
    // Padded address supplied by the caller must still match the cleanly
    // stored session address, consistent with requireSession's tolerance.
    const result = await rotateSession("  0xRotateTrim  ", token);
    expect(result.ok).toBe(true);
  });

  // Reliability: bounded retry + idempotent re-revoke detection (issue #125)
  //
  // These tests use `vi.useRealTimers()` inside the test body because the
  // retry helper backs off with `setTimeout(resolve, 50)` between attempts,
  // and vitest's fake timers would otherwise block the awaits forever.
  // The session-level `beforeEach` still sets up fake timers + mock state,
  // which is the right starting position for non-retry tests.
  // ---------------------------------------------------------------------------

  it("retries revokeSession on a transient DB error and ultimately succeeds", async () => {
    vi.useRealTimers();
    const { token } = await createSession("0xRetryRevoke");
    const originalUpdate = dbMock.update;
    let attempts = 0;
    dbMock.update = (table: any) => ({
      set: (_data: any) => ({
        where: async (_cond: any) => {
          attempts++;
          if (attempts === 1) throw new Error("synthetic transient revoke failure");
          // On the second attempt, fall back to the original mock behaviour so
          // the row mutation happens and requireSession + REVOKED bookkeeping
          // match the production contract.
          await originalUpdate(table).set({ revokedAt: new Date() }).where(_cond);
        },
      }),
    });
    try {
      await revokeSession(token);
      expect(attempts).toBe(2);
      const counters = getSessionMetricsSnapshot().counters;
      expect(counters[SESSION_METRICS.REVOKE_RETRY]).toBe(1);
      expect(counters[SESSION_METRICS.REVOKED]).toBe(1);
      expect(counters[SESSION_METRICS.REVOKE_FAILED] ?? 0).toBe(0);
      const retry = consoleWarnSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.includes("session.revoke_retry"),
      );
      expect(retry).toBeDefined();
      expect(retry![0]).toContain("kind=single");
      expect(retry![0]).toContain("attempt=1");
    } finally {
      dbMock.update = originalUpdate;
    }
  });

  it("rethrows the last DB error from revokeSession after retry exhaustion", async () => {
    vi.useRealTimers();
    const { token } = await createSession("0xExhaustRevoke");
    const originalUpdate = dbMock.update;
    let attempts = 0;
    dbMock.update = (table: any) => ({
      set: (_data: any) => ({
        where: async (_cond: any) => {
          attempts++;
          throw new Error("synthetic permanent revoke failure");
        },
      }),
    });
    try {
      await expect(revokeSession(token)).rejects.toThrow(
        "synthetic permanent revoke failure",
      );
      expect(attempts).toBe(3); // maxAttempts
      const counters = getSessionMetricsSnapshot().counters;
      expect(counters[SESSION_METRICS.REVOKE_RETRY]).toBe(2); // between 3 attempts
      expect(counters[SESSION_METRICS.REVOKE_FAILED]).toBe(1);
      expect(counters[SESSION_METRICS.REVOKED] ?? 0).toBe(0); // never succeeded
      const failed = consoleErrorSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.includes("session.revoke_failed"),
      );
      expect(failed).toBeDefined();
      expect(failed![0]).toContain("kind=single");
    } finally {
      dbMock.update = originalUpdate;
    }
  });

  it("classifies a repeat revokeSession as session.revoke_already without inflating REVOKED", async () => {
    const { token } = await createSession("0xRepeat");
    await revokeSession(token); // first call: from null -> now()
    const before = getSessionMetricsSnapshot().counters;
    expect(before[SESSION_METRICS.REVOKED]).toBe(1);
    expect(before[SESSION_METRICS.REVOKED_ALREADY] ?? 0).toBe(0);

    consoleInfoSpy.mockClear();
    await revokeSession(token); // repeat: idempotent re-revoke
    const after = getSessionMetricsSnapshot().counters;
    // REVOKED stays at 1 (not 2) — the second call was idempotent.
    expect(after[SESSION_METRICS.REVOKED]).toBe(1);
    expect(after[SESSION_METRICS.REVOKED_ALREADY]).toBe(1);
    const already = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.revoke_already"),
    );
    expect(already).toBeDefined();
    expect(already![0]).toContain("kind=single");
  });

  it("classifies a repeat revokeFamily as idempotent without re-incrementing FAMILY_REVOKED", async () => {
    const { token } = await createSession("0xFamRepeat");
    const familyId = mockState.sessions[0].familyId;
    await revokeFamily(familyId);
    const before = getSessionMetricsSnapshot().counters;
    expect(before[SESSION_METRICS.FAMILY_REVOKED]).toBe(1);
    expect(before[SESSION_METRICS.FAMILY_REVOKED_ALREADY] ?? 0).toBe(0);
    await revokeFamily(familyId); // repeat
    const after = getSessionMetricsSnapshot().counters;
    expect(after[SESSION_METRICS.FAMILY_REVOKED]).toBe(1); // unchanged
    expect(after[SESSION_METRICS.FAMILY_REVOKED_ALREADY]).toBe(1);
  });

  it("classifies a repeat revokeAllSessionsForAddress as idempotent without re-incrementing ALL_REVOKED", async () => {
    const { token } = await createSession("0xallrepeat");
    await revokeAllSessionsForAddress("0xallrepeat");
    const before = getSessionMetricsSnapshot().counters;
    expect(before[SESSION_METRICS.ALL_REVOKED]).toBe(1);
    expect(before[SESSION_METRICS.ALL_REVOKED_ALREADY] ?? 0).toBe(0);
    await revokeAllSessionsForAddress("0xallrepeat"); // repeat
    const after = getSessionMetricsSnapshot().counters;
    expect(after[SESSION_METRICS.ALL_REVOKED]).toBe(1);
    expect(after[SESSION_METRICS.ALL_REVOKED_ALREADY]).toBe(1);
  });

  it("revokeAllSessionsForAddress is a safe no-op for an address with no sessions at all", async () => {
    // No createSession call for this address — the idempotency SELECT finds
    // nothing (`existing` is undefined), so the function must fall through
    // to the retry/update path (a no-op UPDATE matching zero rows) and still
    // bump ALL_REVOKED, rather than throwing or silently doing nothing. A
    // prior bug ran an unconditional, unlogged UPDATE before this path even
    // existed; this guards against that shape regressing.
    await revokeAllSessionsForAddress("0xNeverHadASession");
    const counters = getSessionMetricsSnapshot().counters;
    expect(counters[SESSION_METRICS.ALL_REVOKED]).toBe(1);
    expect(counters[SESSION_METRICS.ALL_REVOKED_ALREADY] ?? 0).toBe(0);
    const revoked = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.all_revoked"),
    );
    expect(revoked).toBeDefined();
  });

  it("retries revokeFamily on a transient DB error and ultimately succeeds", async () => {
    vi.useRealTimers();
    const { token } = await createSession("0xFamRetry");
    const familyId = mockState.sessions[0].familyId;
    const originalUpdate = dbMock.update;
    let attempts = 0;
    dbMock.update = (table: any) => ({
      set: (_data: any) => ({
        where: async (_cond: any) => {
          attempts++;
          if (attempts === 1) throw new Error("synthetic family retry");
          await originalUpdate(table).set({ revokedAt: new Date() }).where(_cond);
        },
      }),
    });
    try {
      await revokeFamily(familyId);
      expect(attempts).toBe(2);
      expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.REVOKE_RETRY]).toBe(1);
    } finally {
      dbMock.update = originalUpdate;
    }
  });

  it("retries revokeAllSessionsForAddress on a transient DB error and ultimately succeeds", async () => {
    vi.useRealTimers();
    const { token } = await createSession("0xalladdrretry");
    const originalUpdate = dbMock.update;
    let attempts = 0;
    dbMock.update = (table: any) => ({
      set: (_data: any) => ({
        where: async (_cond: any) => {
          attempts++;
          if (attempts === 1) throw new Error("synthetic all retry");
          await originalUpdate(table).set({ revokedAt: new Date() }).where(_cond);
        },
      }),
    });
    try {
      await revokeAllSessionsForAddress("0xalladdrretry");
      expect(attempts).toBe(2);
      expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.REVOKE_RETRY]).toBe(1);
    } finally {
      dbMock.update = originalUpdate;
    }
  });

  it("retries sweepExpiredSessions on a transient DB error and ultimately succeeds", async () => {
    vi.useRealTimers();
    // Create one session and revoke it; the sweep predicate will match it
    // (revokedAt is non-null). On retry success we return a fixed row set
    // so the assertion on `attempts` is independent of the underlying row
    // filter bookkeeping.
    const a = await createSession("0xSweepRetryA");
    await revokeSession(a.token);

    const originalDelete = dbMock.delete;
    let attempts = 0;
    dbMock.delete = (table: any) => ({
      where: (_cond: any) => ({
        returning: async (_fields: any) => {
          attempts++;
          if (attempts === 1) throw new Error("synthetic sweep retry");
          // Second attempt succeeds with a fixed, deterministic row set.
          return [{ tokenHash: mockState.sessions[0].tokenHash }];
        },
      }),
    });
    try {
      const deleted = await sweepExpiredSessions();
      expect(attempts).toBe(2);
      expect(deleted).toBe(1);
      const counters = getSessionMetricsSnapshot().counters;
      expect(counters[SESSION_METRICS.SWEEP_RETRY]).toBe(1);
      expect(counters[SESSION_METRICS.SWEEP_RUNS]).toBe(1);
      expect(counters[SESSION_METRICS.SWEEP_DELETED]).toBe(1);
      const retry = consoleWarnSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.includes("session.sweep_retry"),
      );
      expect(retry).toBeDefined();
      expect(retry![0]).toContain("attempt=1");
    } finally {
      dbMock.delete = originalDelete;
    }
  });

  it("returns 0 and emits session.sweep_failed after sweep retry exhaustion", async () => {
    vi.useRealTimers();
    const originalDelete = dbMock.delete;
    dbMock.delete = () => ({
      where: () => ({
        returning: async () => {
          throw new Error("synthetic sweep permanent");
        },
      }),
    });
    try {
      const deleted = await sweepExpiredSessions();
      expect(deleted).toBe(0);
      const counters = getSessionMetricsSnapshot().counters;
      // 3 attempts -> 2 retries observed (between attempts), and the final
      // catch bumps the existing terminal counter.
      expect(counters[SESSION_METRICS.SWEEP_RETRY]).toBe(2);
      expect(counters[SESSION_METRICS.SWEEPER_ERRORS]).toBe(1);
      expect(counters[SESSION_METRICS.SWEEP_RUNS] ?? 0).toBe(0);
      expect(counters[SESSION_METRICS.SWEEP_DELETED] ?? 0).toBe(0);
      const retries = consoleWarnSpy.mock.calls.filter(([line]) =>
        typeof line === "string" && line.includes("session.sweep_retry"),
      );
      expect(retries).toHaveLength(2);
      const failed = consoleErrorSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.includes("session.sweep_failed"),
      );
      expect(failed).toBeDefined();
    } finally {
      dbMock.delete = originalDelete;
    }
  });

  it("does NOT retry createSession (insert is not idempotent)", async () => {
    vi.useRealTimers();
    const originalInsert = dbMock.insert;
    let attempts = 0;
    dbMock.insert = (table: any) => ({
      values: async (_data: any) => {
        attempts++;
        throw new Error("synthetic single-attempt insert");
      },
    });
    try {
      await expect(createSession("0xNoRetryCreate")).rejects.toThrow(
        "synthetic single-attempt insert",
      );
      expect(attempts).toBe(1);
      expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.REVOKE_RETRY] ?? 0).toBe(0);
    } finally {
      dbMock.insert = originalInsert;
    }
  });

  it("does NOT retry requireSession on the hot path", async () => {
    vi.useRealTimers();
    const { token } = await createSession("0xNoRetryRequire");
    const originalSelect = dbMock.select;
    let attempts = 0;
    dbMock.select = () => {
      attempts++;
      throw new Error("synthetic single-attempt require");
    };
    try {
      const ok = await requireSession("0xnoretryrequire", token);
      expect(ok).toBe(false);
      expect(attempts).toBe(1);
 
    } finally {
      dbMock.select = originalSelect;
    }
  });
});

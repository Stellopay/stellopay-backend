import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response } from "express";
import request from "supertest";
import {
  current as fakeDbHolder,
  type FakeIdempotencyDb,
  type FakeRow,
} from "./test-support/fake-idempotency-db.js";

// The idempotency store reads `db` from `../db/index.js`. Route the store at
// the real `db.execute` seam against an in-memory fake that enforces the
// `(route, key)` unique constraint — two limiter instances created in these
// tests share nothing except this mocked database module, which is exactly the
// cross-instance behaviour under test.
vi.mock("../db/index.js", async () => {
  const helper = await import("./test-support/fake-idempotency-db.js");
  const instance = helper.createFakeIdempotencyDb();
  helper.current.instance = instance;
  return { db: instance.db, schema: {} };
});

import {
  IDEMPOTENCY_KEY_HEADER,
  keyByIp,
  makeLimiter,
  retryAfterSeconds,
  type MakeLimiterOptions,
} from "./rate-limit.js";
import { IDEMPOTENCY_TTL_MS } from "./idempotency-store.js";

function fakeDb(): FakeIdempotencyDb {
  const instance = fakeDbHolder.instance;
  if (!instance) throw new Error("fake idempotency db not initialised");
  return instance;
}

function firstRow(): FakeRow | undefined {
  return [...fakeDb().rows.values()][0];
}

function rowForKey(key: string): FakeRow | undefined {
  for (const row of fakeDb().rows.values()) {
    if (row.key === key) return row;
  }
  return undefined;
}

function buildApp(options: MakeLimiterOptions) {
  const app = express();
  app.use(express.json());
  app.get("/test", makeLimiter(options), (_req: Request, res: Response) => {
    res.json({ success: true });
  });
  return app;
}

interface IdempotentApp {
  app: express.Express;
  executions: { n: number };
}

/** Builds an app whose /test route runs the downstream handler on every execution. */
function buildIdempotentApp(
  options: Partial<MakeLimiterOptions> & { name: string },
  sharedCounter?: { n: number },
  handler?: (req: Request, res: Response) => void,
): IdempotentApp {
  const app = express();
  app.use(express.json());
  const executions = sharedCounter ?? { n: 0 };
  const limiter = makeLimiter({
    windowMs: 60_000,
    max: 100,
    idempotent: true,
    ...options,
  });
  app.post("/test", limiter, (req, res) => {
    executions.n += 1;
    if (handler) {
      handler(req, res);
      return;
    }
    res.json({ ok: true, executions: executions.n });
  });
  return { app, executions };
}

describe("rate-limit middleware", () => {
  beforeEach(() => {
    fakeDb().reset();
  });

  it("rounds retry-after values up to whole seconds", () => {
    expect(retryAfterSeconds(1_500)).toBe(2);
    expect(retryAfterSeconds(0)).toBe(1);
  });

  it("enforces the configured limit", async () => {
    const app = buildApp({ name: "test", windowMs: 60_000, max: 1 });

    await request(app).get("/test").set(IDEMPOTENCY_KEY_HEADER, "key-1").expect(200);
    await request(app).get("/test").set(IDEMPOTENCY_KEY_HEADER, "key-2").expect(429);
  });

  it("uses request cost when calculating the effective limit", async () => {
    const app = buildApp({
      name: "weighted-test",
      windowMs: 60_000,
      max: 10,
      cost: (req) => Number(req.headers["x-cost"] ?? 1),
    });

    await request(app).get("/test").set("x-cost", "5").expect(200);
    await request(app).get("/test").set("x-cost", "5").expect(200);
    await request(app).get("/test").set("x-cost", "5").expect(429);
  });

  it("treats a non-positive cost as the full limit", async () => {
    const app = buildApp({ name: "cost-zero", windowMs: 60_000, max: 10, cost: () => 0 });

    await request(app).get("/test").expect(200);
    await request(app).get("/test").expect(200);
  });

  it("immediately throttles when the cost exceeds the max", async () => {
    const app = buildApp({ name: "cost-high", windowMs: 60_000, max: 10, cost: () => 11 });

    await request(app).get("/test").expect(429);
  });

  it("falls back to the max when the cost function throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = buildApp({
        name: "cost-throw",
        windowMs: 60_000,
        max: 10,
        cost: () => {
          throw new Error("cost exploded");
        },
      });

      await request(app).get("/test").expect(200);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('limiter="cost-throw"'),
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("supports a skip predicate that bypasses the limiter", async () => {
    const app = buildApp({
      name: "skip-predicate",
      windowMs: 60_000,
      max: 1,
      skip: (req) => req.path === "/test",
    });

    await request(app).get("/test").expect(200);
    await request(app).get("/test").expect(200);
  });

  it("accepts a custom shared store for rate-limit counters", async () => {
    const counts = new Map<string, number>();
    const sharedStore = {
      increment: async (key: string) => {
        const totalHits = (counts.get(key) ?? 0) + 1;
        counts.set(key, totalHits);
        return { totalHits, resetTime: undefined as Date | undefined };
      },
      decrement: async (key: string) => {
        counts.set(key, (counts.get(key) ?? 1) - 1);
      },
      resetKey: async (key: string) => {
        counts.delete(key);
      },
    };
    const app = buildApp({ name: "custom-store", windowMs: 60_000, max: 1, store: sharedStore });

    await request(app).get("/test").expect(200);
    await request(app).get("/test").expect(429);
    expect([...counts.values()]).toContain(2);
  });

  it("honours RATE_LIMIT_<NAME>_* environment overrides", async () => {
    const names = ["RATE_LIMIT_ENVOVR_MAX", "RATE_LIMIT_ENVOVR_WINDOW_MS", "RATE_LIMIT_ENVOVR_MESSAGE"] as const;
    const previous = names.map((name) => [name, process.env[name]] as const);
    process.env.RATE_LIMIT_ENVOVR_MAX = "1";
    process.env.RATE_LIMIT_ENVOVR_WINDOW_MS = "1000";
    process.env.RATE_LIMIT_ENVOVR_MESSAGE = "overridden message";
    try {
      const app = buildApp({ name: "envovr", windowMs: 60_000, max: 100 });

      await request(app).get("/test").expect(200);
      const second = await request(app).get("/test");
      expect(second.status).toBe(429);
      expect(second.body.error).toBe("overridden message");
      expect(second.headers["retry-after"]).toBe("1");
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rejects invalid limiter options with a descriptive TypeError", () => {
    expect(() => makeLimiter({ name: "", windowMs: 60_000, max: 10 })).toThrow(TypeError);
    expect(() => makeLimiter({ name: "x", windowMs: -1, max: 10 })).toThrow(TypeError);
    expect(() => makeLimiter({ name: "x", windowMs: 60_000, max: 0 })).toThrow(TypeError);
  });

  it("warns when the effective max is absurdly high", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const previous = process.env.RATE_LIMIT_HUGEMAX_MAX;
    try {
      // Plain high max — the warning carries no env-variable note.
      makeLimiter({ name: "hugemax", windowMs: 60_000, max: 5000 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("absurdly high"));
      warnSpy.mockClear();

      // Overridden via the environment: the warning names the env variable.
      process.env.RATE_LIMIT_HUGEMAX_MAX = "5000";
      makeLimiter({ name: "hugemax", windowMs: 60_000, max: 100 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("RATE_LIMIT_HUGEMAX_MAX"));
    } finally {
      if (previous === undefined) delete process.env.RATE_LIMIT_HUGEMAX_MAX;
      else process.env.RATE_LIMIT_HUGEMAX_MAX = previous;
      warnSpy.mockRestore();
    }
  });

  it("falls back to the unknown bucket when req.ip is unavailable", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(keyByIp({ ip: undefined } as unknown as Request)).toBe("unknown");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("req.ip is undefined"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("normalises IPv6 client addresses through the shared key generator", () => {
    expect(keyByIp({ ip: "::ffff:127.0.0.1" } as unknown as Request)).toBe("127.0.0.1");
  });

  // -------------------------------------------------------------------------
  // Cross-instance deduplication (issue #746)
  // -------------------------------------------------------------------------

  it("deduplicates the same idempotency key across independent limiter instances", async () => {
    // Two fully independent limiter instances (separate makeLimiter calls,
    // separate closures) that share only the mocked database module.
    const shared = { n: 0 };
    const makeApp = (): express.Express => {
      const app = express();
      app.use(express.json());
      app.post(
        "/test",
        makeLimiter({ name: "cross", windowMs: 60_000, max: 100, idempotent: true }),
        (_req, res) => {
          shared.n += 1;
          res.json({ ok: true, executions: shared.n });
        },
      );
      return app;
    };
    const appA = makeApp();
    const appB = makeApp();

    // Instance A processes the key.
    const first = await request(appA)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "abc123")
      .send({ amount: "10" });
    expect(first.status).toBe(200);
    expect(shared.n).toBe(1);
    await vi.waitFor(() => expect(firstRow()?.status).toBe("completed"));

    // Instance B receives the same key — it must NOT execute downstream again.
    const second = await request(appB)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "abc123")
      .send({ amount: "10" });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers["x-idempotent-replayed"]).toBe("true");
    expect(shared.n).toBe(1);
    // One shared record in the database; nothing in the limiter instances.
    expect(fakeDb().rows.size).toBe(1);
  });

  it("scopes idempotency per limiter: different limiters do not collide on a key", async () => {
    const counter = { n: 0 };
    const appA = buildIdempotentApp({ name: "scope-a" }, counter);
    const appB = buildIdempotentApp({ name: "scope-b" }, counter);

    await request(appA.app).post("/test").set(IDEMPOTENCY_KEY_HEADER, "shared-key").send({}).expect(200);
    const second = await request(appB.app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "shared-key")
      .send({});

    // Different limiter = different idempotency scope: both execute.
    expect(second.status).toBe(200);
    expect(second.headers["x-idempotent-replayed"]).toBeUndefined();
    expect(counter.n).toBe(2);
    expect(fakeDb().rows.size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Keyless requests / disabled idempotency (regression)
  // -------------------------------------------------------------------------

  it("leaves requests without an idempotency key completely untouched", async () => {
    const { app, executions } = buildIdempotentApp({ name: "keyless" });

    await request(app).post("/test").send({ amount: "10" }).expect(200);
    await request(app).post("/test").send({ amount: "10" }).expect(200);

    expect(executions.n).toBe(2);
    // No idempotency record and no database interaction at all.
    expect(fakeDb().rows.size).toBe(0);
    expect(fakeDb().calls.length).toBe(0);
  });

  it("leaves rate limiting unchanged when idempotency is disabled", async () => {
    const app = buildApp({ name: "plain", windowMs: 60_000, max: 1 });

    await request(app).get("/test").set(IDEMPOTENCY_KEY_HEADER, "key-1").expect(200);
    await request(app).get("/test").set(IDEMPOTENCY_KEY_HEADER, "key-1").expect(429);

    // No database interaction for non-idempotent limiters.
    expect(fakeDb().calls.length).toBe(0);
  });

  it("ignores invalid idempotency keys without touching the store", async () => {
    const { app, executions } = buildIdempotentApp({ name: "invalid-key" });

    // IdempotencyKeySchema rejects these — treated as keyless.
    await request(app).post("/test").set(IDEMPOTENCY_KEY_HEADER, "bad key with spaces").expect(200);

    expect(executions.n).toBe(1);
    expect(fakeDb().calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Duplicate response behaviour
  // -------------------------------------------------------------------------

  it("executes once and replays the stored response for an identical retry", async () => {
    const { app, executions } = buildIdempotentApp({ name: "replay" });

    const first = await request(app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "dup-1")
      .send({ amount: "10" });
    expect(first.status).toBe(200);
    expect(first.headers["x-idempotent-replayed"]).toBeUndefined();

    await vi.waitFor(() => expect(firstRow()?.status).toBe("completed"));

    const second = await request(app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "dup-1")
      .send({ amount: "10" });

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(second.headers["x-idempotent-replayed"]).toBe("true");
    expect(executions.n).toBe(1);
  });

  it("rejects reuse of a key with a different request body (409 conflict)", async () => {
    const { app, executions } = buildIdempotentApp({ name: "conflict" });

    await request(app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "conf-1")
      .send({ amount: "10" })
      .expect(200);
    await vi.waitFor(() => expect(firstRow()?.status).toBe("completed"));

    const conflict = await request(app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "conf-1")
      .send({ amount: "999" });

    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      error: "Idempotency key already used with a different request body",
    });
    expect(executions.n).toBe(1);
  });

  it("rejects a duplicate while the first request is still in flight (409 in progress)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, executions } = buildIdempotentApp(
      { name: "in-flight" },
      undefined,
      async (_req, res) => {
        await gate;
        res.json({ ok: true });
      },
    );

    // Kick off the request without awaiting it (it blocks on the gate below),
    // then wait until the key has been claimed and is blocked downstream.
    const firstPromise = request(app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "slow-1")
      .send({ amount: "10" })
      .then((response) => response);
    await vi.waitFor(() => expect(fakeDb().rows.size).toBe(1));

    const duplicate = await request(app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "slow-1")
      .send({ amount: "10" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      error: "Request with this idempotency key is already being processed",
    });

    release();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(executions.n).toBe(1);
  });

  it("replays a stored 429 with Retry-After when the key was throttled", async () => {
    // max=1: the burner request consumes the only slot, so the keyed request
    // is throttled on first use and that 429 is stored.
    const app = buildApp({ name: "throttled-replay", windowMs: 60_000, max: 1, idempotent: true });

    await request(app).get("/test").set(IDEMPOTENCY_KEY_HEADER, "burner").expect(200);

    const throttled = await request(app).get("/test").set(IDEMPOTENCY_KEY_HEADER, "retry-key");
    expect(throttled.status).toBe(429);
    await vi.waitFor(() => expect(rowForKey("retry-key")?.status).toBe("completed"));
    expect(rowForKey("retry-key")?.statusCode).toBe(429);

    const replay = await request(app).get("/test").set(IDEMPOTENCY_KEY_HEADER, "retry-key");
    expect(replay.status).toBe(429);
    expect(replay.headers["x-idempotent-replayed"]).toBe("true");
    expect(replay.headers["retry-after"]).toBeDefined();
    expect(replay.body).toEqual(throttled.body);
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  it("executes downstream exactly once under 10 concurrent identical requests", async () => {
    const { app, executions } = buildIdempotentApp({ name: "concurrent" });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app)
          .post("/test")
          .set(IDEMPOTENCY_KEY_HEADER, "race-1")
          .send({ amount: "10" }),
      ),
    );

    expect(executions.n).toBe(1);
    const statuses = responses.map((r) => r.status);
    // Exactly one original winner; every other response is a deterministic
    // duplicate (409 in-progress or a replayed 200).
    const winners = responses.filter(
      (r) => r.status === 200 && r.headers["x-idempotent-replayed"] === undefined,
    );
    expect(winners).toHaveLength(1);
    for (const status of statuses) {
      expect([200, 409]).toContain(status);
    }
    expect(fakeDb().rows.size).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Failure / retry
  // -------------------------------------------------------------------------

  it("allows a retry after a downstream 5xx failure (no permanent poisoning)", async () => {
    let failFirst = true;
    const { app, executions } = buildIdempotentApp({ name: "retry-5xx" }, undefined, (_req, res) => {
      if (failFirst) {
        failFirst = false;
        res.status(500).json({ error: "boom" });
        return;
      }
      res.json({ ok: true });
    });

    const first = await request(app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "retry-me")
      .send({ amount: "10" });
    expect(first.status).toBe(500);
    expect(executions.n).toBe(1);
    await vi.waitFor(() => expect(firstRow()?.status).toBe("failed"));

    // Retry with the same key: the failed record is re-claimed, not replayed.
    const retry = await request(app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "retry-me")
      .send({ amount: "10" });
    expect(retry.status).toBe(200);
    expect(retry.headers["x-idempotent-replayed"]).toBeUndefined();
    expect(executions.n).toBe(2);
  });

  it("re-claims an expired record so the same key becomes eligible again", async () => {
    const { app, executions } = buildIdempotentApp({ name: "expiry" });

    await request(app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "expire-me")
      .send({ amount: "10" })
      .expect(200);
    await vi.waitFor(() => expect(firstRow()?.status).toBe("completed"));

    // Force the record past its TTL (equivalent to waiting IDEMPOTENCY_TTL_MS).
    const row = firstRow()!;
    row.expiresAt = new Date(Date.now() - 1);

    const retry = await request(app)
      .post("/test")
      .set(IDEMPOTENCY_KEY_HEADER, "expire-me")
      .send({ amount: "10" });
    expect(retry.status).toBe(200);
    expect(retry.headers["x-idempotent-replayed"]).toBeUndefined();
    expect(executions.n).toBe(2);
    expect(IDEMPOTENCY_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  // -------------------------------------------------------------------------
  // Store failure — fail closed
  // -------------------------------------------------------------------------

  it("fails closed with 503 when the idempotency store is unreachable", async () => {
    const { app, executions } = buildIdempotentApp({ name: "fail-closed" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // One rejection is a non-Error value; the other a real Error — both are
      // logged safely and both fail closed.
      fakeDb().failures.push("connection refused", new Error("db down"));

      const stringFailure = await request(app)
        .post("/test")
        .set(IDEMPOTENCY_KEY_HEADER, "db-down-1")
        .send({ amount: "10" });
      expect(stringFailure.status).toBe(503);
      expect(stringFailure.body.error).toContain("Idempotency store unavailable");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('limiter="fail-closed"'),
        expect.objectContaining({ error: "connection refused" }),
      );

      const errorFailure = await request(app)
        .post("/test")
        .set(IDEMPOTENCY_KEY_HEADER, "db-down-2")
        .send({ amount: "10" });
      expect(errorFailure.status).toBe(503);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('limiter="fail-closed"'),
        expect.objectContaining({ error: "db down" }),
      );

      // The downstream operation must NOT run when idempotency cannot be
      // verified — otherwise a payment-adjacent side effect could double-execute.
      expect(executions.n).toBe(0);
      expect(fakeDb().rows.size).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("delivers the response even if persisting the completion fails", async () => {
    const { app, executions } = buildIdempotentApp({ name: "complete-fail" });    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Execute #0 is request A's claim INSERT (succeeds); #1 is its completion
      // UPDATE, which fails with a non-Error rejection. Request B mirrors the
      // shape with a real Error at #5. Responses are still delivered.
      fakeDb().failuresByIndex.set(1, "write failed");
      fakeDb().failuresByIndex.set(5, new Error("write failed"));

      const first = await request(app)
        .post("/test")
        .set(IDEMPOTENCY_KEY_HEADER, "write-fail")
        .send({ amount: "10" });
      expect(first.status).toBe(200);
      expect(executions.n).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('limiter="complete-fail"'),
        expect.objectContaining({ error: "write failed" }),
      );

      // The record was never completed, so it stays in_progress. A retry
      // within the TTL is blocked deterministically (409 in-progress) rather
      // than re-executing the downstream operation.
      const retry = await request(app)
        .post("/test")
        .set(IDEMPOTENCY_KEY_HEADER, "write-fail")
        .send({ amount: "10" });
      expect(retry.status).toBe(409);
      expect(executions.n).toBe(1);

      // A second independent key whose completion write fails with a real
      // Error — the response is still delivered and the Error is logged.
      const second = await request(app)
        .post("/test")
        .set(IDEMPOTENCY_KEY_HEADER, "write-fail-2")
        .send({ amount: "10" });
      expect(second.status).toBe(200);
      expect(executions.n).toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("persists an empty body as an empty object when the response has no body", async () => {
    const { app, executions } = buildIdempotentApp({ name: "empty-body" }, undefined, (_req, res) => {
      res.status(204).send();
    });

    const first = await request(app).post("/test").set(IDEMPOTENCY_KEY_HEADER, "no-body").send({});
    expect(first.status).toBe(204);
    expect(executions.n).toBe(1);
    await vi.waitFor(() => expect(firstRow()?.status).toBe("completed"));
    expect(firstRow()?.statusCode).toBe(204);
    expect(firstRow()?.responseBody).toEqual({});

    // Retrying replays the stored 204 without re-executing downstream.
    const replay = await request(app).post("/test").set(IDEMPOTENCY_KEY_HEADER, "no-body").send({});
    expect(replay.status).toBe(204);
    expect(executions.n).toBe(1);
  });
});

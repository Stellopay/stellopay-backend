// ---------------------------------------------------------------------------
// In-memory fake of the `idempotency_keys` database for tests.
//
// This module implements the observable SQL contract of
// `src/middleware/idempotency-store.ts` against an in-memory Map:
//
//   - the `(route, key)` primary key is enforced (a duplicate INSERT is a
//     no-op, mirroring `ON CONFLICT (route, key) DO NOTHING`),
//   - state transitions (in_progress -> completed/failed, re-claim of failed
//     or expired records) match the store's guarded UPDATEs,
//   - expired records are removed by `DELETE ... WHERE expires_at <= $now`.
//
// Two test files share this helper: each file registers `vi.mock` for
// `../db/index.js` whose factory creates one fake instance and stores it in
// the `current` holder, so the test body can assert against `fake.rows` and
// `fake.calls`. The fake does not import anything from `../db/index.js`, so
// the mock factories can load it via dynamic import without a cycle.
// ---------------------------------------------------------------------------

import type { SQL } from "drizzle-orm";

/** Lifecycle state of a fake row — mirrors `IdempotencyRecordStatus`. */
export type FakeStatus = "in_progress" | "completed" | "failed";

export interface FakeRow {
  route: string;
  key: string;
  bodyFingerprint: string;
  status: FakeStatus;
  statusCode: number | null;
  responseBody: unknown;
  expiresAt: Date;
}

interface PgLikeResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

/** A pg-shaped result for `db.execute`. */
export type ExecuteResult = PgLikeResult;

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toKey(route: string, key: string): string {
  return `${route}\u0000${key}`;
}

/**
 * Renders a drizzle `sql` fragment to `{ sql, params }` using the same
 * escaping the node-postgres driver applies. Only used by tests to dispatch
 * on the store's statements; no identifiers in the store's SQL are dynamic.
 */
export function sqlToQuery(fragment: SQL): { sql: string; params: unknown[] } {
  const query = fragment.toQuery({
    // The store's templates contain no Table/Column chunks, only raw text and
    // params, so the casing cache is never consulted.
    casing: {},
    escapeName: (name: string) => `"${name}"`,
    escapeParam: (num: number) => `$${num}`,
    escapeString: (value: string) => `'${value.replace(/'/g, "''")}'`,
  } as never);
  return { sql: query.sql, params: query.params };
}

export interface FakeIdempotencyDb {
  db: {
    execute: (fragment: SQL) => Promise<PgLikeResult>;
  };
  /** The fake table, keyed by `route\u0000key`. */
  rows: Map<string, FakeRow>;
  /** Every executed statement, in order: `{ sql, params }`. */
  calls: Array<{ sql: string; params: unknown[] }>;
  /** When non-empty, the next `execute` calls throw these values in order. */
  failures: unknown[];
  /** Values keyed by absolute call index; execute #n throws when present. */
  failuresByIndex: Map<number, unknown>;
  /**
   * When set, the next SELECT returns no row. If `deleteRow` is true the row
   * is also removed from the table (simulating a concurrent cleanup delete).
   */
  vanishNextSelect: { deleteRow: boolean } | null;
  /** Number of reclaim attempts to fail (simulating a lost reclaim race). */
  blockReclaims: number;
  /** When true, the next DELETE returns a result without a rowCount. */
  nullRowCountNext: boolean;
  /** Returns the stored row for `(route, key)`, or undefined. */
  get: (route: string, key: string) => FakeRow | undefined;
  /** Empties the table, the call log, and the failure queues. */
  reset: () => void;
}

/**
 * Creates a fresh fake idempotency database. Call once per test file inside
 * the `vi.mock("../db/index.js")` factory.
 */
export function createFakeIdempotencyDb(): FakeIdempotencyDb {
  const rows = new Map<string, FakeRow>();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const failures: unknown[] = [];
  const failuresByIndex = new Map<number, unknown>();
  let vanishNextSelect: { deleteRow: boolean } | null = null;
  let blockReclaims = 0;
  let nullRowCountNext = false;

  const insert = (params: unknown[]): PgLikeResult => {
    const [route, key, fingerprint, expiresAt] = params as [string, string, string, Date];
    const existing = rows.get(toKey(route, key));
    if (existing) {
      // Unique (route, key) violation → ON CONFLICT DO NOTHING, no row returned.
      return { rows: [], rowCount: 0 };
    }
    rows.set(toKey(route, key), {
      route,
      key,
      bodyFingerprint: fingerprint,
      status: "in_progress",
      statusCode: null,
      responseBody: {},
      expiresAt: toDate(expiresAt),
    });
    return { rows: [{ route }], rowCount: 1 };
  };

  const select = (params: unknown[]): PgLikeResult => {
    const [route, key] = params as [string, string];
    if (vanishNextSelect) {
      const vanish = vanishNextSelect;
      vanishNextSelect = null;
      if (vanish.deleteRow) rows.delete(toKey(route, key));
      return { rows: [], rowCount: 0 };
    }
    const row = rows.get(toKey(route, key));
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          route: row.route,
          key: row.key,
          body_fingerprint: row.bodyFingerprint,
          status: row.status,
          status_code: row.statusCode,
          response_body: row.responseBody,
          expires_at: row.expiresAt,
        },
      ],
      rowCount: 1,
    };
  };

  const reclaim = (params: unknown[]): PgLikeResult => {
    // params: [fingerprint, expiresAt, route, key, now]
    const fingerprint = params[0] as string;
    const expiresAt = toDate(params[1]);
    const route = params[2] as string;
    const key = params[3] as string;
    const now = toDate(params[4]);
    const row = rows.get(toKey(route, key));
    if (blockReclaims > 0) {
      blockReclaims -= 1;
      return { rows: [], rowCount: 0 };
    }
    // Mirrors the store's combined reclaim predicate: failed records are
    // always retryable; in_progress/completed records are retryable only
    // after their expiry has passed.
    const eligible =
      row !== undefined &&
      (row.status === "failed" || row.expiresAt.getTime() <= now.getTime());
    if (!eligible) return { rows: [], rowCount: 0 };
    row.bodyFingerprint = fingerprint;
    row.status = "in_progress";
    row.statusCode = null;
    row.responseBody = {};
    row.expiresAt = expiresAt;
    return { rows: [{ route }], rowCount: 1 };
  };

  const complete = (params: unknown[]): PgLikeResult => {
    // params: [statusCode, responseBody, route, key]
    const [statusCode, responseBody, route, key] = params as [number, unknown, string, string];
    const row = rows.get(toKey(route, key));
    if (!row || row.status !== "in_progress") return { rows: [], rowCount: 0 };
    row.status = "completed";
    row.statusCode = statusCode;
    row.responseBody = responseBody;
    return { rows: [], rowCount: 1 };
  };

  const fail = (params: unknown[]): PgLikeResult => {
    // params: [route, key]
    const [route, key] = params as [string, string];
    const row = rows.get(toKey(route, key));
    if (!row || row.status !== "in_progress") return { rows: [], rowCount: 0 };
    row.status = "failed";
    row.statusCode = null;
    return { rows: [], rowCount: 1 };
  };

  const cleanup = (params: unknown[]): PgLikeResult => {
    // params: [now]
    const now = toDate(params[0]);
    let deleted = 0;
    for (const [pk, row] of rows.entries()) {
      if (row.expiresAt.getTime() <= now.getTime()) {
        rows.delete(pk);
        deleted += 1;
      }
    }
    return { rows: [], rowCount: deleted };
  };

  const execute = async (fragment: SQL): Promise<PgLikeResult> => {
    const { sql, params } = sqlToQuery(fragment);
    const callIndex = calls.length;
    calls.push({ sql, params });
    const byIndex = failuresByIndex.get(callIndex);
    if (byIndex) throw byIndex;
    const nextFailure = failures.shift();
    if (nextFailure) throw nextFailure;
    if (sql.includes("ON CONFLICT")) return insert(params);
    if (/^\s*SELECT/i.test(sql)) return select(params);
    if (sql.includes("RETURNING")) return reclaim(params);
    if (sql.includes("'completed'")) return complete(params);
    if (sql.includes("'failed'")) return fail(params);
    if (/^\s*DELETE/i.test(sql)) {
      if (nullRowCountNext) {
        nullRowCountNext = false;
        return { rows: [], rowCount: null as unknown as number };
      }
      return cleanup(params);
    }
    throw new Error(`fake idempotency db: unmatched SQL statement: ${sql.slice(0, 120)}`);
  };

  return {
    db: { execute },
    rows,
    calls,
    failures,
    failuresByIndex,
    reset() {
      rows.clear();
      calls.length = 0;
      failures.length = 0;
      failuresByIndex.clear();
      vanishNextSelect = null;
      blockReclaims = 0;
      nullRowCountNext = false;
    },
    get(route: string, key: string) {
      return rows.get(toKey(route, key));
    },
    set vanishNextSelect(value: { deleteRow: boolean } | null) {
      vanishNextSelect = value;
    },
    get vanishNextSelect() {
      return vanishNextSelect;
    },
    set blockReclaims(value: number) {
      blockReclaims = value;
    },
    get blockReclaims() {
      return blockReclaims;
    },
    set nullRowCountNext(value: boolean) {
      nullRowCountNext = value;
    },
    get nullRowCountNext() {
      return nullRowCountNext;
    },
  };
}

/**
 * Holder through which a test file's `vi.mock("../db/index.js")` factory
 * publishes the fake instance it created, so the test body can reach it.
 */
export const current: { instance: FakeIdempotencyDb | null } = { instance: null };

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

// ---------------------------------------------------------------------------
// Persistent, cross-instance idempotency-key store.
//
// Replaces the limiter-instance-scoped in-memory `Map` previously used by
// `makeLimiter({ idempotent: true })` with the durable `idempotency_keys`
// Postgres table. Because the table is shared by every application process,
// two independent limiter instances (or replicas) deduplicate the same
// idempotency key against the same record — the unique `(route, key)`
// primary key decides the single winner under concurrency.
//
// ## Lifecycle
//
//   ABSENT
//     └─ atomic INSERT (unique (route, key) decides the winner)
//           └─ in_progress ── response status < 500 ──► completed (replayable)
//                 └───────── response status >= 500 ──► failed (retryable)
//                 └───────── expires_at passes ───────► reclaimable
//   failed ── re-claim (atomic guarded UPDATE) ──► in_progress
//
// ## Fail-closed semantics
//
// The rate limiter itself keeps its existing fail-open behaviour
// (`passOnStoreError: true`). This store is separate and FAILS CLOSED: if the
// database cannot be reached we cannot establish whether a key was already
// processed, so the caller must NOT proceed with the downstream operation
// (which could double-execute a payment-adjacent side effect).
//
// ## Retention
//
// Records live for IDEMPOTENCY_TTL_MS (24 h). Expiry is enforced on access
// (expired records are reclaimed) and by an explicit DELETE sweep
// (cleanupExpired) so the table cannot grow without bound.
// ---------------------------------------------------------------------------

/** Retention period for idempotency records: 24 hours. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** How often the store sweeps expired records. */
export const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Lifecycle state of an idempotency record. */
export type IdempotencyRecordStatus = "in_progress" | "completed" | "failed";

/** A row from the `idempotency_keys` table. */
export interface IdempotencyRecord {
  route: string;
  key: string;
  bodyFingerprint: string;
  status: IdempotencyRecordStatus;
  statusCode: number | null;
  responseBody: unknown;
  expiresAt: Date;
}

/**
 * Result of an atomic claim.
 *
 * - `claimed` — this request won the unique-constraint race and MAY run the
 *   downstream operation exactly once.
 * - `replay` — the key was already completed with an identical request
 *   fingerprint; replay the stored response.
 * - `conflict` — the key was already completed with a *different* request
 *   fingerprint; the caller must reject with a deterministic 409.
 * - `in_progress` — another request currently holds the key (or the store
 *   could not establish a safe state); the caller must NOT run the
 *   downstream operation.
 */
export type ClaimResult =
  | { outcome: "claimed" }
  | { outcome: "replay"; statusCode: number; responseBody: unknown }
  | { outcome: "conflict" }
  | { outcome: "in_progress" };

/**
 * Produces a deterministic JSON-like string for a value, sorting object keys
 * alphabetically so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same
 * output. Mirrors the convention used by the escrow/billing replay stores.
 */
export function stableSerialize(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return String(value);
}

/**
 * Computes the request fingerprint stored alongside an idempotency key.
 *
 * A SHA-256 digest of the stable serialisation is used rather than the raw
 * serialisation so that payload contents (which may include session tokens or
 * other sensitive fields) are never persisted in the database — only the
 * digest is stored.
 */
export function computeFingerprint(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

/**
 * Durable idempotency store backed by the `idempotency_keys` table.
 *
 * All queries are parameterised; user-controlled values only ever appear as
 * bound parameters, never interpolated into SQL text.
 */
export class IdempotencyStore {
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Ensures the periodic expired-record sweep is running. Safe to call more
   * than once; the interval is created lazily on first use so a limiter that
   * never sees an idempotency key never schedules work.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired().catch((error: unknown) => {
        console.error("[idempotency-store] periodic cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, IDEMPOTENCY_CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  /** Stops the periodic cleanup sweep (mainly for tests/teardown). */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Atomically claims `(route, key)` for the given request fingerprint.
   *
   * The `(route, key)` primary key is the single source of truth: exactly one
   * concurrent caller can INSERT the record, everyone else observes the
   * existing row and is routed to replay / conflict / in_progress. Failed or
   * expired records are re-claimed with a guarded UPDATE so a retry never
   * permanently poisons a key, while a crashed in-flight request only blocks
   * the key until its `expires_at` passes.
   *
   * @param route       - Idempotency scope (limiter name + client identity).
   * @param key         - The validated `Idempotency-Key` header value.
   * @param fingerprint - Request fingerprint (see {@link computeFingerprint}).
   * @param now         - Clock value used for expiry comparisons (test seam).
   * @param expiresAt   - Record expiry; defaults to `now + IDEMPOTENCY_TTL_MS`.
   * @throws When the database is unreachable — callers must fail closed.
   */
  async claim(
    route: string,
    key: string,
    fingerprint: string,
    now: Date = new Date(),
    expiresAt: Date = new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
  ): Promise<ClaimResult> {
    const inserted = await this.insertClaim(route, key, fingerprint, expiresAt);
    if (inserted.rowCount === 1) {
      this.startCleanup();
      return { outcome: "claimed" };
    }
    return this.resolveExisting(route, key, fingerprint, now, expiresAt, 0);
  }

  /**
   * Marks a claimed record as completed and persists the response to replay.
   *
   * @throws When the database is unreachable. The caller should treat a
   *   failed completion write as "response delivered, record left
   *   in_progress until expiry" — a retry within the TTL receives 409 rather
   *   than re-executing, so no duplicate downstream operation can occur.
   */
  async complete(route: string, key: string, statusCode: number, responseBody: unknown): Promise<void> {
    await db.execute(sql`
      UPDATE "idempotency_keys"
      SET "status" = 'completed', "status_code" = ${statusCode}, "response_body" = ${responseBody}
      WHERE "route" = ${route} AND "key" = ${key} AND "status" = 'in_progress'
    `);
  }

  /**
   * Marks a claimed record as failed (e.g. downstream returned 5xx), making
   * the key eligible for re-claim on retry.
   *
   * @throws When the database is unreachable — see {@link complete}.
   */
  async fail(route: string, key: string): Promise<void> {
    await db.execute(sql`
      UPDATE "idempotency_keys"
      SET "status" = 'failed', "status_code" = NULL
      WHERE "route" = ${route} AND "key" = ${key} AND "status" = 'in_progress'
    `);
  }

  /**
   * Deletes every expired record, bounding table growth. Expiry is also
   * enforced on access (see {@link claim}), so this sweep is a maintenance
   * pass rather than the only correctness mechanism.
   *
   * @param now - Clock value used for the comparison (test seam).
   * @returns The number of deleted rows.
   */
  async cleanupExpired(now: Date = new Date()): Promise<number> {
    const result = await db.execute(sql`
      DELETE FROM "idempotency_keys" WHERE "expires_at" <= ${now}
    `);
    return result.rowCount ?? 0;
  }

  private async insertClaim(
    route: string,
    key: string,
    fingerprint: string,
    expiresAt: Date,
  ): Promise<{ rowCount: number | null }> {
    return db.execute(sql`
      INSERT INTO "idempotency_keys" ("route", "key", "body_fingerprint", "status", "status_code", "response_body", "expires_at")
      VALUES (${route}, ${key}, ${fingerprint}, 'in_progress', NULL, '{}'::jsonb, ${expiresAt})
      ON CONFLICT ("route", "key") DO NOTHING
      RETURNING "route"
    `);
  }

  private async resolveExisting(
    route: string,
    key: string,
    fingerprint: string,
    now: Date,
    expiresAt: Date,
    attempts: number,
  ): Promise<ClaimResult> {
    if (attempts > 3) {
      // Could not establish a safe state under contention — never execute.
      return { outcome: "in_progress" };
    }

    const rows = await db.execute(sql`
      SELECT "route", "key", "body_fingerprint", "status", "status_code", "response_body", "expires_at"
      FROM "idempotency_keys"
      WHERE "route" = ${route} AND "key" = ${key}
    `);
    const row = rows.rows?.[0] as
      | {
          route: string;
          key: string;
          body_fingerprint: string;
          status: IdempotencyRecordStatus;
          status_code: number | null;
          response_body: unknown;
          expires_at: Date;
        }
      | undefined;

    if (!row) {
      // The row vanished between our insert-conflict and this read (e.g. a
      // concurrent cleanup delete). Retry the insert once; if that also loses
      // the race, fail toward "do not execute".
      if (attempts === 0) {
        const inserted = await this.insertClaim(route, key, fingerprint, expiresAt);
        if (inserted.rowCount === 1) {
          this.startCleanup();
          return { outcome: "claimed" };
        }
      }
      return { outcome: "in_progress" };
    }

    if (row.status === "completed") {
      // A completed record is replayable until its TTL elapses; once expired
      // the key becomes eligible again (see {@link IDEMPOTENCY_TTL_MS}).
      if (new Date(row.expires_at).getTime() <= now.getTime()) {
        const reclaimed = await this.reclaim(route, key, fingerprint, expiresAt, now);
        if (reclaimed.rowCount === 1) return { outcome: "claimed" };
        return this.resolveExisting(route, key, fingerprint, now, expiresAt, attempts + 1);
      }
      return row.body_fingerprint === fingerprint
        ? { outcome: "replay", statusCode: row.status_code ?? 200, responseBody: row.response_body }
        : { outcome: "conflict" };
    }

    if (row.status === "failed") {
      // A failed operation never completed, so a retry may re-claim the key.
      const reclaimed = await this.reclaim(route, key, fingerprint, expiresAt, now);
      if (reclaimed.rowCount === 1) return { outcome: "claimed" };
      // Lost the re-claim race — re-read the current state.
      return this.resolveExisting(route, key, fingerprint, now, expiresAt, attempts + 1);
    }

    // in_progress: only reclaimable once the record has expired (crash
    // recovery); an active in-flight request must never be double-executed.
    if (new Date(row.expires_at).getTime() > now.getTime()) {
      return { outcome: "in_progress" };
    }
    const reclaimed = await this.reclaim(route, key, fingerprint, expiresAt, now);
    if (reclaimed.rowCount === 1) return { outcome: "claimed" };
    return this.resolveExisting(route, key, fingerprint, now, expiresAt, attempts + 1);
  }

  /**
   * Atomically re-claims a record that is retryable: `failed`, or expired
   * (`in_progress` after a crash, or `completed` past its TTL). The guarded
   * WHERE clause means exactly one concurrent reclaimer wins.
   */
  private async reclaim(
    route: string,
    key: string,
    fingerprint: string,
    expiresAt: Date,
    now: Date,
  ): Promise<{ rowCount: number | null }> {
    return db.execute(sql`
      UPDATE "idempotency_keys"
      SET "status" = 'in_progress', "body_fingerprint" = ${fingerprint}, "status_code" = NULL, "response_body" = '{}'::jsonb, "expires_at" = ${expiresAt}
      WHERE "route" = ${route} AND "key" = ${key}
        AND (
          "status" = 'failed'
          OR ("status" = 'in_progress' AND "expires_at" <= ${now})
          OR ("status" = 'completed' AND "expires_at" <= ${now})
        )
      RETURNING "route"
    `);
  }
}

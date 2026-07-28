import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc } from "drizzle-orm";
import { StarknetAddress, AgreementId, parsePagination } from "../utils/validation.js";
import { defaults, env } from "../config.js";
import { normalizeStarknetAddress } from "../utils/address.js";
import { notFoundResponse } from "./not-found.js";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { applyIndexedCacheHeaders } from "../utils/cache-headers.js";

/**
 * Source identifier tag returned in indexed route responses.
 */
export const INDEXED_DATA_SOURCE = "indexed";

/**
 * Hard limit for sub-resources (events, payments, etc.) inside a detail view
 * to prevent unbounded database scans.
 */
export const MAX_INTERNAL_LIMIT = 200;

/**
 * Hard limit for escrow events in the balance calculation route. Calculating
 * balance for more than this many events in a single HTTP request is a
 * performance risk.
 */
export const MAX_ESCROW_EVENTS_LIMIT = 500;

// ---------------------------------------------------------------------------
// Observability: operation names
// ---------------------------------------------------------------------------

/** Stable operation names for structured logs — one per route handler. */
export const INDEXED_OPS = {
  /** GET /indexed/freshness */
  FRESHNESS: "indexed.freshness",
  /** GET /indexed/checkpoint */
  CHECKPOINT: "indexed.checkpoint",
  /** GET /indexed/agreements/:contract_address/user/:user_address */
  AGREEMENTS_FOR_USER: "indexed.agreements_for_user",
  /** GET /indexed/agreement/:contract_address/:agreement_id */
  AGREEMENT_DETAIL: "indexed.agreement_detail",
  /** GET /indexed/payments/user/:user_address */
  PAYMENTS_FOR_USER: "indexed.payments_for_user",
  /** GET /indexed/escrow/:contract_address/balance/:agreement_id */
  ESCROW_BALANCE: "indexed.escrow_balance",
} as const;

// ---------------------------------------------------------------------------
// Observability: metric counter names
// ---------------------------------------------------------------------------

/**
 * Counter names for process-local metric tracking.  Use these constants (not
 * raw strings) at every call site so renames stay in lock-step with dashboards.
 */
export const INDEXED_METRICS = {
  /** Total requests received per route. */
  REQUESTS: "indexed_requests_total",
  /** Requests that returned at least one row. */
  ROWS_FOUND: "indexed_rows_found_total",
  /** Requests that observed a non-zero sync checkpoint. */
  SYNC_CHECKPOINT_OBSERVED: "indexed_sync_checkpoint_observed_total",
  /** Server errors (5xx) — note: 404s do NOT increment this. */
  ERRORS: "indexed_errors_total",
} as const;

// ---------------------------------------------------------------------------
// Observability: metric counters
// ---------------------------------------------------------------------------

const _indexedCounters: Record<string, number> = {};

/** Increment a named counter by `by` (default 1). Creates it on first write. */
export function incIndexedMetric(name: string, by = 1): void {
  _indexedCounters[name] = (_indexedCounters[name] ?? 0) + by;
}

/**
 * Point-in-time snapshot of every indexed counter. Suitable for an
 * admin diagnostics endpoint. Returns a shallow copy so callers cannot
 * mutate internal state.
 */
export function getIndexedMetricsSnapshot(): Record<string, number> {
  return { ..._indexedCounters };
}

/**
 * Reset every counter. Tests call this in `beforeEach` so each case
 * starts from a clean slate. Not intended for production use.
 */
export function resetIndexedMetrics(): void {
  for (const k of Object.keys(_indexedCounters)) delete _indexedCounters[k];
}

// ---------------------------------------------------------------------------
// Observability: structured logging
// ---------------------------------------------------------------------------

type IndexedLogLevel = "info" | "error";

/** Tag prefix for every structured log line emitted by this module. */
const LOG_TAG = "[indexed]";

/**
 * Emit exactly one structured log line for an indexed route request.
 *
 * The payload is merged with `{ timestamp, level, op }` and serialised
 * according to `env.LOG_FORMAT` (JSON when `json`, otherwise human-readable
 * text).
 *
 * @param level  Log level (`info` for success, `error` for 5xx).
 * @param op     Operation name from {@link INDEXED_OPS}.
 * @param data   Request-scoped fields — duration, sync checkpoint, row count,
 *               HTTP status, and optional address scoping.
 */
export function logIndexedEvent(
  level: IndexedLogLevel,
  op: string,
  data: Record<string, unknown> = {},
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    op,
    ...data,
  };

  if (env.LOG_FORMAT === "json") {
    console[level](JSON.stringify(entry));
    return;
  }

  const flat = Object.entries(data)
    .map(([k, v]) => `${k}=${formatScalar(v)}`)
    .join(" ");
  console[level](`${LOG_TAG} ${entry.timestamp} ${level.toUpperCase()} ${op} ${flat}`);
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserializable>";
  }
}

const indexedCacheOptions = {
  maxAgeSeconds: env.INDEXED_CACHE_MAX_AGE_SECONDS,
};

/**
 * Centralized authorization gate for indexer freshness and sync checkpoint operations.
 * Requires an authenticated principal (requireAuth) with admin privileges (requireAdmin).
 * Permission evaluation occurs before any database or internal indexer state access.
 */
export const authorizeIndexedFreshness = [requireAuth, requireAdmin];

/**
 * Derives the indexer sync checkpoint (highest block number) from a set of
 * database records indexed from Starknet events.
 *
 * This function is pure and deterministic: repeated calls with the same input
 * always produce the same output, making sync checkpoint derivation idempotent.
 *
 * @param records Array of database entities with an optional blockNumber property
 * @returns High-water mark block number, or 0 if records list is empty or lacks block numbers.
 */
export function deriveSyncCheckpoint(
  records: Array<{ blockNumber?: number | bigint | null }>
): number {
  if (!records || !Array.isArray(records) || records.length === 0) return 0;
  let maxBlock = 0;
  for (const record of records) {
    if (record && record.blockNumber !== undefined && record.blockNumber !== null) {
      const bn = typeof record.blockNumber === "bigint" ? Number(record.blockNumber) : Number(record.blockNumber);
      if (Number.isFinite(bn) && bn >= 0) {
        if (bn > maxBlock) {
          maxBlock = bn;
        }
      } else {
        console.warn({ event: "indexer_checkpoint_invalid_block", blockNumber: record.blockNumber, reason: "invalid_format_or_negative" });
      }
    }
  }
  return maxBlock;
}

export const indexedRouter = Router();

// Output Schemas for Contract Hardening
const AgreementSchema = z.object({
  id: z.string(),
  contractAddress: z.string().optional(),
  employer: z.string().optional(),
  contributor: z.string().nullable().optional(),
  mode: z.number().optional(),
  createdAt: z.date().or(z.string()).optional(),
}).passthrough();

/**
 * GET /indexed/freshness
 *
 * Retrieves indexer sync checkpoint block and freshness state.
 *
 * Authorization Contract:
 * - Requires authenticated session (requireAuth) and admin privileges (requireAdmin).
 * - Permission evaluation occurs BEFORE any database query or indexer state access.
 * - Standard 401 response for unauthorized requests ({ error: "Unauthorized" }).
 * - Standard 403 response for forbidden requests ({ error: "Forbidden" }).
 * - Unauthorized requests receive no state information or execution timing payload.
 *
 * Idempotency: This endpoint is read-only. Repeated requests with the same
 * underlying database state produce identical responses.
 */
indexedRouter.get(
  "/indexed/freshness",
  requireAuth,
  requireAdmin,
  async (_req, res, next) => {
    const startTime = performance.now();
    try {
      const records = await db
        .select({ blockNumber: schema.agreementEvents.blockNumber })
        .from(schema.agreementEvents)
        .orderBy(desc(schema.agreementEvents.blockNumber))
        .limit(100);

      const checkpointBlock = deriveSyncCheckpoint(records);

      const body = {
        source: INDEXED_DATA_SOURCE,
        checkpointBlock,
        freshness: records.length > 0 ? "synced" : "empty",
      };

      res.setHeader("x-indexer-sync-checkpoint", String(checkpointBlock));
      res.json(body);

      // Observability
      const durationMs = Math.round(performance.now() - startTime);
      incIndexedMetric(INDEXED_METRICS.REQUESTS);
      if (records.length > 0) incIndexedMetric(INDEXED_METRICS.ROWS_FOUND);
      if (checkpointBlock > 0) incIndexedMetric(INDEXED_METRICS.SYNC_CHECKPOINT_OBSERVED);
      logIndexedEvent("info", INDEXED_OPS.FRESHNESS, {
        durationMs,
        syncCheckpoint: checkpointBlock,
        freshness: body.freshness,
        httpStatus: 200,
      });
    } catch (e: any) {
      const durationMs = Math.round(performance.now() - startTime);
      incIndexedMetric(INDEXED_METRICS.REQUESTS);
      incIndexedMetric(INDEXED_METRICS.ERRORS);
      logIndexedEvent("error", INDEXED_OPS.FRESHNESS, {
        durationMs,
        httpStatus: 500,
        error: e?.message,
      });
      next(e);
    }
  },
);

/**
 * GET /indexed/checkpoint
 *
 * Retrieves indexer sync checkpoint block number.
 *
 * Authorization Contract:
 * - Requires authenticated session (requireAuth) and admin privileges (requireAdmin).
 * - Permission evaluation occurs BEFORE any database query or indexer state access.
 * - Standard 401 response for unauthorized requests ({ error: "Unauthorized" }).
 * - Standard 403 response for forbidden requests ({ error: "Forbidden" }).
 * - Unauthorized requests receive no state information or execution timing payload.
 *
 * Idempotency: This endpoint is read-only. Repeated requests with the same
 * underlying database state produce identical responses.
 */
indexedRouter.get(
  "/indexed/checkpoint",
  requireAuth,
  requireAdmin,
  async (_req, res, next) => {
    const startTime = performance.now();
    try {
      const records = await db
        .select({ blockNumber: schema.agreementEvents.blockNumber })
        .from(schema.agreementEvents)
        .orderBy(desc(schema.agreementEvents.blockNumber))
        .limit(100);

      const checkpointBlock = deriveSyncCheckpoint(records);

      const body = {
        source: INDEXED_DATA_SOURCE,
        checkpointBlock,
      };

      res.setHeader("x-indexer-sync-checkpoint", String(checkpointBlock));
      res.json(body);

      // Observability
      const durationMs = Math.round(performance.now() - startTime);
      incIndexedMetric(INDEXED_METRICS.REQUESTS);
      if (records.length > 0) incIndexedMetric(INDEXED_METRICS.ROWS_FOUND);
      if (checkpointBlock > 0) incIndexedMetric(INDEXED_METRICS.SYNC_CHECKPOINT_OBSERVED);
      logIndexedEvent("info", INDEXED_OPS.CHECKPOINT, {
        durationMs,
        syncCheckpoint: checkpointBlock,
        httpStatus: 200,
      });
    } catch (e: any) {
      const durationMs = Math.round(performance.now() - startTime);
      incIndexedMetric(INDEXED_METRICS.REQUESTS);
      incIndexedMetric(INDEXED_METRICS.ERRORS);
      logIndexedEvent("error", INDEXED_OPS.CHECKPOINT, {
        durationMs,
        httpStatus: 500,
        error: e?.message,
      });
      next(e);
    }
  },
);

/**
 * GET /indexed/agreements/:contract_address/user/:user_address
 *
 * Retrieves all agreements associated with a specific user (as employer, contributor,
 * or payroll employee).
 */
indexedRouter.get(
  "/indexed/agreements/:contract_address/user/:user_address",
  async (req, res, next) => {
    const startTime = performance.now();
    try {
      const contractAddress = StarknetAddress.parse(req.params.contract_address);
      if (contractAddress === normalizeStarknetAddress(defaults.payrollEscrowAddress)) {
        res.status(400).json({ error: "Invalid contract address for agreements" });
        return;
      }
      const userAddress = StarknetAddress.parse(req.params.user_address);
      const { limit, offset } = parsePagination(req.query);

      const [agreements, employeeAgreements] = await Promise.all([
        db
          .select()
          .from(schema.agreements)
          .where(
            and(
              eq(schema.agreements.contractAddress, contractAddress),
              or(
                eq(schema.agreements.employer, userAddress),
                eq(schema.agreements.contributor, userAddress),
              ),
            ),
          )
          .orderBy(desc(schema.agreements.createdAt))
          .limit(limit)
          .offset(offset),

        db
          .select({
            agreement: schema.agreements,
          })
          .from(schema.agreements)
          .innerJoin(schema.employees, eq(schema.agreements.id, schema.employees.agreementId))
          .where(
            and(
              eq(schema.agreements.contractAddress, contractAddress),
              eq(schema.employees.employeeAddress, userAddress),
              eq(schema.agreements.mode, 1),
            ),
          )
          .orderBy(desc(schema.agreements.createdAt))
          .limit(limit),
      ]);

      const allAgreements = [...agreements, ...employeeAgreements.map((e) => e.agreement)];
      const uniqueAgreements = [...new Map(allAgreements.map((a) => [a.id, a])).values()];
      const pagedAgreements = uniqueAgreements.slice(0, limit);

      const checkpointBlock = deriveSyncCheckpoint(allAgreements);

      const body = {
        agreements: z.array(AgreementSchema).parse(pagedAgreements),
        count: pagedAgreements.length,
        source: INDEXED_DATA_SOURCE,
      };

      res.setHeader("x-indexer-sync-checkpoint", String(checkpointBlock));
      applyIndexedCacheHeaders(res, body, indexedCacheOptions);
      res.json(body);

      // Observability
      const durationMs = Math.round(performance.now() - startTime);
      incIndexedMetric(INDEXED_METRICS.REQUESTS);
      if (pagedAgreements.length > 0) incIndexedMetric(INDEXED_METRICS.ROWS_FOUND);
      if (checkpointBlock > 0) incIndexedMetric(INDEXED_METRICS.SYNC_CHECKPOINT_OBSERVED);
      logIndexedEvent("info", INDEXED_OPS.AGREEMENTS_FOR_USER, {
        durationMs,
        syncCheckpoint: checkpointBlock,
        count: pagedAgreements.length,
        httpStatus: 200,
        contractAddress,
        userAddress,
      });
    } catch (e: any) {
      const durationMs = Math.round(performance.now() - startTime);
      incIndexedMetric(INDEXED_METRICS.REQUESTS);
      incIndexedMetric(INDEXED_METRICS.ERRORS);
      logIndexedEvent("error", INDEXED_OPS.AGREEMENTS_FOR_USER, {
        durationMs,
        httpStatus: 500,
        error: e?.message,
        contractAddress: req.params.contract_address,
        userAddress: req.params.user_address,
      });
      next(e);
    }
  },
);

/**
 * GET /indexed/agreement/:contract_address/:agreement_id
 *
 * Retrieves full details for a single agreement including related events, payments,
 * milestones, employees, and escrow events.
 */
indexedRouter.get("/indexed/agreement/:contract_address/:agreement_id", async (req, res, next) => {
  const startTime = performance.now();
  try {
    const contractAddress = StarknetAddress.parse(req.params.contract_address);
    if (contractAddress === normalizeStarknetAddress(defaults.payrollEscrowAddress)) {
      res.status(400).json({ error: "Invalid contract address for agreement details" });
      return;
    }
    const agreementId = AgreementId.parse(req.params.agreement_id);

    const agreement = await db
      .select()
      .from(schema.agreements)
      .where(
        and(
          eq(schema.agreements.contractAddress, contractAddress),
          eq(schema.agreements.id, agreementId),
        ),
      )
      .limit(1);

    if (agreement.length === 0) {
      notFoundResponse(res, "Agreement not found");
      return;
    }

    const [events, payments, milestones, employees, escrowEvents] = await Promise.all([
      db.select().from(schema.agreementEvents)
        .where(eq(schema.agreementEvents.agreementId, agreementId))
        .orderBy(desc(schema.agreementEvents.blockNumber)).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.payments)
        .where(eq(schema.payments.agreementId, agreementId))
        .orderBy(desc(schema.payments.blockNumber)).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.milestones)
        .where(eq(schema.milestones.agreementId, agreementId))
        .orderBy(schema.milestones.milestoneId).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.employees)
        .where(eq(schema.employees.agreementId, agreementId))
        .orderBy(schema.employees.employeeIndex).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.escrowEvents)
        .where(eq(schema.escrowEvents.agreementId, agreementId))
        .orderBy(desc(schema.escrowEvents.blockNumber)).limit(MAX_INTERNAL_LIMIT),
    ]);

    const body = {
      agreement: AgreementSchema.parse(agreement[0]),
      events,
      payments,
      milestones,
      employees,
      escrowEvents,
    };

    const checkpointBlock = deriveSyncCheckpoint(
      [agreement[0], ...events, ...payments, ...milestones, ...employees, ...escrowEvents],
    );

    res.setHeader("x-indexer-sync-checkpoint", String(checkpointBlock));
    applyIndexedCacheHeaders(res, body, indexedCacheOptions);
    res.json(body);

    // Observability
    const durationMs = Math.round(performance.now() - startTime);
    const allRows = [...events, ...payments, ...milestones, ...employees, ...escrowEvents];
    incIndexedMetric(INDEXED_METRICS.REQUESTS);
    if (allRows.length > 0) incIndexedMetric(INDEXED_METRICS.ROWS_FOUND);
    if (checkpointBlock > 0) incIndexedMetric(INDEXED_METRICS.SYNC_CHECKPOINT_OBSERVED);
    logIndexedEvent("info", INDEXED_OPS.AGREEMENT_DETAIL, {
      durationMs,
      syncCheckpoint: checkpointBlock,
      eventsCount: events.length,
      paymentsCount: payments.length,
      milestonesCount: milestones.length,
      employeesCount: employees.length,
      escrowEventsCount: escrowEvents.length,
      httpStatus: 200,
      contractAddress,
      agreementId,
    });
  } catch (e: any) {
    const durationMs = Math.round(performance.now() - startTime);
    incIndexedMetric(INDEXED_METRICS.REQUESTS);
    incIndexedMetric(INDEXED_METRICS.ERRORS);
    logIndexedEvent("error", INDEXED_OPS.AGREEMENT_DETAIL, {
      durationMs,
      httpStatus: 500,
      error: e?.message,
      contractAddress: req.params.contract_address,
      agreementId: req.params.agreement_id,
    });
    next(e);
  }
});

/**
 * GET /indexed/payments/user/:user_address
 *
 * Retrieves payments sent or received by a specific user address.
 */
indexedRouter.get("/indexed/payments/user/:user_address", async (req, res, next) => {
  const startTime = performance.now();
  try {
    const userAddress = StarknetAddress.parse(req.params.user_address);
    const { limit, offset } = parsePagination(req.query);

    const payments = await db
      .select()
      .from(schema.payments)
      .where(or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)))
      .orderBy(desc(schema.payments.blockNumber))
      .limit(limit)
      .offset(offset);

    const checkpointBlock = deriveSyncCheckpoint(payments);
    const body = { payments, count: payments.length };
    res.setHeader("x-indexer-sync-checkpoint", String(checkpointBlock));
    res.json(body);

    // Observability
    const durationMs = Math.round(performance.now() - startTime);
    incIndexedMetric(INDEXED_METRICS.REQUESTS);
    if (payments.length > 0) incIndexedMetric(INDEXED_METRICS.ROWS_FOUND);
    if (checkpointBlock > 0) incIndexedMetric(INDEXED_METRICS.SYNC_CHECKPOINT_OBSERVED);
    logIndexedEvent("info", INDEXED_OPS.PAYMENTS_FOR_USER, {
      durationMs,
      syncCheckpoint: checkpointBlock,
      count: payments.length,
      httpStatus: 200,
      userAddress,
    });
  } catch (e: any) {
    const durationMs = Math.round(performance.now() - startTime);
    incIndexedMetric(INDEXED_METRICS.REQUESTS);
    incIndexedMetric(INDEXED_METRICS.ERRORS);
    logIndexedEvent("error", INDEXED_OPS.PAYMENTS_FOR_USER, {
      durationMs,
      httpStatus: 500,
      error: e?.message,
      userAddress: req.params.user_address,
    });
    next(e);
  }
});

/**
 * GET /indexed/escrow/:contract_address/balance/:agreement_id
 *
 * Computes agreement escrow balance by replaying indexed escrow events.
 */
indexedRouter.get(
  "/indexed/escrow/:contract_address/balance/:agreement_id",
  async (req, res, next) => {
    const startTime = performance.now();
    try {
      const contractAddress = StarknetAddress.parse(req.params.contract_address);
      if (contractAddress !== normalizeStarknetAddress(defaults.payrollEscrowAddress)) {
        res.status(400).json({ error: "Invalid contract address for escrow balance" });
        return;
      }
      const agreementId = AgreementId.parse(req.params.agreement_id);

      const escrowEvents = await db
        .select()
        .from(schema.escrowEvents)
        .where(
          and(
            eq(schema.escrowEvents.contractAddress, contractAddress),
            eq(schema.escrowEvents.agreementId, agreementId),
          ),
        )
        .orderBy(schema.escrowEvents.blockNumber)
        .limit(MAX_ESCROW_EVENTS_LIMIT); 

      let balance = BigInt(0);
      for (const event of escrowEvents) {
        if (event.eventType === "Funded") {
          balance += BigInt(event.amount);
        } else if (event.eventType === "Released" || event.eventType === "Refunded") {
          balance -= BigInt(event.amount);
        }
      }

      const checkpointBlock = deriveSyncCheckpoint(escrowEvents);
      const body = {
        agreement_id: agreementId,
        balance: balance.toString(),
        events: escrowEvents,
      };

      res.setHeader("x-indexer-sync-checkpoint", String(checkpointBlock));
      res.json(body);

      // Observability
      const durationMs = Math.round(performance.now() - startTime);
      incIndexedMetric(INDEXED_METRICS.REQUESTS);
      if (escrowEvents.length > 0) incIndexedMetric(INDEXED_METRICS.ROWS_FOUND);
      if (checkpointBlock > 0) incIndexedMetric(INDEXED_METRICS.SYNC_CHECKPOINT_OBSERVED);
      logIndexedEvent("info", INDEXED_OPS.ESCROW_BALANCE, {
        durationMs,
        syncCheckpoint: checkpointBlock,
        eventsCount: escrowEvents.length,
        balance: balance.toString(),
        httpStatus: 200,
        contractAddress,
        agreementId,
      });
    } catch (e: any) {
      const durationMs = Math.round(performance.now() - startTime);
      incIndexedMetric(INDEXED_METRICS.REQUESTS);
      incIndexedMetric(INDEXED_METRICS.ERRORS);
      logIndexedEvent("error", INDEXED_OPS.ESCROW_BALANCE, {
        durationMs,
        httpStatus: 500,
        error: e?.message,
        contractAddress: req.params.contract_address,
        agreementId: req.params.agreement_id,
      });
      next(e);
    }
  },
);

export default indexedRouter;


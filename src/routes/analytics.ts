import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { asc, eq, and, gt, gte, lte, or, sql } from "drizzle-orm";
import { StarknetAddress } from "../utils/validation.js";
import { DEFAULT_TOKEN_DECIMALS } from "../utils/codec.js";
import { env } from "../config.js";
import { AnalyticsCache, buildAnalyticsCacheKey } from "../utils/analytics-cache.js";

export const analyticsRouter = Router();

// ---------------------------------------------------------------------------
// Constants & Inflight State
// ---------------------------------------------------------------------------

export const ANALYTICS_ROLLUP_BATCH_SIZE = 500;

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sept",
  "Oct",
  "Nov",
  "Dec",
] as const;

const DISPLAY_DIVISOR = 10n ** BigInt(DEFAULT_TOKEN_DECIMALS);

const inflightRollups = new Set<string>();

/** Resets in-flight rollup lock state (used by test suites). */
export function _resetInflightRollups(): void {
  inflightRollups.clear();
}

/**
 * Convert a raw BigInt amount to a display number by performing BigInt division
 * first (lossless) and then converting the integer and fractional parts
 * separately.
 */
function toDisplayNumber(value: bigint): number {
  const sign = value < 0n ? -1 : 1;
  const abs = sign < 0 ? -value : value;
  const whole = Number(abs / DISPLAY_DIVISOR);
  const fraction = Number(abs % DISPLAY_DIVISOR);
  return sign * (whole + fraction / Number(DISPLAY_DIVISOR));
}

// ---------------------------------------------------------------------------
// Keyset Pagination Batch Collector
// ---------------------------------------------------------------------------

export interface RollupCursor {
  createdAt: Date;
  id: string;
}

/**
 * Iteratively collects query results in keyset-paginated batches until a batch
 * smaller than {@link ANALYTICS_ROLLUP_BATCH_SIZE} is retrieved. Guarantees that
 * cursor motion advances deterministically and throws if a full batch stalls.
 */
export async function collectAnalyticsRollupBatches<
  T extends { createdAt?: Date; id?: string },
>(fetchPage: (cursor?: RollupCursor) => Promise<T[]>): Promise<T[]> {
  const results: T[] = [];
  let cursor: RollupCursor | undefined = undefined;

  while (true) {
    const page = await fetchPage(cursor);
    if (!page || page.length === 0) break;

    results.push(...page);

    if (page.length < ANALYTICS_ROLLUP_BATCH_SIZE) break;

    const last = page[page.length - 1];
    if (!last || !last.createdAt || last.id === undefined) break;

    const nextCursor: RollupCursor = {
      createdAt: new Date(last.createdAt),
      id: String(last.id),
    };

    if (
      cursor &&
      cursor.createdAt.getTime() === nextCursor.createdAt.getTime() &&
      cursor.id === nextCursor.id
    ) {
      throw new Error("Analytics rollup batch cursor did not advance");
    }

    cursor = nextCursor;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

interface AnalyticsTelemetryEntry {
  operation: string;
  duration_ms: number;
  status: "success" | "error";
  request_id?: string;
  user_address?: string;
  year?: number;
  row_counts?: Record<string, number>;
  error?: string;
  cache_hit?: boolean;
}

/**
 * Emits a structured telemetry log entry for each analytics aggregation rollup.
 */
function logAnalyticsTelemetry(entry: AnalyticsTelemetryEntry) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: entry.status === "error" ? "error" : "info",
    ...entry,
  };

  if (env.LOG_FORMAT === "json") {
    if (logEntry.level === "error") {
      console.error(JSON.stringify(logEntry));
    } else {
      console.info(JSON.stringify(logEntry));
    }
  } else {
    const counts = logEntry.row_counts ? ` rows=${JSON.stringify(logEntry.row_counts)}` : "";
    const msg =
      `[${logEntry.timestamp}] ${logEntry.level.toUpperCase()} [analytics-telemetry] ` +
      `${logEntry.operation} ${logEntry.status} ${logEntry.duration_ms}ms` +
      `${logEntry.request_id ? ` [${logEntry.request_id}]` : ""}` +
      `${counts}` +
      `${logEntry.error ? ` error=${logEntry.error}` : ""}`;

    if (logEntry.level === "error") {
      console.error(msg);
    } else {
      console.info(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Validation Schemas and Helpers
// ---------------------------------------------------------------------------

/**
 * Zod schema for query parameters in GET /analytics/:user_address.
 * Normalizes null or empty string to undefined so missing/empty year falls back
 * to the current year, while rejecting non-integer, out-of-range, or malformed inputs.
 */
const AnalyticsQuerySchema = z.object({
  year: z.preprocess(
    (val) => (val === "" || val === null ? undefined : val),
    z.coerce
      .number()
      .int("year must be an integer")
      .min(2020, "year must be >= 2020")
      .max(2100, "year must be <= 2100")
      .optional(),
  ),
});

/**
 * Safely parses raw amount values (bigint, number, string, null, undefined) into BigInt.
 * Returns 0n for malformed or missing values to prevent runtime exceptions in aggregation.
 */
export function parseBigIntSafe(val: unknown): bigint {
  if (val === null || val === undefined || val === "") return 0n;
  if (typeof val === "bigint") return val;
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return 0n;
    return BigInt(Math.floor(val));
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!/^-?\d+$/.test(trimmed)) return 0n;
    try {
      return BigInt(trimmed);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Checks if a value is a valid calendar month (1 through 12).
 */
export function isValidMonth(month: unknown): month is number {
  const num = Number(month);
  return Number.isInteger(num) && num >= 1 && num <= 12;
}

/**
 * Computes an ETag hash string (16 hex chars wrapped in double quotes) from response JSON.
 */
function computeETag(payload: unknown): string {
  const json = JSON.stringify(payload);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
  return `"${hash}"`;
}

// ---------------------------------------------------------------------------
// Route Handler: GET /analytics/:user_address
// ---------------------------------------------------------------------------

analyticsRouter.get("/analytics/:user_address", async (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId: string | undefined = res.locals.requestId;

  try {
    const userAddress = StarknetAddress.parse(req.params.user_address);
    const { year: parsedYear } = AnalyticsQuerySchema.parse(req.query);
    const year = parsedYear ?? new Date().getFullYear();

    // Deduplication lock: prevent concurrent rollups for the same user & year
    const rollupKey = `${userAddress}:${year}`;
    if (inflightRollups.has(rollupKey)) {
      res.status(409).json({
        error: "Duplicate rollup in progress — retry after a few seconds",
      });
      return;
    }
    inflightRollups.add(rollupKey);

    try {
      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59, 999);

      // --- Query 1: Payments ---
      const payments = await collectAnalyticsRollupBatches(async (cursor) => {
        const baseFilter = and(
          or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)),
          gte(schema.payments.createdAt, startDate),
          lte(schema.payments.createdAt, endDate),
        );
        const cursorFilter = cursor
          ? or(
              gt(schema.payments.createdAt, cursor.createdAt),
              and(
                eq(schema.payments.createdAt, cursor.createdAt),
                gt(schema.payments.id, cursor.id),
              ),
            )
          : undefined;

        const whereCondition = cursorFilter ? and(baseFilter, cursorFilter) : baseFilter;
        const query = db
          .select({
            id: schema.payments.id,
            createdAt: schema.payments.createdAt,
            month: sql<number>`EXTRACT(MONTH FROM ${schema.payments.createdAt})`,
            amount: schema.payments.amount,
            from: schema.payments.from,
            to: schema.payments.to,
          })
          .from(schema.payments)
          .where(whereCondition);

        return typeof (query as any).orderBy === "function"
          ? await (query as any)
              .orderBy(asc(schema.payments.createdAt), asc(schema.payments.id))
              .limit(ANALYTICS_ROLLUP_BATCH_SIZE)
          : await query;
      });

      // --- Query 2: Escrow Events ---
      const escrowEvents = await collectAnalyticsRollupBatches(async (cursor) => {
        const baseFilter = and(
          or(
            eq(schema.escrowEvents.employer, userAddress),
            eq(schema.escrowEvents.to, userAddress),
          ),
          gte(schema.escrowEvents.createdAt, startDate),
          lte(schema.escrowEvents.createdAt, endDate),
        );
        const cursorFilter = cursor
          ? or(
              gt(schema.escrowEvents.createdAt, cursor.createdAt),
              and(
                eq(schema.escrowEvents.createdAt, cursor.createdAt),
                gt(schema.escrowEvents.id, cursor.id),
              ),
            )
          : undefined;

        const whereCondition = cursorFilter ? and(baseFilter, cursorFilter) : baseFilter;
        const query = db
          .select({
            id: schema.escrowEvents.id,
            createdAt: schema.escrowEvents.createdAt,
            month: sql<number>`EXTRACT(MONTH FROM ${schema.escrowEvents.createdAt})`,
            amount: schema.escrowEvents.amount,
            eventType: schema.escrowEvents.eventType,
            employer: schema.escrowEvents.employer,
            to: schema.escrowEvents.to,
          })
          .from(schema.escrowEvents)
          .where(whereCondition);

        return typeof (query as any).orderBy === "function"
          ? await (query as any)
              .orderBy(asc(schema.escrowEvents.createdAt), asc(schema.escrowEvents.id))
              .limit(ANALYTICS_ROLLUP_BATCH_SIZE)
          : await query;
      });

      // --- Query 3: Agreement Creations ---
      const agreementCreations = await collectAnalyticsRollupBatches(async (cursor) => {
        const baseFilter = and(
          eq(schema.agreementEvents.eventType, "AgreementCreated"),
          or(
            eq(schema.agreements.employer, userAddress),
            eq(schema.agreements.contributor, userAddress),
          ),
          gte(schema.agreementEvents.createdAt, startDate),
          lte(schema.agreementEvents.createdAt, endDate),
        );
        const cursorFilter = cursor
          ? or(
              gt(schema.agreementEvents.createdAt, cursor.createdAt),
              and(
                eq(schema.agreementEvents.createdAt, cursor.createdAt),
                gt(schema.agreementEvents.id, cursor.id),
              ),
            )
          : undefined;

        const whereCondition = cursorFilter ? and(baseFilter, cursorFilter) : baseFilter;
        const query = db
          .select({
            id: schema.agreementEvents.id,
            createdAt: schema.agreementEvents.createdAt,
            month: sql<number>`EXTRACT(MONTH FROM ${schema.agreementEvents.createdAt})`,
            agreementId: schema.agreementEvents.agreementId,
          })
          .from(schema.agreementEvents)
          .innerJoin(
            schema.agreements,
            eq(schema.agreementEvents.agreementId, schema.agreements.id),
          )
          .where(whereCondition);

        return typeof (query as any).orderBy === "function"
          ? await (query as any)
              .orderBy(asc(schema.agreementEvents.createdAt), asc(schema.agreementEvents.id))
              .limit(ANALYTICS_ROLLUP_BATCH_SIZE)
          : await query;
      });

      // ---------------------------------------------------------------------
      // Aggregation — all arithmetic in BigInt space to preserve precision
      // ---------------------------------------------------------------------
      const monthlyData: Record<number, bigint> = {};
      const monthHasFinancialActivity: Record<number, boolean> = {};
      for (let i = 1; i <= 12; i++) {
        monthlyData[i] = 0n;
        monthHasFinancialActivity[i] = false;
      }

      payments.forEach((p: any) => {
        const month = Number(p.month);
        if (!isValidMonth(month)) return;
        monthHasFinancialActivity[month] = true;
        const amount = parseBigIntSafe(p.amount);
        if (p.from === userAddress) {
          monthlyData[month] = (monthlyData[month] || 0n) - amount;
        }
        if (p.to === userAddress) {
          monthlyData[month] = (monthlyData[month] || 0n) + amount;
        }
        if (p.from !== userAddress && p.to !== userAddress) {
          monthlyData[month] = (monthlyData[month] || 0n) + amount;
        }
      });

      escrowEvents.forEach((e: any) => {
        const month = Number(e.month);
        if (!isValidMonth(month)) return;
        monthHasFinancialActivity[month] = true;
        const amount = parseBigIntSafe(e.amount);
        if (e.eventType === "Funded") {
          if (!e.employer || e.employer === userAddress) {
            monthlyData[month] = (monthlyData[month] || 0n) - amount;
          }
        } else if (e.eventType === "Released") {
          if (!e.to || e.to === userAddress) {
            monthlyData[month] = (monthlyData[month] || 0n) + amount;
          }
        } else if (e.eventType === "Refunded") {
          if (!e.employer || e.employer === userAddress) {
            monthlyData[month] = (monthlyData[month] || 0n) + amount;
          }
        }
      });

      const agreementCountsByMonth: Record<number, number> = {};
      agreementCreations.forEach((a: any) => {
        const month = Number(a.month);
        if (!isValidMonth(month)) return;
        agreementCountsByMonth[month] = (agreementCountsByMonth[month] || 0) + 1;
      });

      // Agreement creation proxy: 1000 base units per creation only for months
      // with no payment or escrow activity.
      Object.keys(agreementCountsByMonth).forEach((monthStr) => {
        const month = Number(monthStr);
        if (isValidMonth(month) && !monthHasFinancialActivity[month]) {
          const count = agreementCountsByMonth[month];
          monthlyData[month] = (monthlyData[month] || 0n) + BigInt(count * 1000);
        }
      });

      const chartData = MONTH_NAMES.map((month, index) => {
        const monthNum = index + 1;
        const value = monthlyData[monthNum] || 0n;
        return { month, views: toDisplayNumber(value) };
      });

      const totalRaw = Object.values(monthlyData).reduce((sum, v) => sum + v, 0n);

    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logAnalyticsTelemetry({
      operation: "analytics_monthly_rollup",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      request_id: requestId,
      user_address: userAddress,
      year,
      row_counts: {
        payments: payments.length,
        escrow_events: escrowEvents.length,
        agreement_creations: agreementCreations.length,
      },
    });

    res.json({
      year,
      data: chartData,
      total: toDisplayNumber(totalRaw),
    });
    } finally {
      inflightRollups.delete(rollupKey);
    }
  } catch (e: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    if (!(e instanceof z.ZodError)) {
      logAnalyticsTelemetry({
        operation: "analytics_monthly_rollup",
        duration_ms: Math.round(duration * 100) / 100,
        status: "error",
        request_id: requestId,
        user_address: req.params.user_address,
        error: e?.message || String(e),
      });
    }
    next(e);
  }
});

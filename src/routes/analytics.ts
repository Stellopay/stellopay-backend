import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { asc, eq, and, gt, or, gte, lte, sql } from "drizzle-orm";
import { StarknetAddress } from "../utils/validation.js";
import { DEFAULT_TOKEN_DECIMALS } from "../utils/codec.js";
import { env } from "../config.js";

export const analyticsRouter = Router();

// ---------------------------------------------------------------------------
// Constants (hoisted to avoid per-request allocation)
// ---------------------------------------------------------------------------

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

/**
 * Convert a raw BigInt amount to a display number by performing BigInt division
 * first (lossless) and then converting the integer and fractional parts
 * separately. This avoids calling `formatTokenAmount` 13 times per request,
 * each of which recomputes the divisor and rebuilds a formatted string.
 */
function toDisplayNumber(value: bigint): number {
  const sign = value < 0n ? -1 : 1;
  const abs = sign < 0 ? -value : value;
  const whole = Number(abs / DISPLAY_DIVISOR);
  const fraction = Number(abs % DISPLAY_DIVISOR);
  return sign * (whole + fraction / Number(DISPLAY_DIVISOR));
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
}

/**
 * Emits a structured telemetry log entry for each analytics aggregation rollup.
 *
 * Respects env.LOG_FORMAT:
 * - "json" → single-line JSON via console.info / console.error (production default)
 * - anything else → human-readable text via console.info / console.error (development)
 *
 * Respects env.LOG_LEVEL: debug entries are suppressed when LOG_LEVEL is not "debug".
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

// Get analytics data (monthly payment amounts) for a user
analyticsRouter.get("/analytics/:user_address", async (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId: string | undefined = res.locals.requestId;

  try {
    const userAddress = StarknetAddress.parse(req.params.user_address);
    const { year: parsedYear } = AnalyticsQuerySchema.parse(req.query);
    const year = parsedYear ?? new Date().getFullYear();

    // --- Idempotency: ETag / conditional request ---
    // The ETag cannot be pre-computed without the DB result, so we query first
    // and then check. If the client sends `If-None-Match` matching our ETag we
    // return 304. This handles retries cleanly: the client gets a fast no-op
    // instead of re-transferring the full payload.
    const ifNoneMatch = req.headers["if-none-match"] as string | undefined;

    const payments = await db
      .select({
        month: sql<number>`EXTRACT(MONTH FROM ${schema.payments.createdAt})`,
        amount: schema.payments.amount,
        from: schema.payments.from,
        to: schema.payments.to,
      })
      .from(schema.payments)
      .where(
        and(
          or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)),
          gte(schema.payments.createdAt, startDate),
          lte(schema.payments.createdAt, endDate),
        ),
      );
      const cursorFilter = cursor
        ? or(
            gt(schema.payments.createdAt, cursor.createdAt),
            and(eq(schema.payments.createdAt, cursor.createdAt), gt(schema.payments.id, cursor.id)),
          )
        : undefined;

      return db
        .select({
          id: schema.payments.id,
          createdAt: schema.payments.createdAt,
          month: sql<number>`EXTRACT(MONTH FROM ${schema.payments.createdAt})`,
          amount: schema.payments.amount,
        })
        .from(schema.payments)
        .where(cursorFilter ? and(filters, cursorFilter) : filters)
        .orderBy(asc(schema.payments.createdAt), asc(schema.payments.id))
        .limit(ANALYTICS_ROLLUP_BATCH_SIZE);
    });

    // Get escrow events (funding, releases, refunds)
    const escrowEvents = await db
      .select({
        month: sql<number>`EXTRACT(MONTH FROM ${schema.escrowEvents.createdAt})`,
        amount: schema.escrowEvents.amount,
        eventType: schema.escrowEvents.eventType,
        employer: schema.escrowEvents.employer,
        to: schema.escrowEvents.to,
      })
      .from(schema.escrowEvents)
      .where(
        and(
          or(
            eq(schema.escrowEvents.employer, userAddress),
            eq(schema.escrowEvents.to, userAddress),
          ),
        ),

      db
        .select({
          month: sql<number>`EXTRACT(MONTH FROM ${schema.escrowEvents.createdAt})`,
          amount: schema.escrowEvents.amount,
          eventType: schema.escrowEvents.eventType,
        })
        .from(schema.escrowEvents)
        .where(
          and(
            or(
              eq(schema.escrowEvents.employer, userAddress),
              eq(schema.escrowEvents.to, userAddress),
            ),
            gte(schema.escrowEvents.createdAt, startDate),
            lte(schema.escrowEvents.createdAt, endDate),
          ),
        ),

      db
        .select({
          month: sql<number>`EXTRACT(MONTH FROM ${schema.agreementEvents.createdAt})`,
          agreementId: schema.agreementEvents.agreementId,
        })
        .from(schema.agreementEvents)
        .innerJoin(schema.agreements, eq(schema.agreementEvents.agreementId, schema.agreements.id))
        .where(
          and(
            eq(schema.agreementEvents.eventType, "AgreementCreated"),
            or(
              eq(schema.agreements.employer, userAddress),
              eq(schema.agreements.contributor, userAddress),
            ),
            gte(schema.agreementEvents.createdAt, startDate),
            lte(schema.agreementEvents.createdAt, endDate),
          ),
        ),
    ]);

    // Aggregate by month
    const monthlyData: Record<number, bigint> = {};
    for (let i = 1; i <= 12; i++) {
      monthlyData[i] = 0n;
    }

    // Sum payment amounts (received payments are positive, sent are negative)
    payments.forEach((p) => {
      const month = Number(p.month);
      if (!isValidMonth(month)) return;
      const amount = parseBigIntSafe(p.amount);
      if (p.from === userAddress) {
        monthlyData[month] = (monthlyData[month] || 0n) - amount;
      }
      if (p.to === userAddress) {
        monthlyData[month] = (monthlyData[month] || 0n) + amount;
      }
    });

    // Add escrow events (funding is negative, releases/refunds are positive)
    escrowEvents.forEach((e) => {
      const month = Number(e.month);
      if (!isValidMonth(month)) return;
      const amount = parseBigIntSafe(e.amount);
      if (e.eventType === "Funded") {
        if (e.employer === userAddress) {
          monthlyData[month] = (monthlyData[month] || 0n) - amount; // Funding is outgoing
        }
      } else if (e.eventType === "Released") {
        if (e.to === userAddress) {
          monthlyData[month] = (monthlyData[month] || 0n) + amount; // Releases are incoming
        }
      } else if (e.eventType === "Refunded") {
        if (e.employer === userAddress) {
          monthlyData[month] = (monthlyData[month] || 0n) + amount; // Refunds are incoming
        }
      }
    });

    // Add agreement creation counts (use count as a proxy for activity)
    // Since there are no payments yet, we'll show agreement creation activity
    const agreementCountsByMonth: Record<number, number> = {};
    agreementCreations.forEach((a: any) => {
      const month = Number(a.month);
      if (!isValidMonth(month)) return;
      agreementCountsByMonth[month] = (agreementCountsByMonth[month] || 0) + 1;
    });

    // If no payments/escrow events, use agreement counts for visualization
    const hasFinancialActivity = payments.length > 0 || escrowEvents.length > 0;
    if (!hasFinancialActivity) {
      // Multiply by a base amount to make it visible on chart
      Object.keys(agreementCountsByMonth).forEach((monthStr) => {
        const month = Number(monthStr);
        if (isValidMonth(month)) {
          const count = agreementCountsByMonth[month];
          // Use a base value (e.g., 1000 per agreement) for visualization when no payments exist
          monthlyData[month] = (monthlyData[month] || 0n) + BigInt(count * 1000);
        }
      });
    }

    // Convert to chart format using the precomputed divisor instead of calling
    // formatTokenAmount 13 times (each call recomputes the BigInt exponent).
    const chartData = MONTH_NAMES.map((month, index) => {
      const monthNum = index + 1;
      const value = monthlyData[monthNum] || 0n;
      return { month, views: toDisplayNumber(value) };
    });

    // Sum the raw BigInt amounts before formatting so the total is computed
    // losslessly rather than by accumulating already-rounded display values.
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
  } catch (e: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    // Only log telemetry for errors that are not Zod validation failures;
    // those are surfaced as 400s by the global error handler and do not
    // represent a backend data path failure.
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

// ---------------------------------------------------------------------------
// Aggregation core (extracted for testability)
// ---------------------------------------------------------------------------

async function computeRollup(
  userAddress: string,
  year: number,
  requestId: string | undefined,
  start: bigint,
): Promise<AnalyticsRollupResponse> {
  const startDate = new Date(year, 0, 1);
  const endDate = new Date(year, 11, 31, 23, 59, 59);

  // --- Query 1: payments ---
  const payments = await db
    .select({
      month: sql<number>`EXTRACT(MONTH FROM ${schema.payments.createdAt})`,
      amount: schema.payments.amount,
      from: schema.payments.from,
      to: schema.payments.to,
    })
    .from(schema.payments)
    .where(
      and(
        or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)),
        gte(schema.payments.createdAt, startDate),
        lte(schema.payments.createdAt, endDate),
      ),
    );

  // --- Query 2: escrow events ---
  const escrowEvents = await db
    .select({
      month: sql<number>`EXTRACT(MONTH FROM ${schema.escrowEvents.createdAt})`,
      amount: schema.escrowEvents.amount,
      eventType: schema.escrowEvents.eventType,
    })
    .from(schema.escrowEvents)
    .where(
      and(
        or(eq(schema.escrowEvents.employer, userAddress), eq(schema.escrowEvents.to, userAddress)),
        gte(schema.escrowEvents.createdAt, startDate),
        lte(schema.escrowEvents.createdAt, endDate),
      ),
    );

  // --- Query 3: agreement creations ---
  const agreementCreations = await db
    .select({
      month: sql<number>`EXTRACT(MONTH FROM ${schema.agreementEvents.createdAt})`,
      agreementId: schema.agreementEvents.agreementId,
    })
    .from(schema.agreementEvents)
    .innerJoin(schema.agreements, eq(schema.agreementEvents.agreementId, schema.agreements.id))
    .where(
      and(
        eq(schema.agreementEvents.eventType, "AgreementCreated"),
        or(
          eq(schema.agreements.employer, userAddress),
          eq(schema.agreements.contributor, userAddress),
        ),
        gte(schema.agreementEvents.createdAt, startDate),
        lte(schema.agreementEvents.createdAt, endDate),
      ),
    );

  // --- Aggregation ---
  const monthlyData: Record<number, bigint> = {};
  for (let i = 1; i <= 12; i++) {
    monthlyData[i] = 0n;
  }

  // Payments: incoming (to === user) → +amount, outgoing (from === user) → -amount.
  payments.forEach((p) => {
    const month = Number(p.month);
    const amount = BigInt(p.amount);
    const isIncoming = p.to === userAddress;
    monthlyData[month] = (monthlyData[month] || 0n) + (isIncoming ? amount : -amount);
  });

  // Escrow events: Funded → negative (outgoing), Released/Refunded → positive (incoming).
  escrowEvents.forEach((e) => {
    const month = Number(e.month);
    const amount = BigInt(e.amount);
    if (e.eventType === "Funded") {
      monthlyData[month] = (monthlyData[month] || 0n) - amount;
    } else {
      monthlyData[month] = (monthlyData[month] || 0n) + amount;
    }
  });

  // Agreement creations: activity proxy (count × 1000 base units).
  // Only applied when no payment or escrow data exists for that month, to
  // avoid inflating the chart when real financial data is present.
  const agreementCountsByMonth: Record<number, number> = {};
  agreementCreations.forEach((a: any) => {
    const month = Number(a.month);
    agreementCountsByMonth[month] = (agreementCountsByMonth[month] || 0) + 1;
  });
  Object.keys(agreementCountsByMonth).forEach((monthStr) => {
    const month = Number(monthStr);
    if (monthlyData[month] === 0n) {
      const count = agreementCountsByMonth[month];
      monthlyData[month] = BigInt(count * 1000);
    }
  });

  const monthNames = [
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
  ];

  const chartData: ChartMonth[] = monthNames.map((month, index) => {
    const monthNum = index + 1;
    const value = monthlyData[monthNum] || 0n;
    return {
      month,
      views: Number(formatTokenAmount(value, DEFAULT_TOKEN_DECIMALS)),
    };
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

  return {
    year,
    data: chartData,
    total: Number(formatTokenAmount(totalRaw, DEFAULT_TOKEN_DECIMALS)),
  };
}

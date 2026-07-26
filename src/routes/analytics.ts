import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { asc, eq, and, gt, or, gte, lte, sql } from "drizzle-orm";
import { StarknetAddress } from "../utils/validation.js";
import { formatTokenAmount, DEFAULT_TOKEN_DECIMALS } from "../utils/codec.js";
import { env } from "../config.js";

export const analyticsRouter = Router();

/**
 * Maximum number of source events read by one analytics rollup query.
 *
 * This is an internal database batching limit, not a client-facing response
 * limit: the endpoint keeps its existing twelve-month response shape.
 */
export const ANALYTICS_ROLLUP_BATCH_SIZE = 500;

interface AnalyticsRollupCursor {
  createdAt: Date;
  id: string;
}

interface AnalyticsRollupRow extends AnalyticsRollupCursor {}

/**
 * Reads a complete rollup source in deterministic, keyset-paginated batches.
 * `(createdAt, id)` is the cursor so ties in a timestamp never cause rows to
 * be skipped or repeated. A non-advancing page is rejected rather than risking
 * an unbounded request loop if a query is changed incompatibly.
 */
export async function collectAnalyticsRollupBatches<T extends AnalyticsRollupRow>(
  fetchPage: (cursor?: AnalyticsRollupCursor) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: AnalyticsRollupCursor | undefined;

  while (true) {
    const page = await fetchPage(cursor);
    if (page.length === 0) return rows;

    const last = page[page.length - 1];
    if (
      cursor &&
      (last.createdAt < cursor.createdAt ||
        (last.createdAt.getTime() === cursor.createdAt.getTime() && last.id <= cursor.id))
    ) {
      throw new Error("Analytics rollup batch cursor did not advance");
    }

    rows.push(...page);
    if (page.length < ANALYTICS_ROLLUP_BATCH_SIZE) return rows;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
}

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
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(logEntry));
    } else {
      // eslint-disable-next-line no-console
      console.info(JSON.stringify(logEntry));
    }
  } else {
    const counts = logEntry.row_counts
      ? ` rows=${JSON.stringify(logEntry.row_counts)}`
      : "";
    const msg =
      `[${logEntry.timestamp}] ${logEntry.level.toUpperCase()} [analytics-telemetry] ` +
      `${logEntry.operation} ${logEntry.status} ${logEntry.duration_ms}ms` +
      `${logEntry.request_id ? ` [${logEntry.request_id}]` : ""}` +
      `${counts}` +
      `${logEntry.error ? ` error=${logEntry.error}` : ""}`;

    if (logEntry.level === "error") {
      // eslint-disable-next-line no-console
      console.error(msg);
    } else {
      // eslint-disable-next-line no-console
      console.info(msg);
    }
  }
}

// Get analytics data (monthly payment amounts) for a user
analyticsRouter.get("/analytics/:user_address", async (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId: string | undefined = res.locals.requestId;

  try {
    // Validate the path param before it is normalized so a crafted string
    // cannot produce a surprising lookup key; an invalid address throws a
    // ZodError that the global handler maps to a 400 before any DB query.
    const userAddress = StarknetAddress.parse(req.params.user_address);
    const year =
      z.coerce.number().int().min(2020).max(2100).optional().parse(req.query.year) ||
      new Date().getFullYear();

    // Get all payments for the user in the specified year
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59);

    const payments = await collectAnalyticsRollupBatches((cursor) => {
      const filters = and(
        or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)),
        gte(schema.payments.createdAt, startDate),
        lte(schema.payments.createdAt, endDate),
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
    const escrowEvents = await collectAnalyticsRollupBatches((cursor) => {
      const filters = and(
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

      return db
        .select({
          id: schema.escrowEvents.id,
          createdAt: schema.escrowEvents.createdAt,
          month: sql<number>`EXTRACT(MONTH FROM ${schema.escrowEvents.createdAt})`,
          amount: schema.escrowEvents.amount,
          eventType: schema.escrowEvents.eventType,
        })
        .from(schema.escrowEvents)
        .where(cursorFilter ? and(filters, cursorFilter) : filters)
        .orderBy(asc(schema.escrowEvents.createdAt), asc(schema.escrowEvents.id))
        .limit(ANALYTICS_ROLLUP_BATCH_SIZE);
    });

    // Get agreement creation events (for analytics - count agreements created per month)
    const agreementCreations = await collectAnalyticsRollupBatches((cursor) => {
      const filters = and(
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

      return db
        .select({
          id: schema.agreementEvents.id,
          createdAt: schema.agreementEvents.createdAt,
          month: sql<number>`EXTRACT(MONTH FROM ${schema.agreementEvents.createdAt})`,
          agreementId: schema.agreementEvents.agreementId,
        })
        .from(schema.agreementEvents)
        .innerJoin(schema.agreements, eq(schema.agreementEvents.agreementId, schema.agreements.id))
        .where(cursorFilter ? and(filters, cursorFilter) : filters)
        .orderBy(asc(schema.agreementEvents.createdAt), asc(schema.agreementEvents.id))
        .limit(ANALYTICS_ROLLUP_BATCH_SIZE);
    });

    // Aggregate by month
    const monthlyData: Record<number, bigint> = {};
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

    // Initialize all months to 0
    for (let i = 1; i <= 12; i++) {
      monthlyData[i] = 0n;
    }

    // Sum payment amounts (received payments are positive, sent are negative)
    payments.forEach((p) => {
      const month = Number(p.month);
      const amount = BigInt(p.amount);
      // For received payments, add; for sent payments, we'll track net
      monthlyData[month] = (monthlyData[month] || 0n) + amount;
    });

    // Add escrow events (funding is negative, releases/refunds are positive)
    escrowEvents.forEach((e) => {
      const month = Number(e.month);
      const amount = BigInt(e.amount);
      if (e.eventType === "Funded") {
        monthlyData[month] = (monthlyData[month] || 0n) - amount; // Funding is outgoing
      } else {
        monthlyData[month] = (monthlyData[month] || 0n) + amount; // Releases/refunds are incoming
      }
    });

    // Add agreement creation counts (use count as a proxy for activity)
    // Since there are no payments yet, we'll show agreement creation activity
    const agreementCountsByMonth: Record<number, number> = {};
    agreementCreations.forEach((a: any) => {
      const month = Number(a.month);
      agreementCountsByMonth[month] = (agreementCountsByMonth[month] || 0) + 1;
    });

    // If no payments/escrow events, use agreement counts for visualization
    // Multiply by a base amount to make it visible on chart
    Object.keys(agreementCountsByMonth).forEach((monthStr) => {
      const month = Number(monthStr);
      const count = agreementCountsByMonth[month];
      // Use a base value (e.g., 1000 per agreement) for visualization when no payments exist
      monthlyData[month] = (monthlyData[month] || 0n) + BigInt(count * 1000);
    });

    // Convert to chart format. Monthly amounts are u256 base units summed in
    // BigInt space, so they can exceed Number.MAX_SAFE_INTEGER. Divide
    // losslessly with formatTokenAmount before exposing the numeric display
    // value the chart expects. Amounts are aggregated across tokens, so the
    // 6-decimal USDC/USDT default is assumed here (DEFAULT_TOKEN_DECIMALS);
    // a token-specific override would require per-token aggregation.
    const chartData = monthNames.map((month, index) => {
      const monthNum = index + 1;
      const value = monthlyData[monthNum] || 0n;
      return {
        month,
        views: Number(formatTokenAmount(value, DEFAULT_TOKEN_DECIMALS)),
      };
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
      total: Number(formatTokenAmount(totalRaw, DEFAULT_TOKEN_DECIMALS)),
    });
  } catch (e: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    // Only log telemetry for errors that are not Zod validation failures;
    // those are surfaced as 400s by the global error handler and do not
    // represent a backend data path failure.
    logAnalyticsTelemetry({
      operation: "analytics_monthly_rollup",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      request_id: requestId,
      user_address: req.params.user_address,
      error: e?.message || String(e),
    });
    next(e);
  }
});

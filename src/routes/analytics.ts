import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, gte, lte, sql } from "drizzle-orm";
import { StarknetAddress } from "../utils/validation.js";
import { formatTokenAmount, DEFAULT_TOKEN_DECIMALS } from "../utils/codec.js";

export const analyticsRouter = Router();

// ---------------------------------------------------------------------------
// Response-shape contract
//
// The shape below is the stable API surface for GET /analytics/:user_address.
// Future changes MUST preserve all existing fields and their types so that
// callers built against this contract do not break.
//
// AnalyticsChartEntry — one entry per calendar month (always 12 per response).
//   month  — short month label, one of the MONTH_NAMES array below.
//   views  — signed decimal number: positive = net inflows, negative = net outflows.
//            Amounts are aggregated across all tokens and formatted at
//            DEFAULT_TOKEN_DECIMALS (6) precision.
//
// AnalyticsResponse — top-level response envelope.
//   year   — the calendar year the query covers (integer, 2020–2100).
//   data   — always exactly 12 AnalyticsChartEntry items, Jan–Dec order.
//   total  — sum of every month's `views` value (same decimal precision).
//
// Backward-compatibility rules:
//   - New optional fields may be added to AnalyticsResponse in the future.
//   - The `data` array length (12) and `month` label set are frozen.
//   - The `views` field name is frozen; display consumers depend on it.
//   - The `total` field is the lossless sum of all months, never rounded
//     separately, so clients can reproduce it by summing `views`.
// ---------------------------------------------------------------------------

/** One calendar-month entry in the chart payload. */
export interface AnalyticsChartEntry {
  month: string;
  views: number;
}

/** Top-level response envelope for GET /analytics/:user_address. */
export interface AnalyticsResponse {
  year: number;
  data: AnalyticsChartEntry[];
  total: number;
}

// ---------------------------------------------------------------------------
// Stable month-label set. The order and exact strings are part of the
// backward-compatible contract; chart consumers reference them by string key.
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

/**
 * GET /api/v1/analytics/:user_address
 *
 * Returns monthly aggregated financial activity for a user address for a given
 * calendar year. The response shape is governed by {@link AnalyticsResponse}
 * and is considered stable — see the contract block above for the full
 * backward-compatibility guarantee.
 *
 * **Aggregation sign convention (frozen)**
 * - Payment amounts: always **positive** (net inflows).
 * - Escrow Funded events: **negative** (outgoing capital).
 * - Escrow Released / Refunded events: **positive** (incoming capital).
 * - AgreementCreated activity: positive proxy value (count × 1 000 base units).
 *
 * **Validation**
 * - `:user_address` must be a valid Starknet felt (up to 64 hex chars).
 * - `year` must be an integer in [2020, 2100]; defaults to the current year.
 *
 * **Errors**
 * - 400 — invalid address or out-of-range year (ZodError forwarded to global handler).
 * - 500 — database error (forwarded to global error handler without partial data).
 */
analyticsRouter.get("/analytics/:user_address", async (req, res, next) => {
  try {
    // Validate the path param before it is normalized so a crafted string
    // cannot produce a surprising lookup key; an invalid address throws a
    // ZodError that the global handler maps to a 400 before any DB query.
    const userAddress = StarknetAddress.parse(req.params.user_address);
    const year =
      z.coerce.number().int().min(2020).max(2100).optional().parse(req.query.year) ||
      new Date().getFullYear();

    // Calendar boundaries for the requested year — used as gte/lte filter
    // on every aggregation query so all three sources share the same window.
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59);

    const payments = await db
      .select({
        month: sql<number>`EXTRACT(MONTH FROM ${schema.payments.createdAt})`,
        amount: schema.payments.amount,
      })
      .from(schema.payments)
      .where(
        and(
          or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)),
          gte(schema.payments.createdAt, startDate),
          lte(schema.payments.createdAt, endDate),
        ),
      );

    // Get escrow events (funding, releases, refunds)
    const escrowEvents = await db
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
      );

    // Get agreement creation events (for analytics - count agreements created per month)
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

    // -----------------------------------------------------------------------
    // Aggregation — all arithmetic is in BigInt space so u256 amounts never
    // overflow or lose precision before the final formatTokenAmount call.
    // -----------------------------------------------------------------------
    const monthlyData: Record<number, bigint> = {};

    // Initialize all months to 0 — guarantees the response always has 12 items
    // even when there is no activity, satisfying the "zero-fill" contract.
    for (let i = 1; i <= 12; i++) {
      monthlyData[i] = 0n;
    }

    // Payments: always positive (net inflow from the user's perspective).
    payments.forEach((p) => {
      const month = Number(p.month);
      const amount = BigInt(p.amount);
      monthlyData[month] = (monthlyData[month] ?? 0n) + amount;
    });

    // Escrow events: Funded is negative (outgoing), Released/Refunded are positive.
    escrowEvents.forEach((e) => {
      const month = Number(e.month);
      const amount = BigInt(e.amount);
      if (e.eventType === "Funded") {
        monthlyData[month] = (monthlyData[month] ?? 0n) - amount;
      } else {
        monthlyData[month] = (monthlyData[month] ?? 0n) + amount;
      }
    });

    // Agreement creation activity: each creation adds a small proxy value so
    // months with only agreement activity remain visible on a chart even when
    // no payments or escrow events exist. The 1 000-unit-per-creation constant
    // is part of the frozen contract: changing it would alter displayed totals
    // for existing callers.
    const agreementCountsByMonth: Record<number, number> = {};
    agreementCreations.forEach((a: { month: number; agreementId: string }) => {
      const month = Number(a.month);
      agreementCountsByMonth[month] = (agreementCountsByMonth[month] ?? 0) + 1;
    });
    for (const [monthStr, count] of Object.entries(agreementCountsByMonth)) {
      const month = Number(monthStr);
      monthlyData[month] = (monthlyData[month] ?? 0n) + BigInt(count * 1000);
    }

    // -----------------------------------------------------------------------
    // Serialization — convert BigInt sums to decimal strings via
    // formatTokenAmount, then to Number for the JSON response.
    // Amounts are aggregated across tokens, so DEFAULT_TOKEN_DECIMALS (6,
    // matching USDC/USDT) is used; per-token precision would require separate
    // per-token aggregation passes and is out of scope.
    // -----------------------------------------------------------------------
    const data: AnalyticsChartEntry[] = MONTH_NAMES.map((month, index) => {
      const monthNum = index + 1;
      const value = monthlyData[monthNum] ?? 0n;
      return {
        month,
        views: Number(formatTokenAmount(value, DEFAULT_TOKEN_DECIMALS)),
      };
    });

    // Sum the raw BigInt amounts before formatting so the total is computed
    // losslessly rather than by accumulating already-rounded display values.
    const totalRaw = Object.values(monthlyData).reduce((sum, v) => sum + v, 0n);

    const response: AnalyticsResponse = {
      year,
      data,
      total: Number(formatTokenAmount(totalRaw, DEFAULT_TOKEN_DECIMALS)),
    };

    res.json(response);
  } catch (e) {
    next(e);
  }
});

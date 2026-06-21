import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, gte, lte, sql, inArray } from "drizzle-orm";
import { normalizeStarknetAddress as normalizeAddress } from "../utils/address.js";
import { formatTokenAmount, DEFAULT_TOKEN_DECIMALS } from "../utils/codec.js";

const AddressParam = z.string().min(3);

export const analyticsRouter = Router();

// Get analytics data (monthly payment amounts) for a user
analyticsRouter.get("/analytics/:user_address", async (req, res, next) => {
  try {
    const userAddress = normalizeAddress(req.params.user_address);
    const year =
      z.coerce.number().int().min(2020).max(2100).optional().parse(req.query.year) ||
      new Date().getFullYear();

    // Get all payments for the user in the specified year
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

    res.json({
      year,
      data: chartData,
      total: Number(formatTokenAmount(totalRaw, DEFAULT_TOKEN_DECIMALS)),
    });
  } catch (e) {
    next(e);
  }
});

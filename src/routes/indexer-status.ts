import { Router } from "express";
import { db, schema } from "../db/index.js";
import { desc, count, eq, or } from "drizzle-orm";
import { StarknetAddress, parsePagination } from "../utils/validation.js";

export const indexerStatusRouter = Router();

// Get indexer status and data counts
indexerStatusRouter.get("/indexer/status", async (req, res, next) => {
  try {
    const [agreementsCount, eventsCount, paymentsCount, escrowEventsCount] = await Promise.all([
      db.select({ count: count() }).from(schema.agreements),
      db.select({ count: count() }).from(schema.agreementEvents),
      db.select({ count: count() }).from(schema.payments),
      db.select({ count: count() }).from(schema.escrowEvents),
    ]);

    // Get latest events
    const latestEvents = await db
      .select()
      .from(schema.agreementEvents)
      .orderBy(desc(schema.agreementEvents.blockNumber))
      .limit(5);

    // Get latest agreements
    const latestAgreements = await db
      .select()
      .from(schema.agreements)
      .orderBy(desc(schema.agreements.createdAt))
      .limit(5);

    res.json({
      status: "connected",
      counts: {
        agreements: agreementsCount[0]?.count || 0,
        events: eventsCount[0]?.count || 0,
        payments: paymentsCount[0]?.count || 0,
        escrowEvents: escrowEventsCount[0]?.count || 0,
      },
      latest: {
        events: latestEvents,
        agreements: latestAgreements,
      },
    });
  } catch (e) {
    next(e);
  }
});

// Get events for a specific user
indexerStatusRouter.get("/indexer/user/:user_address/events", async (req, res, next) => {
  try {
    const normalizedAddress = StarknetAddress.parse(req.params.user_address);
    const { limit, offset } = parsePagination(req.query);

    // Get agreements where user is employer or contributor
    const agreements = await db
      .select()
      .from(schema.agreements)
      .where(
        or(
          eq(schema.agreements.employer, normalizedAddress),
          eq(schema.agreements.contributor, normalizedAddress),
        ),
      )
      .orderBy(desc(schema.agreements.createdAt))
      .limit(limit)
      .offset(offset);

    // Get payments
    const payments = await db
      .select()
      .from(schema.payments)
      .where(
        or(eq(schema.payments.from, normalizedAddress), eq(schema.payments.to, normalizedAddress)),
      )
      .orderBy(desc(schema.payments.blockNumber))
      .limit(limit)
      .offset(offset);

    // Get escrow events
    const escrowEvents = await db
      .select()
      .from(schema.escrowEvents)
      .where(
        or(
          eq(schema.escrowEvents.employer, normalizedAddress),
          eq(schema.escrowEvents.to, normalizedAddress),
        ),
      )
      .orderBy(desc(schema.escrowEvents.blockNumber))
      .limit(limit)
      .offset(offset);

    res.json({
      userAddress: normalizedAddress,
      agreements: agreements.length,
      payments: payments.length,
      escrowEvents: escrowEvents.length,
      data: {
        agreements,
        payments,
        escrowEvents,
      },
    });
  } catch (e) {
    next(e);
  }
});

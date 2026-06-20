import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc, inArray } from "drizzle-orm";
import { normalizeStarknetAddress as normalizeAddress } from "../utils/address.js";
import { formatTokenAmount } from "../utils/codec.js";

const AddressParam = z.string().min(3);

export const notificationsRouter = Router();

// Get notifications for a user (important events)
notificationsRouter.get("/notifications/:user_address", async (req, res, next) => {
  try {
    const userAddress = normalizeAddress(req.params.user_address);
    const limit = z.coerce.number().int().positive().max(50).optional().parse(req.query.limit) || 10;

    // Get payment notifications
    const payments = await db
      .select()
      .from(schema.payments)
      .where(
        or(
          eq(schema.payments.from, userAddress),
          eq(schema.payments.to, userAddress)
        )
      )
      .orderBy(desc(schema.payments.blockNumber))
      .limit(limit);

    // Get important agreement events (disputes, activations, cancellations, and creations)
    // First, get agreement IDs where user is involved
    const userAgreements = await db
      .select({ id: schema.agreements.id })
      .from(schema.agreements)
      .where(
        or(
          eq(schema.agreements.employer, userAddress),
          eq(schema.agreements.contributor, userAddress)
        )
      );

    const agreementIds = userAgreements.map(a => a.id);

    // Get important events for user's agreements
    const importantEvents = agreementIds.length > 0 ? await db
      .select()
      .from(schema.agreementEvents)
      .where(
        and(
          inArray(schema.agreementEvents.agreementId, agreementIds),
          or(
            eq(schema.agreementEvents.eventType, "DisputeRaised"),
            eq(schema.agreementEvents.eventType, "DisputeResolved"),
            eq(schema.agreementEvents.eventType, "AgreementActivated"),
            eq(schema.agreementEvents.eventType, "AgreementCancelled"),
            eq(schema.agreementEvents.eventType, "AgreementCreated")
          )
        )
      )
      .orderBy(desc(schema.agreementEvents.blockNumber))
      .limit(limit) : [];

    // Get escrow events (Funded, Released, Refunded)
    const escrowEvents = await db
      .select()
      .from(schema.escrowEvents)
      .where(
        or(
          eq(schema.escrowEvents.employer, userAddress),
          eq(schema.escrowEvents.to, userAddress)
        )
      )
      .orderBy(desc(schema.escrowEvents.blockNumber))
      .limit(limit);

    // Transform to notification format
    const notifications = [
      ...payments.map((p) => ({
        id: p.id,
        title: p.eventType === "PaymentSent" ? "Payment Sent" : "Payment Received",
        message: `#${p.transactionHash.slice(0, 10)} · ${p.eventType === "PaymentSent" ? "You sent" : "You received"} ${formatTokenAmount(p.amount)} tokens`,
        read: false,
        date: p.createdAt.toISOString(),
        type: p.eventType,
        txHash: p.transactionHash,
      })),
      ...importantEvents.map((e) => ({
        id: e.id,
        title: e.eventType === "DisputeRaised" ? "Dispute Raised" 
          : e.eventType === "DisputeResolved" ? "Dispute Resolved"
          : e.eventType === "AgreementActivated" ? "Agreement Activated"
          : e.eventType === "AgreementCreated" ? "Agreement Created"
          : "Agreement Cancelled",
        message: e.eventType === "AgreementCreated" 
          ? `Agreement #${e.agreementId} has been created`
          : `Agreement ${e.agreementId}: ${e.eventType}`,
        read: false,
        date: e.createdAt.toISOString(),
        type: e.eventType,
        txHash: e.transactionHash,
      })),
      ...escrowEvents.map((e) => ({
        id: e.id,
        title: e.eventType === "Funded" ? "Agreement Funded"
          : e.eventType === "Released" ? "Funds Released"
          : "Funds Refunded",
        message: `Agreement ${e.agreementId}: ${e.eventType} of ${formatTokenAmount(e.amount)} tokens`,
        read: false,
        date: e.createdAt.toISOString(),
        type: e.eventType,
        txHash: e.transactionHash,
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
     .slice(0, limit);

    res.json({ notifications, total: notifications.length });
  } catch (e) {
    next(e);
  }
});


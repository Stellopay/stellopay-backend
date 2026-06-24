import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc, inArray } from "drizzle-orm";
import { StarknetAddress } from "../utils/validation.js";
import { formatTokenAmount, getTokenInfo } from "../utils/token-formatting.js";

export const notificationsRouter = Router();

// Get notifications for a user (important events)
notificationsRouter.get("/notifications/:user_address", async (req, res, next) => {
  try {
    // Validate the path param before it is normalized so a crafted string
    // cannot produce a surprising lookup key; an invalid address throws a
    // ZodError that the global handler maps to a 400 before any DB query.
    const userAddress = StarknetAddress.parse(req.params.user_address);
    const limit =
      z.coerce.number().int().positive().max(50).optional().parse(req.query.limit) || 10;

    // Get payment notifications
    const payments = await db
      .select()
      .from(schema.payments)
      .where(or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)))
      .orderBy(desc(schema.payments.blockNumber))
      .limit(limit);

    // Get important agreement events (disputes, activations, cancellations, and creations)
    // First, get agreement IDs where user is involved
    const userAgreements = await db
      .select({ id: schema.agreements.id, token: schema.agreements.token })
      .from(schema.agreements)
      .where(
        or(
          eq(schema.agreements.employer, userAddress),
          eq(schema.agreements.contributor, userAddress),
        ),
      );

    const agreementIds = userAgreements.map((a) => a.id);
    const agreementTokensById = new Map(userAgreements.map((agreement) => [agreement.id, agreement.token]));

    // Get important events for user's agreements
    const importantEvents =
      agreementIds.length > 0
        ? await db
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
                  eq(schema.agreementEvents.eventType, "AgreementCreated"),
                ),
              ),
            )
            .orderBy(desc(schema.agreementEvents.blockNumber))
            .limit(limit)
        : [];

    // Get escrow events (Funded, Released, Refunded)
    const escrowEvents = await db
      .select()
      .from(schema.escrowEvents)
      .where(
        or(eq(schema.escrowEvents.employer, userAddress), eq(schema.escrowEvents.to, userAddress)),
      )
      .orderBy(desc(schema.escrowEvents.blockNumber))
      .limit(limit);

    // Transform to notification format
    const notifications = [
      ...payments.map((p) => {
        const tokenInfo = getTokenInfo(p.token);
        const formattedAmount = formatTokenAmount(p.amount, tokenInfo.decimals);

        return {
          id: p.id,
          title: p.eventType === "PaymentSent" ? "Payment Sent" : "Payment Received",
          message: `#${p.transactionHash.slice(0, 10)} · ${p.eventType === "PaymentSent" ? "You sent" : "You received"} ${formattedAmount} tokens`,
          read: false,
          date: p.createdAt.toISOString(),
          type: p.eventType,
          txHash: p.transactionHash,
        };
      }),
      ...importantEvents.map((e) => ({
        id: e.id,
        title:
          e.eventType === "DisputeRaised"
            ? "Dispute Raised"
            : e.eventType === "DisputeResolved"
              ? "Dispute Resolved"
              : e.eventType === "AgreementActivated"
                ? "Agreement Activated"
                : e.eventType === "AgreementCreated"
                  ? "Agreement Created"
                  : "Agreement Cancelled",
        message:
          e.eventType === "AgreementCreated"
            ? `Agreement #${e.agreementId} has been created`
            : `Agreement ${e.agreementId}: ${e.eventType}`,
        read: false,
        date: e.createdAt.toISOString(),
        type: e.eventType,
        txHash: e.transactionHash,
      })),
      ...escrowEvents.map((e) => {
        const tokenAddress = agreementTokensById.get(e.agreementId) ?? null;
        const tokenInfo = getTokenInfo(tokenAddress);
        const formattedAmount = formatTokenAmount(e.amount, tokenInfo.decimals);

        return {
          id: e.id,
          title:
            e.eventType === "Funded"
              ? "Agreement Funded"
              : e.eventType === "Released"
                ? "Funds Released"
                : "Funds Refunded",
          message: `Agreement ${e.agreementId}: ${e.eventType} of ${formattedAmount} tokens`,
          read: false,
          date: e.createdAt.toISOString(),
          type: e.eventType,
          txHash: e.transactionHash,
        };
      }),
    ]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);

    res.json({ notifications, total: notifications.length });
  } catch (e) {
    next(e);
  }
});

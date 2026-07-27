import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc, inArray } from "drizzle-orm";
import { StarknetAddress } from "../utils/validation.js";
import { normalizeStarknetAddress } from "../utils/address.js";
import {
  formatTokenAmount,
  getTokenInfo,
  type TokenInfo,
} from "../utils/token-formatting.js";

export const notificationsRouter = Router();

export interface NotificationPreferences {
  payments: boolean;
  agreements: boolean;
  escrow: boolean;
  disputes: boolean;
}

/**
 * Returns default notification category preferences for users (all categories enabled).
 */
export function getDefaultNotificationPreferences(): NotificationPreferences {
  return {
    payments: true,
    agreements: true,
    escrow: true,
    disputes: true,
  };
}

/**
 * Computes the total unread count from a list of notification items.
 *
 * Exposed as a standalone helper so callers can recompute unread counts
 * independently of the HTTP handler (e.g. after toggling a `read` flag in
 * state). The notifications route also invokes this helper on its outgoing
 * payload so the unread counter stays in lockstep with the helper's
 * semantics.
 */
export function calculateUnreadCount(notifications: Array<{ read: boolean }>): number {
  return notifications.filter((n) => !n.read).length;
}

/**
 * Per-request token-info cache.
 *
 * `getTokenInfo` re-normalizes and re-compares the address against the known
 * token allowlist on every call; for a feed of escrow events that share an
 * agreement token, looping inside `.map(...)` repeats the same allowlist
 * comparison for every row. The cache is keyed on the **normalized** address
 * (the canonical form `getTokenInfo` itself uses internally) so repeated
 * lookups across the request collapse to a single allowlist comparison — even
 * when callers hand in differently-cased or differently-prefixed addresses.
 *
 * The cache is bound to the route handler below so it is scoped to a single
 * request: it cannot leak across requests or carry stale config across env
 * reloads. `null`/`undefined` collapse onto a single `null` cache key since
 * `getTokenInfo` returns the same zero-decimal placeholder for both.
 */
function createTokenInfoCache() {
  const cache = new Map<string | null, TokenInfo>();
  return {
    resolve(tokenAddress: string | null | undefined): TokenInfo {
      const key = tokenAddress ? normalizeStarknetAddress(tokenAddress) : null;
      const cached = cache.get(key);
      if (cached) return cached;
      const info = getTokenInfo(tokenAddress);
      cache.set(key, info);
      return info;
    },
  };
}

/**
 * Per-request title formatter cache.
 *
 * The five agreement event types surfaced as "important" each go through a
 * `replace(/([A-Z])/g, ' $1').trim()` pass to convert `'AgreementCreated'`
 * into `'Agreement Created'`. Memoizing per `eventType` avoids re-running
 * the regex per row when many events share the same type.
 */
function createTitleCache() {
  const cache = new Map<string, string>();
  return {
    format(eventType: string): string {
      const cached = cache.get(eventType);
      if (cached !== undefined) return cached;
      const title = eventType.replace(/([A-Z])/g, " $1").trim();
      cache.set(eventType, title);
      return title;
    },
  };
}

// Get notifications for a user (important events)
notificationsRouter.get("/notifications/:user_address", async (req, res, next) => {
  try {
    const userAddress = StarknetAddress.parse(req.params.user_address);
    // Hand-rolled limit parser: default 10, max 50, must be a positive integer.
    // Kept local rather than reusing `parsePagination` to preserve the existing
    // /api/v1/notifications contract (default 10, max 50) that older callers
    // and the documented OAS example rely on.
    const limit =
      z.coerce.number().int().positive().max(50).optional().parse(req.query.limit) || 10;

    // Three queries depend only on `userAddress`; the fourth (agreementEvents)
    // depends on the `agreements` result so it runs as a follow-up. Run the
    // independent three through `Promise.all` so a slow payment lookup does
    // not serialize in front of the escrow or agreements lookups.
    const [payments, userAgreements, escrowEvents] = await Promise.all([
      db
        .select()
        .from(schema.payments)
        .where(or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)))
        .orderBy(desc(schema.payments.blockNumber))
        .limit(limit),
      db
        .select({ id: schema.agreements.id, token: schema.agreements.token })
        .from(schema.agreements)
        .where(
          or(
            eq(schema.agreements.employer, userAddress),
            eq(schema.agreements.contributor, userAddress),
          ),
        ),
      db
        .select()
        .from(schema.escrowEvents)
        .where(
          or(
            eq(schema.escrowEvents.employer, userAddress),
            eq(schema.escrowEvents.to, userAddress),
          ),
        )
        .orderBy(desc(schema.escrowEvents.blockNumber))
        .limit(limit),
    ]);

    const agreementIds = userAgreements.map((a) => a.id);
    const agreementTokensById = new Map(userAgreements.map((a) => [a.id, a.token]));

    // Skip the agreementEvents query entirely when the user has no
    // agreements — there is no `inArray(.., agreementIds)` scan to perform.
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

    const tokenInfoCache = createTokenInfoCache();
    const titleCache = createTitleCache();

    const rawNotifications = [
      ...payments.map((p) => {
        const tokenInfo = tokenInfoCache.resolve(p.token);
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
        title: titleCache.format(e.eventType),
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
        const tokenInfo = tokenInfoCache.resolve(
          agreementTokensById.get(e.agreementId) ?? null,
        );
        return {
          id: e.id,
          title: e.eventType === "Funded" ? "Agreement Funded" : `Funds ${e.eventType}`,
          message: `Agreement ${e.agreementId}: ${e.eventType} of ${formatTokenAmount(e.amount, tokenInfo.decimals)} tokens`,
          read: false,
          date: e.createdAt.toISOString(),
          type: e.eventType,
          txHash: e.transactionHash,
        };
      }),
    ]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);

    // `unreadCount` flows through the exported helper so the response stays
    // in lockstep with the helper's semantics; in practice every emitted
    // notification has `read: false` set above, so the helper's filter pass
    // coincides with `rawNotifications.length`.
    res.json({
      notifications: rawNotifications,
      total: rawNotifications.length,
      unreadCount: calculateUnreadCount(rawNotifications),
    });
  } catch (e) {
    next(e);
  }
});

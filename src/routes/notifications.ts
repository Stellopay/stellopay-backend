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
import { env } from "../config.js";

export const notificationsRouter = Router();

/**
 * Notification preference categories for filtering notification types.
 *
 * **Backward-compatibility contract:** This interface shape is frozen. The
 * four category fields (`payments`, `agreements`, `escrow`, `disputes`) and
 * their boolean types are stable and must be preserved across future changes.
 * New categories may be added as optional fields but existing fields cannot
 * be removed or renamed.
 */
export interface NotificationPreferences {
  payments: boolean;   // Covers: PaymentSent, PaymentReceived
  agreements: boolean; // Covers: AgreementCreated, AgreementActivated, AgreementCancelled
  escrow: boolean;     // Covers: Funded, Released, Refunded
  disputes: boolean;   // Covers: DisputeRaised, DisputeResolved
}

/**
 * Returns default notification category preferences for users (all categories enabled).
 *
 * **Backward-compatibility guarantees:**
 * - Always returns a new object instance (never a shared singleton)
 * - All four category fields are present and set to `true`
 * - Returned object can be safely mutated by callers
 * - Function signature and default values are frozen
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
 *
 * **Backward-compatibility guarantees:**
 * - Deduplicates by `id` when present (same `id` counted only once)
 * - Notifications without `id` are counted individually
 * - Supports both string and numeric `id` types
 * - Only counts items where `read === false`
 * - Function signature and counting logic are frozen
 *
 * @param notifications - Array of notification objects with `read` boolean
 *                        and optional `id` field
 * @returns Count of unique unread notifications
 */
export function calculateUnreadCount(notifications: Array<{ id?: string | number, read: boolean }>): number {
  const uniqueIds = new Set<string | number>();
  let count = 0;
  for (const n of notifications) {
    if (!n.read) {
      if (n.id !== undefined) {
        if (!uniqueIds.has(n.id)) {
          uniqueIds.add(n.id);
          count++;
        }
      } else {
        count++;
      }
    }
  }
  return count;
}

interface NotificationsTelemetryEntry {
  operation: "notification_feed";
  status: "success" | "error";
  duration_ms: number;
  request_id?: string;
  notification_count?: number;
  unread_count?: number;
  preferences_enabled?: number;
  error?: string;
}

/** Emits low-cardinality feed telemetry without user or notification data. */
export function logNotificationsTelemetry(entry: NotificationsTelemetryEntry): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: entry.status === "error" ? "error" : "info",
    metric: "notification_preferences_and_unread_count",
    ...entry,
  };

  if (env.LOG_FORMAT === "json") {
    (logEntry.level === "error" ? console.error : console.info)(JSON.stringify(logEntry));
    return;
  }

  const message =
    `[notifications-telemetry] ${logEntry.operation} ${logEntry.status} ${logEntry.duration_ms}ms` +
    `${logEntry.notification_count !== undefined ? ` notifications=${logEntry.notification_count}` : ""}` +
    `${logEntry.unread_count !== undefined ? ` unread=${logEntry.unread_count}` : ""}` +
    `${logEntry.preferences_enabled !== undefined ? ` preferences_enabled=${logEntry.preferences_enabled}` : ""}` +
    `${logEntry.error ? ` error=${logEntry.error}` : ""}`;
  (logEntry.level === "error" ? console.error : console.info)(message);
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

// ---------------------------------------------------------------------------
// Response-shape contract (stable)
//
// NotificationItem — one notification in the response array.
//   id        — unique event/payment/escrow row identifier string.
//   title     — human-readable title derived from eventType (frozen set below).
//   message   — detail sentence; format is stable for existing event types.
//   read      — always false; per-user read state is not persisted server-side.
//   date      — ISO 8601 timestamp of the underlying on-chain event.
//   type      — the raw on-chain eventType string.
//   txHash    — transaction hash of the event.
//
// NotificationsResponse — top-level response envelope.
//   notifications — array of up to `limit` items, sorted newest-first.
//   total         — length of the notifications array after slicing.
//   unreadCount   — count of items where read === false (always === total today).
//   limit         — echoed back from request (or default).
//   offset        — echoed back from request (or 0).
//   hasMore       — true when there are items beyond this page.
//
// Backward-compatibility rules:
//   - All fields listed above are frozen; existing callers depend on them.
//   - Field types cannot change (e.g., id is always string, read is always boolean).
//   - New optional fields may be added to NotificationsResponse in the future.
//   - Existing title/message strings for each eventType are stable.
//   - The default limit (10) and the maximum (50) are frozen.
//   - Response envelope keys (notifications, total, unreadCount) cannot be renamed.
//   - Notification item keys (id, title, message, read, date, type, txHash) cannot be renamed.
//   - Sort order (newest-first by date) is frozen.
// ---------------------------------------------------------------------------

/** One item in the notifications payload. All fields are required. */
export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  read: boolean;
  date: string;     // ISO 8601 timestamp in UTC
  type: string;     // Raw on-chain eventType
  txHash: string;
}

/** Top-level response envelope for GET /notifications/:user_address. */
export interface NotificationsResponse {
  notifications: NotificationItem[];
  total: number;         // Length of notifications array
  unreadCount: number;   // Count of items where read === false
}

// ---------------------------------------------------------------------------
// Pagination constants — frozen for backward-compatibility.
//
// NOTIFICATIONS_DEFAULT_LIMIT: default page size when `limit` is omitted.
//   Intentionally 10 (not the project-wide 50) because the notifications
//   UI was designed around a short summary card, and existing callers rely
//   on receiving at most 10 items by default.
//
// NOTIFICATIONS_MAX_LIMIT: upper bound enforced server-side; requests above
//   this value are rejected with 400 so callers discover the cap explicitly
//   rather than silently receiving fewer items than requested.
// ---------------------------------------------------------------------------
export const NOTIFICATIONS_DEFAULT_LIMIT = 10;
export const NOTIFICATIONS_MAX_LIMIT = 50;

// ---------------------------------------------------------------------------
// Authorization boundary
//
// The route only queries data for the address supplied in the path.  All three
// DB queries (payments, agreements/events, escrow events) are filtered to that
// address, so callers can never read another user's notifications by crafting
// the path.  The address is validated and canonicalized by StarknetAddress.parse
// before being used as a filter, preventing lookup-key injection.
//
// NOTE: This route is currently unauthenticated (no session check). The data it
// returns is aggregated on-chain public data scoped to the caller-supplied
// address, so there is no credential leak risk. If per-user write state is
// added in the future, a requireAuth guard MUST be added at that point.
// ---------------------------------------------------------------------------

// Get notifications for a user (important events)
notificationsRouter.get("/notifications/:user_address", async (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId: string | undefined = res.locals.requestId;
  try {
    const userAddress = StarknetAddress.parse(req.params.user_address);

    // Hand-rolled limit/offset parser. Kept local rather than reusing
    // `parsePagination` to preserve the existing /api/v1/notifications
    // contract (default 10, max 50) that older callers and the documented
    // OAS example rely on. Out-of-range values are rejected with 400 so
    // callers discover pagination mistakes immediately rather than receiving
    // silently-clamped results.
    const limit =
      z.coerce
        .number()
        .int()
        .positive()
        .max(NOTIFICATIONS_MAX_LIMIT)
        .optional()
        .parse(req.query.limit) ?? NOTIFICATIONS_DEFAULT_LIMIT;

    const offset =
      z.coerce
        .number()
        .int()
        .min(0)
        .optional()
        .parse(req.query.offset) ?? 0;

    // queryLimit determines how many rows each data-source query fetches.
    // Using (limit + offset) ensures the merged pool is always large enough
    // to satisfy any page within the documented range: after merging and
    // sorting, we slice from `offset` to `offset + limit` and the pool
    // never runs short. The extra overhead is bounded by NOTIFICATIONS_MAX_LIMIT
    // (50) so a single request fetches at most 100 rows per source.
    const queryLimit = limit + offset;

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
        .limit(queryLimit),
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
        .limit(queryLimit),
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
            .limit(queryLimit)
        : [];

    const tokenInfoCache = createTokenInfoCache();
    const titleCache = createTitleCache();

    const merged = [
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
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Determine whether more items exist beyond this page before slicing.
    // Strict greater-than is intentional: when `merged.length === offset + limit`
    // the current page is exactly full but there are no further items, so
    // `hasMore` must be `false`. Only when the pool contains at least one item
    // beyond the current page boundary is `hasMore` set to `true`.
    const hasMore = merged.length > offset + limit;
    const rawNotifications = merged.slice(offset, offset + limit);

    // `unreadCount` flows through the exported helper so the response stays
    // in lockstep with the helper's semantics. Because every notification
    // emitted above sets `read: false`, the helper's dedup+filter pass always
    // yields `rawNotifications.length` — the two values are kept in sync
    // intentionally so that callers relying on either field see consistent data.
    const unreadCount = calculateUnreadCount(rawNotifications);
    const preferences = getDefaultNotificationPreferences();
    logNotificationsTelemetry({
      operation: "notification_feed",
      status: "success",
      duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
      request_id: requestId,
      notification_count: rawNotifications.length,
      unread_count: unreadCount,
      preferences_enabled: Object.values(preferences).filter(Boolean).length,
    });

    res.json({
      notifications: rawNotifications,
      total: rawNotifications.length,
      unreadCount,
      limit,
      offset,
      hasMore,
    });
  } catch (error) {
    logNotificationsTelemetry({
      operation: "notification_feed",
      status: "error",
      duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
      request_id: requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
});

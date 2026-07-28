/**
 * Billing Profile Routes
 *
 * Canonical route surface (all under /api/v1):
 *
 *   GET  /billing/profiles/:profileId                       – full profile
 *   GET  /billing/profiles/:profileId/general-information   – identity fields
 *   GET  /billing/profiles/:profileId/payment-methods       – payment methods
 *   GET  /billing/profiles/:profileId/invoices              – invoice list
 *   GET  /billing/profiles/:profileId/summary               – reward-limit summary
 *
 * All routes are gated behind the BILLING_ENABLED feature flag.
 * When the flag is false every endpoint returns HTTP 501 with a clear message.
 *
 * All routes require a valid session (see src/auth/middleware.ts).
 * Every route verifies that the calling wallet address matches the
 * billing profile's ownerAddress before returning any data. A 404 is
 * always returned when the profile does not exist OR the caller is not
 * the owner — the two cases are intentionally indistinguishable to the
 * caller so attackers cannot enumerate billing profile IDs.
 *
 * All responses follow the envelope:  { success: boolean, data?: T, error?: string }
 *
 * NOTE: Sensitive fields (taxId, dateOfBirth) are omitted from all API responses.
 *       They are stored in the database but must only be accessed through
 *       separately-authorised, audited internal processes.
 *
 * OBSERVABILITY: every billing-math decision and every failure path emits one
 *       structured event through `./billing-metrics.js` and bumps a counter
 *       there. See docs/routes/billing.md for the event/metric catalogue.
 *       Log payloads carry profile IDs, bounded reason codes, row counts and
 *       the same rounded monetary aggregates the routes already return —
 *       never taxId, dateOfBirth, or payment credentials.
 */

import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../config.js";
import { requireAuth } from "../auth/middleware.js";
import {
  BILLING_METRICS,
  incBillingMetric,
  logBillingEvent,
  type BillingAmountCoercionReason,
  type BillingEventName,
} from "./billing-metrics.js";

export const billingRouter = express.Router();

// ---------------------------------------------------------------------------
// Safe financial math
// ---------------------------------------------------------------------------

/**
 * Outcome of parsing a single stored `numeric(18,6)` column.
 *
 * `coercion` is `null` when the stored value was usable as-is. Any other
 * value means the database holds something the billing math cannot use, and
 * `0` was substituted — the single most useful signal when a summary or an
 * invoice total looks wrong in production.
 */
export type BillingAmount = {
  amount: number;
  coercion: BillingAmountCoercionReason | null;
};

/**
 * Safely parses a Postgres numeric(18,6) value (returned as a string by
 * Drizzle) into a JavaScript number.  Returns 0 instead of NaN / Infinity
 * when the input is missing, malformed, or negative, and reports which of
 * those three cases fired.  Every arithmetic result is rounded to 6 decimal
 * places to stay lossless within the column's declared scale.
 *
 * The numeric contract is unchanged from the previous `parseSafeAmount`
 * helper; only the coercion reason is new.
 */
export function parseBillingAmount(value: unknown): BillingAmount {
  if (typeof value !== "string" || value.trim() === "") {
    return { amount: 0, coercion: "missing" };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return { amount: 0, coercion: "malformed" };
  if (n < 0) return { amount: 0, coercion: "negative" };
  return { amount: Math.round(n * 1e6) / 1e6, coercion: null };
}

/**
 * Parses a stored amount and, when the value had to be coerced, emits one
 * `billing.amount.coerced` warning naming the offending column.
 *
 * `field` is a hard-coded column name at every call site, never
 * caller-supplied, so log cardinality stays bounded.
 */
function parseBillingAmountWithTelemetry(
  value: unknown,
  field: string,
  context: Record<string, unknown>,
): number {
  const { amount, coercion } = parseBillingAmount(value);
  if (coercion !== null) {
    incBillingMetric(BILLING_METRICS.AMOUNT_COERCED);
    logBillingEvent("warn", "billing.amount.coerced", { ...context, field, reason: coercion });
  }
  return amount;
}

/** Aggregate of one profile's invoice rows, rounded to the column's scale. */
export type InvoiceTotals = {
  invoiceCount: number;
  totalAmount: number;
  paidAmount: number;
  outstandingAmount: number;
  statusCounts: Record<string, number>;
  coercedCount: number;
  /** Per-reason breakdown of the `coercedCount` rows. Only non-zero keys. */
  coercionReasons: Partial<Record<BillingAmountCoercionReason, number>>;
};

/**
 * Rolls up invoice rows into the totals that back the invoice telemetry.
 *
 * An invoice counts toward `paidAmount` when its status is exactly `"paid"`
 * (case-insensitive); everything else — `pending`, `overdue`, `void`, an
 * unrecognised status, or a null status — counts toward `outstandingAmount`,
 * so the two always sum to `totalAmount`. Statuses are lower-cased before
 * being counted; a null/non-string status is bucketed as `"unknown"` rather
 * than widening the key space with arbitrary values.
 *
 * Exported so the arithmetic can be unit-tested without an HTTP round trip.
 * This is a read-side aggregate for telemetry only — it is not written back
 * to the database and does not change any response body.
 */
export function summarizeInvoices(
  rows: readonly { amount?: unknown; status?: unknown }[],
): InvoiceTotals {
  const statusCounts: Record<string, number> = {};
  const coercionReasons: Partial<Record<BillingAmountCoercionReason, number>> = {};
  let totalAmount = 0;
  let paidAmount = 0;
  let coercedCount = 0;

  for (const row of rows) {
    const { amount, coercion } = parseBillingAmount(row.amount);
    if (coercion !== null) {
      coercedCount += 1;
      coercionReasons[coercion] = (coercionReasons[coercion] ?? 0) + 1;
    }

    const status =
      typeof row.status === "string" && row.status.trim() !== ""
        ? row.status.toLowerCase()
        : "unknown";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    totalAmount += amount;
    if (status === "paid") paidAmount += amount;
  }

  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const total = round(totalAmount);
  const paid = round(paidAmount);

  return {
    invoiceCount: rows.length,
    totalAmount: total,
    paidAmount: paid,
    outstandingAmount: round(total - paid),
    statusCounts,
    coercedCount,
    coercionReasons,
  };
}

/**
 * Records a failed billing handler: one `*.failed` event plus the shared
 * `billing_errors_total` counter, so a dashboard can alert on billing errors
 * as a whole and still drill into which route broke.
 *
 * Only `err.message` is logged — a full stack can carry query text and bound
 * parameters, which for this module means profile columns.
 */
function logBillingFailure(
  event: BillingEventName,
  err: unknown,
  context: Record<string, unknown>,
): void {
  incBillingMetric(BILLING_METRICS.ERRORS);
  logBillingEvent("error", event, {
    ...context,
    message: err instanceof Error ? err.message : String(err),
  });
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

/**
 * Default page size when `limit` is not provided by the caller.
 * When omitted entirely the route returns all rows (backward-compatible).
 */
export const DEFAULT_INVOICE_PAGE_LIMIT = 50;

/**
 * Hard upper bound on a single page to prevent runaway queries even with a
 * misconfigured client. Matches the column-scale contract for row counts.
 */
export const MAX_INVOICE_PAGE_LIMIT = 200;

/**
 * Zod schema for the optional pagination query parameters on the invoices
 * endpoint. Both fields are optional so callers who omit them see the
 * original unpaginated behaviour.
 */
const invoicePaginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_INVOICE_PAGE_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

type InvoicePagination = z.infer<typeof invoicePaginationSchema>;

/**
 * Checks whether the caller supplied at least one pagination parameter.
 * When neither is present the invoices endpoint returns all rows with the
 * original response envelope (backward compatible). When either is present
 * the response gains a `pagination` block with `{ limit, offset, hasMore }`.
 */
function hasActivePagination(query: Record<string, unknown>): boolean {
  return "limit" in query || "offset" in query;
}

export type InvoicePaginationMeta = {
  limit: number;
  offset: number;
  hasMore: boolean;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, error: message });
}

const BILLING_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type BillingIdempotencyEntry = {
  createdAt: number;
  expiresAt: number;
  bodyFingerprint: string;
  statusCode: number;
  responseBody: unknown;
};

// NOTE: Billing idempotency is currently backed by an in-process TTL cache.
// If this service is scaled horizontally, this should be moved to a shared store.
const billingIdempotencyStore = new Map<string, BillingIdempotencyEntry>();

function stableSerialize(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return String(value);
}

function getHeader(req: Request, name: string): string | undefined {
  const value = req.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveBillingAccountScope(req: Request): string {
  for (const headerName of ["x-user-address", "x-account-id", "x-user-id"]) {
    const value = getHeader(req, headerName);
    if (value) return value;
  }
  return req.ip ?? "anonymous";
}

function getBillingIdempotencyCacheKey(req: Request, idempotencyKey: string): string {
  const accountScope = resolveBillingAccountScope(req);
  const routeKey = req.originalUrl || req.path || "/";
  const profileId = typeof req.params?.profileId === "string" ? req.params.profileId : "";
  return `billing:${accountScope}:${req.method}:${routeKey}:${profileId}:${idempotencyKey}`;
}

function pruneExpiredEntries(now = Date.now()): void {
  for (const [cacheKey, entry] of billingIdempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      billingIdempotencyStore.delete(cacheKey);
    }
  }
}

export function clearBillingIdempotencyStore(): void {
  billingIdempotencyStore.clear();
}

/**
 * Wrap a mutating billing handler with idempotency support.
 *
 * When an Idempotency-Key header is present, the first successful response for
 * that account/route/body combination is cached for 24 hours. Replays with the
 * same key and body return the cached response; replays with the same key but a
 * different body are rejected with 409 Conflict.
 */
export function withBillingIdempotency(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = getHeader(req, "Idempotency-Key") ?? getHeader(req, "idempotency-key");
    const method = req.method.toUpperCase();

    if (!idempotencyKey || ["GET", "HEAD", "OPTIONS"].includes(method)) {
      await handler(req, res, next);
      return;
    }

    const now = Date.now();
    pruneExpiredEntries(now);

    const cacheKey = getBillingIdempotencyCacheKey(req, idempotencyKey);
    const existingEntry = billingIdempotencyStore.get(cacheKey);

    if (existingEntry && existingEntry.expiresAt > now) {
      // The key itself is caller-supplied, so only its age and the route are
      // logged — never the key or the request body.
      const replayContext = {
        route: req.originalUrl || req.path || "/",
        method,
        keyAgeMs: now - existingEntry.createdAt,
      };

      if (existingEntry.bodyFingerprint !== stableSerialize(req.body)) {
        incBillingMetric(BILLING_METRICS.IDEMPOTENCY_CONFLICT);
        logBillingEvent("warn", "billing.idempotency.conflict", replayContext);
        fail(res, 409, "Idempotency key already used with a different request body");
        return;
      }

      incBillingMetric(BILLING_METRICS.IDEMPOTENCY_REPLAYED);
      logBillingEvent("info", "billing.idempotency.replayed", {
        ...replayContext,
        statusCode: existingEntry.statusCode,
      });
      res.status(existingEntry.statusCode).json(existingEntry.responseBody);
      return;
    }

    if (existingEntry && existingEntry.expiresAt <= now) {
      billingIdempotencyStore.delete(cacheKey);
    }

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let cachedResponse: BillingIdempotencyEntry | undefined;

    const persistResponse = (body: unknown): void => {
      if (cachedResponse) {
        return;
      }
      cachedResponse = {
        createdAt: Date.now(),
        expiresAt: Date.now() + BILLING_IDEMPOTENCY_TTL_MS,
        bodyFingerprint: stableSerialize(req.body),
        statusCode: res.statusCode,
        responseBody: body,
      };
      billingIdempotencyStore.set(cacheKey, cachedResponse);
    };

    res.json = ((body: unknown) => {
      persistResponse(body);
      return originalJson(body);
    }) as typeof res.json;

    res.send = ((body: unknown) => {
      if (!cachedResponse) {
        persistResponse(body);
      }
      return originalSend(body);
    }) as typeof res.send;

    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Zod schema for the `:profileId` path param.
 *
 * Contract:
 * - Must be a non-empty string (min 1 character).
 * - Max 128 characters.
 * - Only alphanumeric characters (`\w`) and dashes (`-`) are allowed.
 * - Rejects slashes, dots, spaces, and other special characters.
 *
 * This is a standalone string schema (not wrapped in `z.object({…})`) so it
 * can be passed directly to `.safeParse(req.params.profileId)` in the
 * {@link validateProfileId} middleware.
 */
const profileIdParamSchema = z
  .string()
  .min(1, "profileId is required")
  .max(128, "profileId must be at most 128 characters")
  .regex(/^[\w\-]+$/, "profileId must be alphanumeric/dash");

/** Convenience object schema for optional programmatic reuse. */
const profileIdSchema = z.object({ profileId: profileIdParamSchema });

/**
 * Middleware: parse + validate the `:profileId` path param.
 *
 * Contract:
 * - On success: attaches the validated string to `res.locals.profileId` and
 *   calls `next()`.
 * - On failure: responds with HTTP 400 and a fixed error message that does
 *   NOT echo the invalid input (preventing injection through error messages).
 *   The Zod schema's detailed error messages are intentionally swallowed —
 *   the caller sees only "Invalid profileId: alphanumeric and dashes only"
 *   regardless of which rule was violated.
 */
function validateProfileId(req: Request, res: Response, next: NextFunction): void {
  const parsed = profileIdParamSchema.safeParse(req.params.profileId);
  if (!parsed.success) {
    return fail(res, 400, "Invalid profileId: alphanumeric and dashes only");
  }
  res.locals.profileId = parsed.data;
  next();
}

function requireBillingEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!env.BILLING_ENABLED) {
    return fail(res, 501, "Billing is not yet enabled.");
  }
  next();
}

/**
 * Middleware: verify the caller owns the billing profile identified by
 * `:profileId` (already validated and attached to `res.locals.profileId`).
 *
 * Contract:
 * - Queries the database for a billing profile with the given ID.
 * - If the profile does not exist OR the caller is not the owner, responds
 *   with HTTP 404 and a generic "not found" message. The two cases are
 *   intentionally indistinguishable to the caller so attackers cannot
 *   enumerate billing profile IDs. **The split is visible in logs only**
 *   via the `billing.ownership.denied` event (see billing-metrics.ts).
 * - On success: attaches the full profile row to `res.locals.profile` and
 *   calls `next()`. Route handlers MUST use `res.locals.profile` rather than
 *   querying the database again.
 * - On DB failure: responds with HTTP 500 and does not call `next()`.
 */
async function requireBillingOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  const profileId: string = res.locals.profileId;
  const callerAddress = req.auth!.address;

  try {
    const [row] = await db
      .select()
      .from(schema.billingProfiles)
      .where(eq(schema.billingProfiles.id, profileId))
      .limit(1);

    if (!row || row.ownerAddress !== callerAddress) {
      // The HTTP response is the same 404 either way (see the module header),
      // but the log records which case fired so operators can tell a stale
      // bookmark apart from someone probing other people's profile IDs.
      const reason = row ? "not_owner" : "not_found";
      incBillingMetric(BILLING_METRICS.OWNERSHIP_DENIED);
      incBillingMetric(
        row
          ? BILLING_METRICS.OWNERSHIP_DENIED_NOT_OWNER
          : BILLING_METRICS.OWNERSHIP_DENIED_NOT_FOUND,
      );
      logBillingEvent("warn", "billing.ownership.denied", {
        profileId,
        callerAddress,
        reason,
        route: req.path,
      });
      fail(res, 404, `Billing profile '${profileId}' not found`);
      return;
    }

    res.locals.profile = row;
    next();
  } catch (err: any) {
    logBillingFailure("billing.ownership.failed", err, { profileId, callerAddress });
    fail(res, 500, "Failed to verify billing profile ownership");
  }
}

// Apply the feature-flag gate, authentication, and ownership check to every
// billing route.  validateProfileId must run first so res.locals.profileId is
// available for the ownership lookup.
billingRouter.use("/billing", requireBillingEnabled, requireAuth);

// Mutating billing routes can opt into request replay protection via Idempotency-Key.
billingRouter.use("/billing", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
    next();
    return;
  }

  withBillingIdempotency(async (_req, _res, _next) => {
    next();
  })(req, res, next);
});

type ProfileRow = typeof schema.billingProfiles.$inferSelect;

function stripSensitive(profile: ProfileRow) {
  if (typeof schema.stripSensitiveBillingFields === "function") {
    return schema.stripSensitiveBillingFields(profile);
  }
  const { taxId: _taxId, dateOfBirth: _dob, ...safe } = profile;
  return safe;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/billing/profiles/:profileId
 *
 * Returns the full billing profile (with sensitive fields stripped),
 * payment methods, and invoices in a single response.
 *
 * Contract:
 * - Uses `res.locals.profile` from the `requireBillingOwner` middleware —
 *   does NOT re-query the database for the profile.
 * - Fetches payment methods and invoices in parallel via `Promise.all`.
 * - Strips `taxId` and `dateOfBirth` from the profile before serialisation.
 * - Emits a `billing.profile.fetched` event on success.
 * - Emits a `billing.amount.coerced` warning when invoice amounts are
 *   unusable (matching the behaviour of the `/invoices` route).
 * - On TOCTOU race (profile deleted between middleware and handler):
 *   responds with HTTP 404 without attempting DB queries.
 * - On DB failure: responds with HTTP 500.
 *
 * Response shape (200):
 *   { success: true, data: { profile: ProfileRow, paymentMethods: [], invoices: [] } }
 */
billingRouter.get(
  "/billing/profiles/:profileId",
  validateProfileId,
  requireBillingOwner,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;
    const startedAt = Date.now();

    try {
      const profile = res.locals.profile;

      // Safety net for a TOCTOU race between middleware and handler.
      if (!profile) {
        fail(res, 404, `Billing profile '${profileId}' not found`);
        return;
      }

      const [paymentMethods, invoices] = await Promise.all([
        db
          .select()
          .from(schema.billingPaymentMethods)
          .where(eq(schema.billingPaymentMethods.profileId, profileId)),
        db
          .select()
          .from(schema.billingInvoices)
          .where(eq(schema.billingInvoices.profileId, profileId)),
      ]);

      // Read-side aggregate for telemetry only.
      const totals = summarizeInvoices(invoices);
      const durationMs = Date.now() - startedAt;

      incBillingMetric(BILLING_METRICS.PROFILE_FETCHED);
      incBillingMetric(BILLING_METRICS.PROFILE_DURATION_MS, durationMs);
      if (totals.coercedCount > 0) {
        incBillingMetric(BILLING_METRICS.AMOUNT_COERCED, totals.coercedCount);
        logBillingEvent("warn", "billing.amount.coerced", {
          profileId,
          field: "invoices.amount",
          affectedRows: totals.coercedCount,
          reasons: totals.coercionReasons,
        });
      }

      logBillingEvent("info", "billing.profile.fetched", {
        profileId,
        paymentMethodCount: paymentMethods.length,
        invoiceCount: totals.invoiceCount,
        totalAmount: totals.totalAmount,
        paidAmount: totals.paidAmount,
        outstandingAmount: totals.outstandingAmount,
        coercedCount: totals.coercedCount,
        durationMs,
      });

      ok(res, {
        profile: stripSensitive(profile),
        paymentMethods,
        invoices,
      });
    } catch (err: any) {
      logBillingFailure("billing.profile.failed", err, {
        profileId,
        durationMs: Date.now() - startedAt,
      });
      fail(res, 500, "Failed to fetch billing profile");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/general-information
 *
 * Returns identity / contact fields for the profile.
 * Sensitive fields (taxId, dateOfBirth) are excluded.
 *
 * Contract:
 * - Uses `res.locals.profile` from the middleware — does NOT re-query the DB.
 * - Strips `taxId` and `dateOfBirth` via {@link stripSensitive}.
 * - Computes a convenience `fullAddress` string from non-null address
 *   components (street, city, state, zipCode, country). Returns `null` when
 *   every component is falsy.
 * - On TOCTOU race (profile deleted between middleware and handler):
 *   responds with HTTP 404.
 * - On DB failure: responds with HTTP 500.
 *
 * Response shape (200):
 *   { success: true, data: { id, firstName, …, fullAddress } }
 */
billingRouter.get(
  "/billing/profiles/:profileId/general-information",
  validateProfileId,
  requireBillingOwner,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;

    try {
      const profile = res.locals.profile;

      if (!profile) {
        fail(res, 404, `Billing profile '${profileId}' not found`);
        return;
      }

      const safe = stripSensitive(profile);

      // Compute a convenience fullAddress for UI display
      const addrParts = [safe.street, safe.city, safe.state, safe.zipCode, safe.country].filter(
        Boolean,
      );
      const fullAddress = addrParts.length ? addrParts.join(", ") : null;

      incBillingMetric(BILLING_METRICS.GENERAL_INFORMATION_FETCHED);
      logBillingEvent("info", "billing.general_information.fetched", {
        profileId,
        // How many of the five address components were populated; enough to
        // explain a null fullAddress without logging the address itself.
        addressComponentCount: addrParts.length,
      });

      ok(res, { ...safe, fullAddress });
    } catch (err: any) {
      logBillingFailure("billing.general_information.failed", err, { profileId });
      fail(res, 500, "Failed to fetch general information");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/payment-methods
 *
 * Returns the list of payment methods for the profile.
 * Only masked/safe representations are stored and returned (no raw account numbers).
 *
 * Contract:
 * - Queries the `billingPaymentMethods` table filtered by `profileId`.
 * - Returns an empty array when no payment methods exist (never `null`).
 * - The response includes `profileId` for caller convenience.
 * - On DB failure: responds with HTTP 500.
 *
 * Response shape (200):
 *   { success: true, data: { profileId, paymentMethods: [] } }
 */
billingRouter.get(
  "/billing/profiles/:profileId/payment-methods",
  validateProfileId,
  requireBillingOwner,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;

    try {
      const paymentMethods = await db
        .select()
        .from(schema.billingPaymentMethods)
        .where(eq(schema.billingPaymentMethods.profileId, profileId));

      incBillingMetric(BILLING_METRICS.PAYMENT_METHODS_LISTED);
      logBillingEvent("info", "billing.payment_methods.listed", {
        profileId,
        paymentMethodCount: paymentMethods.length,
      });

      ok(res, { profileId, paymentMethods });
    } catch (err: any) {
      logBillingFailure("billing.payment_methods.failed", err, { profileId });
      fail(res, 500, "Failed to fetch payment methods");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/invoices
 *
 * Returns the invoice history for the profile. Every invoice row is parsed
 * through the safe `parseBillingAmount` helper so malformed amounts never
 * propagate NaN into the aggregate telemetry.
 *
 * Supports optional pagination via `limit` and `offset` query parameters.
 * When both are omitted the response envelope is unchanged (backward-compatible).
 *
 * Contract:
 * - Queries the `billingInvoices` table filtered by `profileId`.
 * - The response body contains the raw rows unchanged — existing callers see
 *   exactly the same shape as before observability was added.
 * - A read-side aggregate (`summarizeInvoices`) is computed for telemetry
 *   only and is NOT written back to the database or returned in the response.
 * - When invoice amounts are unusable (missing, malformed, or negative):
 *   one `billing.amount.coerced` warning is emitted with a per-reason
 *   breakdown, and the `billing_amount_coerced_total` counter is bumped.
 * - The aggregate normalises invoice statuses to lowercase; unrecognised or
 *   null statuses are bucketed as `"unknown"` rather than widening the log
 *   key space with arbitrary values.
 * - Hardened to validate every invoice row.
 * - On DB failure: responds with HTTP 500.
 *
 * Response shape (200):
 *   { success: true, data: { profileId, invoices: [] } }
 */
billingRouter.get(
  "/billing/profiles/:profileId/invoices",
  validateProfileId,
  requireBillingOwner,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;
    const startedAt = Date.now();

    // Parse optional pagination params (fail-fast on malformed values).
    const parsedQuery = invoicePaginationSchema.safeParse(req.query);
    if (!parsedQuery.success) {
      fail(res, 400, "Invalid pagination parameters: limit must be 1–200, offset must be 0 or greater");
      return;
    }
    const { limit, offset } = parsedQuery.data;
    const activePagination = hasActivePagination(req.query);

    try {
      // Fetch with deterministic ordering. In the paginated case we ask for
      // one extra row so we can compute hasMore without a second COUNT query.
      const fetchLimit = limit !== undefined ? limit + 1 : undefined;
      let query = db
        .select()
        .from(schema.billingInvoices)
        .where(eq(schema.billingInvoices.profileId, profileId))
        .orderBy(desc(schema.billingInvoices.createdAt), desc(schema.billingInvoices.id));

      if (fetchLimit !== undefined) {
        query = query.limit(fetchLimit);
      }
      if (offset !== undefined && offset > 0) {
        query = query.offset(offset);
      }

      const fetchedRows = await query;

      // Slice the extra probe row away when paginating.
      const hasMore = limit !== undefined && fetchedRows.length > limit;
      const invoices = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;

      // Read-side aggregate for telemetry only — the response body is
      // unchanged for non-paginated callers.
      const totals = summarizeInvoices(invoices);
      const durationMs = Date.now() - startedAt;

      incBillingMetric(BILLING_METRICS.INVOICES_LISTED);
      incBillingMetric(BILLING_METRICS.INVOICE_ROWS, totals.invoiceCount);
      incBillingMetric(BILLING_METRICS.INVOICES_DURATION_MS, durationMs);
      if (totals.coercedCount > 0) {
        incBillingMetric(BILLING_METRICS.AMOUNT_COERCED, totals.coercedCount);
        logBillingEvent("warn", "billing.amount.coerced", {
          profileId,
          field: "invoices.amount",
          affectedRows: totals.coercedCount,
          reasons: totals.coercionReasons,
        });
      }

      logBillingEvent("info", "billing.invoices.listed", {
        profileId,
        invoiceCount: totals.invoiceCount,
        totalAmount: totals.totalAmount,
        paidAmount: totals.paidAmount,
        outstandingAmount: totals.outstandingAmount,
        statusCounts: totals.statusCounts,
        coercedCount: totals.coercedCount,
        durationMs,
        ...(activePagination ? { pageLimit: limit ?? DEFAULT_INVOICE_PAGE_LIMIT, pageOffset: offset ?? 0, hasMore } : {}),
      });

      const data: Record<string, unknown> = { profileId, invoices };
      if (activePagination) {
        data.pagination = {
          limit: limit ?? DEFAULT_INVOICE_PAGE_LIMIT,
          offset: offset ?? 0,
          hasMore,
        };
      }
      ok(res, data);
    } catch (err: any) {
      logBillingFailure("billing.invoices.failed", err, {
        profileId,
        durationMs: Date.now() - startedAt,
      });
      fail(res, 500, "Failed to fetch invoices");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/summary
 *
 * Returns the reward-limit / spend summary computed from the profile's
 * `annualRewardLimit` and `usedAmount` columns.
 *
 * Math contract:
 * - `limit` = `parseBillingAmountWithTelemetry(profile.annualRewardLimit,
 *   "annualRewardLimit", …)` — coerces missing/malformed/negative to 0
 *   and emits a `billing.amount.coerced` warning.
 * - `used` = `parseBillingAmountWithTelemetry(profile.usedAmount,
 *   "usedAmount", …)` — same coercion as above.
 * - `remainingAmount` = `max(0, limit - used)` — clamped to zero so overruns
 *   never produce a negative remainder. When `used > limit`, a
 *   `billing.summary.limit_exceeded` warning is emitted separately.
 * - `progressPercentage` = `(used / limit) × 100` when `limit > 0`; `0` when
 *   `limit === 0`. Rounded to 2 decimal places. NOT clamped to 100% — a
 *   profile that exceeds its limit correctly reports > 100% progress.
 * - All intermediate arithmetic is rounded to 6 decimal places to stay
 *   lossless within the column's declared `numeric(18,6)` scale.
 *
 * Contract:
 * - Uses `res.locals.profile` from the middleware — does NOT re-query the DB.
 * - Each coerced column emits its own `billing.amount.coerced` event naming
 *   the offending field, so operators can pinpoint which column is corrupt.
 * - On TOCTOU race (profile deleted between middleware and handler):
 *   responds with HTTP 404.
 * - On DB failure: responds with HTTP 500.
 *
 * Response shape (200):
 *   { success: true, data: { profileId, profileType, annualRewardLimit,
 *     usedAmount, remainingAmount, currency, progressPercentage } }
 */
billingRouter.get(
  "/billing/profiles/:profileId/summary",
  validateProfileId,
  requireBillingOwner,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;
    const startedAt = Date.now();

    try {
      const profile = res.locals.profile;

      if (!profile) {
        fail(res, 404, `Billing profile '${profileId}' not found`);
        return;
      }

      // Use safe parsing to avoid NaN / Infinity from malformed or
      // excessively large numeric strings. Each coercion emits its own
      // warning naming the column that had to be substituted.
      const limit = parseBillingAmountWithTelemetry(
        profile.annualRewardLimit,
        "annualRewardLimit",
        {
          profileId,
        },
      );
      const used = parseBillingAmountWithTelemetry(profile.usedAmount, "usedAmount", { profileId });
      // Clamp remaining to a minimum of 0 to avoid negative values
      // when usedAmount has overrun the limit in the database.
      const remaining = Math.max(0, limit - used);
      const progressPct = limit > 0 ? (used / limit) * 100 : 0;
      const progressPercentage = Math.round(progressPct * 100) / 100;
      const durationMs = Date.now() - startedAt;

      // The clamp above hides an overrun from the response. Surface it here
      // so a mis-metered profile is visible before a customer reports it.
      if (used > limit) {
        incBillingMetric(BILLING_METRICS.SUMMARY_LIMIT_EXCEEDED);
        logBillingEvent("warn", "billing.summary.limit_exceeded", {
          profileId,
          annualRewardLimit: limit,
          usedAmount: used,
          overageAmount: Math.round((used - limit) * 1e6) / 1e6,
          currency: profile.currency,
        });
      }

      incBillingMetric(BILLING_METRICS.SUMMARY_COMPUTED);
      incBillingMetric(BILLING_METRICS.SUMMARY_DURATION_MS, durationMs);
      logBillingEvent("info", "billing.summary.computed", {
        profileId,
        annualRewardLimit: limit,
        usedAmount: used,
        remainingAmount: remaining,
        progressPercentage,
        currency: profile.currency,
        durationMs,
      });

      ok(res, {
        profileId: profile.id,
        profileType: profile.profileType,
        annualRewardLimit: limit,
        usedAmount: used,
        remainingAmount: remaining,
        currency: profile.currency,
        progressPercentage,
      });
    } catch (err: any) {
      logBillingFailure("billing.summary.failed", err, {
        profileId,
        durationMs: Date.now() - startedAt,
      });
      fail(res, 500, "Failed to fetch billing summary");
    }
  },
);

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
 */

import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../config.js";
import { requireAuth } from "../auth/middleware.js";

export const billingRouter = express.Router();

// ---------------------------------------------------------------------------
// Safe financial math
// ---------------------------------------------------------------------------

/**
 * Safely parses a Postgres numeric(18,6) value (returned as a string by
 * Drizzle) into a JavaScript number.  Returns 0 instead of NaN / Infinity
 * when the input is missing, malformed, or negative.  Every arithmetic
 * result is rounded to 6 decimal places to stay lossless within the
 * column's declared scale.
 */
function parseSafeAmount(value: unknown): number {
  if (typeof value !== "string" || value.trim() === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Uniform success envelope */
function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

/** Uniform error envelope */
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
      if (existingEntry.bodyFingerprint !== stableSerialize(req.body)) {
        fail(res, 409, "Idempotency key already used with a different request body");
        return;
      }

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

/** Zod schema for the :profileId path param – non-empty string, max 128 chars */
const profileIdSchema = z.object({
  profileId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w\-]+$/, "profileId must be alphanumeric/dash"),
});

/** Middleware: parse + validate :profileId, attach to res.locals */
function validateProfileId(req: Request, res: Response, next: NextFunction): void {
  const parsed = profileIdSchema.safeParse(req.params);
  if (!parsed.success) {
    fail(res, 400, "Invalid profileId: " + parsed.error.issues.map((i) => i.message).join(", "));
    return;
  }
  res.locals.profileId = parsed.data.profileId;
  next();
}

/** Middleware: gate all billing routes behind the BILLING_ENABLED flag */
function requireBillingEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!env.BILLING_ENABLED) {
    fail(
      res,
      501,
      "Billing is not yet enabled on this instance. Set BILLING_ENABLED=true to activate.",
    );
    return;
  }
  next();
}

/** Middleware: verify the caller owns the billing profile identified by :profileId */
async function requireBillingOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const profileId: string = res.locals.profileId;
  const callerAddress = req.auth!.address;

  try {
    const [row] = await db
      .select()
      .from(schema.billingProfiles)
      .where(eq(schema.billingProfiles.id, profileId))
      .limit(1);

    if (!row || row.ownerAddress !== callerAddress) {
      fail(res, 404, `Billing profile '${profileId}' not found`);
      return;
    }

    res.locals.profile = row;
    next();
  } catch (err: any) {
    console.error("[billing] Error in ownership check:", err);
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

// ---------------------------------------------------------------------------
// Strip sensitive fields before returning a profile row to the client.
// taxId and dateOfBirth are never included in API responses.
// ---------------------------------------------------------------------------
type ProfileRow = typeof schema.billingProfiles.$inferSelect;
type SafeProfile = Omit<ProfileRow, "taxId" | "dateOfBirth">;

function stripSensitive(profile: ProfileRow): SafeProfile {
  // Destructure to drop the sensitive fields; the rest is safe to return.
  const { taxId: _taxId, dateOfBirth: _dob, ...safe } = profile;
  return safe;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/billing/profiles/:profileId
 *
 * Returns the full billing profile (general info + payment methods + invoices)
 * in a single response for clients that need everything at once.
 */
billingRouter.get(
  "/billing/profiles/:profileId",
  validateProfileId,
  requireBillingOwner,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;

    try {
      const profile = res.locals.profile;

      // Ownership already verified by requireBillingOwner; this is a
      // safety net for a very unlikely TOCTOU race (profile deleted
      // between middleware and handler).
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

      ok(res, {
        profile: stripSensitive(profile),
        paymentMethods,
        invoices,
      });
    } catch (err: any) {
      console.error("[billing] Error fetching full profile:", err);
      fail(res, 500, "Failed to fetch billing profile");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/general-information
 *
 * Returns identity / contact fields for the profile.
 * Sensitive fields (taxId, dateOfBirth) are excluded.
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

      ok(res, { ...safe, fullAddress });
    } catch (err: any) {
      console.error("[billing] Error fetching general information:", err);
      fail(res, 500, "Failed to fetch general information");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/payment-methods
 *
 * Returns the list of payment methods for the profile.
 * Only masked/safe representations are stored and returned (no raw account numbers).
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

      ok(res, { profileId, paymentMethods });
    } catch (err: any) {
      console.error("[billing] Error fetching payment methods:", err);
      fail(res, 500, "Failed to fetch payment methods");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/invoices
 *
 * Returns the invoice history for the profile.
 */
billingRouter.get(
  "/billing/profiles/:profileId/invoices",
  validateProfileId,
  requireBillingOwner,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;

    try {
      const invoices = await db
        .select()
        .from(schema.billingInvoices)
        .where(eq(schema.billingInvoices.profileId, profileId));

      ok(res, { profileId, invoices });
    } catch (err: any) {
      console.error("[billing] Error fetching invoices:", err);
      fail(res, 500, "Failed to fetch invoices");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/summary
 *
 * Returns the reward-limit / spend summary for the profile.
 */
billingRouter.get(
  "/billing/profiles/:profileId/summary",
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

      // Use safe parsing to avoid NaN / Infinity from malformed or
      // excessively large numeric strings.
      const limit = parseSafeAmount(profile.annualRewardLimit);
      const used = parseSafeAmount(profile.usedAmount);
      // Clamp remaining to a minimum of 0 to avoid negative values
      // when usedAmount has overrun the limit in the database.
      const remaining = Math.max(0, limit - used);
      const progressPct = limit > 0 ? (used / limit) * 100 : 0;

      ok(res, {
        profileId: profile.id,
        profileType: profile.profileType,
        annualRewardLimit: limit,
        usedAmount: used,
        remainingAmount: remaining,
        currency: profile.currency,
        progressPercentage: Math.round(progressPct * 100) / 100,
      });
    } catch (err: any) {
      console.error("[billing] Error fetching billing summary:", err);
      fail(res, 500, "Failed to fetch billing summary");
    }
  },
);

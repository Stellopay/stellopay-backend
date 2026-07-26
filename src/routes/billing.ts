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
 * All responses follow the envelope:  { success: boolean, data?: T, error?: string }
 *
 * Backward-compatibility contract (issue #304)
 * ─────────────────────────────────────────────
 * • Response envelope shape is frozen: { success, data? } on success,
 *   { success, error } on failure.  Neither key may be present on the wrong
 *   branch.  See docs/routes/billing.md for the full contract.
 *
 * • profileId validation: alphanumeric + dash/underscore, 1–128 chars.
 *   Violations → 400.  Shape must not change without a major-version bump.
 *
 * • Sensitive fields (taxId, dateOfBirth) are stripped by stripSensitive()
 *   before any profile row reaches a handler response.  This invariant is
 *   enforced by tests and must be preserved by all future changes.
 *
 * • Billing math (summary endpoint):
 *     remainingAmount    = Math.max(0, limit − used)   // never negative
 *     progressPercentage = limit > 0 ? round2(used/limit*100) : 0
 *   These formulas are load-bearing; do not change them without updating
 *   docs/routes/billing.md and the corresponding tests.
 *
 * • fullAddress (general-information endpoint):
 *     [street, city, state, zipCode, country].filter(Boolean).join(", ")
 *     null when every part is absent.
 *   Order and separator must not change — callers display this string directly.
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

export const billingRouter = express.Router();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Uniform success envelope — shape is frozen per #304 contract. */
function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

/** Uniform error envelope — shape is frozen per #304 contract. */
function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, error: message });
}

/**
 * Zod schema for the :profileId path param.
 * Contract: non-empty string, max 128 chars, characters [A-Za-z0-9_-] only.
 * Frozen — changing this regex is a breaking change for existing callers.
 */
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

// Apply the feature-flag gate to every route in this router
billingRouter.use("/billing", requireBillingEnabled);

// ---------------------------------------------------------------------------
// Sensitive-field stripping
// Strip taxId and dateOfBirth before returning a profile row to the client.
// These fields are stored in the DB but must never appear in API responses.
// This function is the single enforcement point — do not bypass it.
// ---------------------------------------------------------------------------
type ProfileRow = typeof schema.billingProfiles.$inferSelect;
type SafeProfile = Omit<ProfileRow, "taxId" | "dateOfBirth">;

function stripSensitive(profile: ProfileRow): SafeProfile {
  const { taxId: _taxId, dateOfBirth: _dob, ...safe } = profile;
  return safe;
}

// ---------------------------------------------------------------------------
// Billing math helpers (issue #304 — stable contract)
// ---------------------------------------------------------------------------

/**
 * Compute the reward-limit summary fields from raw DB numeric strings.
 *
 * Contract (frozen):
 *   remainingAmount    = Math.max(0, limit − used)
 *   progressPercentage = limit > 0 ? round2(used / limit * 100) : 0
 *
 * progressPercentage may exceed 100 when used > limit — callers clamp for display.
 */
export function computeBillingSummary(
  annualRewardLimit: string | null,
  usedAmount: string | null,
): { limit: number; used: number; remainingAmount: number; progressPercentage: number } {
  const limit = parseFloat(annualRewardLimit ?? "0");
  const used = parseFloat(usedAmount ?? "0");
  const remainingAmount = Math.max(0, limit - used);
  const progressPct = limit > 0 ? (used / limit) * 100 : 0;
  const progressPercentage = Math.round(progressPct * 100) / 100;
  return { limit, used, remainingAmount, progressPercentage };
}

/**
 * Build the fullAddress convenience string for general-information responses.
 *
 * Contract (frozen — callers display this string directly):
 *   [street, city, state, zipCode, country].filter(Boolean).join(", ")
 *   Returns null when every part is absent.
 */
export function buildFullAddress(
  street: string | null,
  city: string | null,
  state: string | null,
  zipCode: string | null,
  country: string | null,
): string | null {
  const parts = [street, city, state, zipCode, country].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/billing/profiles/:profileId
 *
 * Returns the full billing profile (general info + payment methods + invoices)
 * in a single response for clients that need everything at once.
 *
 * Success 200: { profile: SafeProfile, paymentMethods: [], invoices: [] }
 * Error  404: profile not found
 * Error  500: unexpected db error (internal detail never leaked)
 * Error  501: BILLING_ENABLED=false
 */
billingRouter.get(
  "/billing/profiles/:profileId",
  validateProfileId,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;

    try {
      const [profile] = await db
        .select()
        .from(schema.billingProfiles)
        .where(eq(schema.billingProfiles.id, profileId))
        .limit(1);

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
    } catch (err: unknown) {
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
 *
 * Adds a computed `fullAddress` field:
 *   [street, city, state, zipCode, country].filter(Boolean).join(", ")
 *   null when every address part is absent.
 *
 * The fullAddress format is stable — existing callers render it directly.
 */
billingRouter.get(
  "/billing/profiles/:profileId/general-information",
  validateProfileId,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;

    try {
      const [profile] = await db
        .select()
        .from(schema.billingProfiles)
        .where(eq(schema.billingProfiles.id, profileId))
        .limit(1);

      if (!profile) {
        fail(res, 404, `Billing profile '${profileId}' not found`);
        return;
      }

      const safe = stripSensitive(profile);
      const fullAddress = buildFullAddress(
        safe.street,
        safe.city,
        safe.state,
        safe.zipCode,
        safe.country,
      );

      ok(res, { ...safe, fullAddress });
    } catch (err: unknown) {
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
 *
 * Returns an empty paymentMethods array (not an error) when the profile exists
 * but has no methods attached.
 */
billingRouter.get(
  "/billing/profiles/:profileId/payment-methods",
  validateProfileId,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;

    try {
      // Verify the profile exists first to give a meaningful 404
      const [profile] = await db
        .select({ id: schema.billingProfiles.id })
        .from(schema.billingProfiles)
        .where(eq(schema.billingProfiles.id, profileId))
        .limit(1);

      if (!profile) {
        fail(res, 404, `Billing profile '${profileId}' not found`);
        return;
      }

      const paymentMethods = await db
        .select()
        .from(schema.billingPaymentMethods)
        .where(eq(schema.billingPaymentMethods.profileId, profileId));

      ok(res, { profileId, paymentMethods });
    } catch (err: unknown) {
      console.error("[billing] Error fetching payment methods:", err);
      fail(res, 500, "Failed to fetch payment methods");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/invoices
 *
 * Returns the invoice history for the profile.
 *
 * invoice.amount is the raw numeric string from the DB (precision 18, scale 6).
 * Callers are responsible for display formatting.
 *
 * Valid status values: pending | paid | void  (closed set — adding a new value
 * requires a migration and a note in docs/routes/billing.md).
 */
billingRouter.get(
  "/billing/profiles/:profileId/invoices",
  validateProfileId,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;

    try {
      const [profile] = await db
        .select({ id: schema.billingProfiles.id })
        .from(schema.billingProfiles)
        .where(eq(schema.billingProfiles.id, profileId))
        .limit(1);

      if (!profile) {
        fail(res, 404, `Billing profile '${profileId}' not found`);
        return;
      }

      const invoices = await db
        .select()
        .from(schema.billingInvoices)
        .where(eq(schema.billingInvoices.profileId, profileId));

      ok(res, { profileId, invoices });
    } catch (err: unknown) {
      console.error("[billing] Error fetching invoices:", err);
      fail(res, 500, "Failed to fetch invoices");
    }
  },
);

/**
 * GET /api/v1/billing/profiles/:profileId/summary
 *
 * Returns the reward-limit / spend summary for the profile.
 * This endpoint drives progress-bar UI and billing gate checks — its math is
 * load-bearing.  See computeBillingSummary() for the frozen formula.
 *
 * Note: progressPercentage can exceed 100 when usedAmount > annualRewardLimit.
 * This is intentional — callers should clamp the display value themselves.
 */
billingRouter.get(
  "/billing/profiles/:profileId/summary",
  validateProfileId,
  async (req: Request, res: Response) => {
    const profileId: string = res.locals.profileId;

    try {
      const [profile] = await db
        .select({
          id: schema.billingProfiles.id,
          profileType: schema.billingProfiles.profileType,
          annualRewardLimit: schema.billingProfiles.annualRewardLimit,
          usedAmount: schema.billingProfiles.usedAmount,
          currency: schema.billingProfiles.currency,
        })
        .from(schema.billingProfiles)
        .where(eq(schema.billingProfiles.id, profileId))
        .limit(1);

      if (!profile) {
        fail(res, 404, `Billing profile '${profileId}' not found`);
        return;
      }

      const { limit, used, remainingAmount, progressPercentage } = computeBillingSummary(
        profile.annualRewardLimit,
        profile.usedAmount,
      );

      ok(res, {
        profileId: profile.id,
        profileType: profile.profileType,
        annualRewardLimit: limit,
        usedAmount: used,
        remainingAmount,
        currency: profile.currency,
        progressPercentage,
      });
    } catch (err: unknown) {
      console.error("[billing] Error fetching billing summary:", err);
      fail(res, 500, "Failed to fetch billing summary");
    }
  },
);

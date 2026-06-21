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

/** Uniform success envelope */
function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

/** Uniform error envelope */
function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, error: message });
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

// Apply the feature-flag gate to every route in this router
billingRouter.use("/billing", requireBillingEnabled);

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

      const limit = parseFloat(profile.annualRewardLimit ?? "0");
      const used = parseFloat(profile.usedAmount ?? "0");
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

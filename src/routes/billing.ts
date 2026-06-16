import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../config.js";

export const billingRouter = Router();

function billingDisabled(res: any) {
  res.status(503).json({ error: "Billing is not enabled on this instance" });
}

const WalletParam = z.object({ walletAddress: z.string().min(3) });

const GeneralInfoBody = z.object({
  profileType: z.enum(["Individual", "Business"]).optional(),
  currency: z.string().length(3).optional(),
  annualRewardLimit: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().email().max(254).optional(),
  phone: z.string().max(30).optional(),
  street: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  zipCode: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
  taxId: z.string().max(50).optional(),
  taxResidency: z.string().max(100).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  companyName: z.string().max(200).optional(),
  vatNumber: z.string().max(50).optional(),
  businessType: z.string().max(100).optional(),
  occupation: z.string().max(100).optional(),
  website: z.string().url().max(300).optional().or(z.literal("")),
  notes: z.string().max(2000).optional(),
});

const PaymentMethodBody = z.object({
  type: z.enum(["bank_account", "paypal", "crypto"]),
  metadata: z.record(z.string()).refine(
    (m) => typeof m === "object" && Object.keys(m).length <= 20,
    "metadata must be a flat string record"
  ),
  isDefault: z.boolean().optional().default(false),
});

// GET /api/v1/billing/profile/:walletAddress
billingRouter.get("/billing/profile/:walletAddress", async (req, res, next) => {
  if (!env.BILLING_ENABLED) return billingDisabled(res);
  try {
    const { walletAddress } = WalletParam.parse(req.params);
    const profile = await db
      .select()
      .from(schema.billingProfiles)
      .where(eq(schema.billingProfiles.walletAddress, walletAddress.toLowerCase()))
      .limit(1);

    if (!profile[0]) {
      res.status(404).json({ error: "Billing profile not found" });
      return;
    }

    const methods = await db
      .select()
      .from(schema.billingPaymentMethods)
      .where(eq(schema.billingPaymentMethods.profileId, profile[0].id));

    const invoices = await db
      .select()
      .from(schema.billingInvoices)
      .where(eq(schema.billingInvoices.profileId, profile[0].id));

    res.json({
      success: true,
      data: {
        ...profile[0],
        paymentMethods: methods.map((m) => ({ ...m, metadata: JSON.parse(m.metadata) })),
        invoices,
      },
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/billing/profile
billingRouter.post("/billing/profile", async (req, res, next) => {
  if (!env.BILLING_ENABLED) return billingDisabled(res);
  try {
    const body = z
      .object({ walletAddress: z.string().min(3) })
      .merge(GeneralInfoBody)
      .parse(req.body);

    const { walletAddress, ...fields } = body;
    const addr = walletAddress.toLowerCase();

    const existing = await db
      .select({ id: schema.billingProfiles.id })
      .from(schema.billingProfiles)
      .where(eq(schema.billingProfiles.walletAddress, addr))
      .limit(1);

    if (existing[0]) {
      res.status(409).json({ error: "Billing profile already exists for this wallet" });
      return;
    }

    const id = crypto.randomUUID();
    const [created] = await db
      .insert(schema.billingProfiles)
      .values({ id, walletAddress: addr, ...fields })
      .returning();

    res.status(201).json({ success: true, data: created });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/v1/billing/profile/:walletAddress/general-information
billingRouter.patch("/billing/profile/:walletAddress/general-information", async (req, res, next) => {
  if (!env.BILLING_ENABLED) return billingDisabled(res);
  try {
    const { walletAddress } = WalletParam.parse(req.params);
    const fields = GeneralInfoBody.parse(req.body);

    if (Object.keys(fields).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [updated] = await db
      .update(schema.billingProfiles)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(schema.billingProfiles.walletAddress, walletAddress.toLowerCase()))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Billing profile not found" });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/billing/profile/:walletAddress/summary
billingRouter.get("/billing/profile/:walletAddress/summary", async (req, res, next) => {
  if (!env.BILLING_ENABLED) return billingDisabled(res);
  try {
    const { walletAddress } = WalletParam.parse(req.params);
    const [profile] = await db
      .select()
      .from(schema.billingProfiles)
      .where(eq(schema.billingProfiles.walletAddress, walletAddress.toLowerCase()))
      .limit(1);

    if (!profile) {
      res.status(404).json({ error: "Billing profile not found" });
      return;
    }

    const limit = parseFloat(profile.annualRewardLimit ?? "0");
    const used = parseFloat(profile.usedAmount ?? "0");

    res.json({
      success: true,
      data: {
        profileId: profile.id,
        profileType: profile.profileType,
        annualRewardLimit: limit,
        usedAmount: used,
        remainingAmount: Math.max(0, limit - used),
        currency: profile.currency,
        progressPercentage: limit > 0 ? (used / limit) * 100 : 0,
      },
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/billing/profile/:walletAddress/payment-methods
billingRouter.get("/billing/profile/:walletAddress/payment-methods", async (req, res, next) => {
  if (!env.BILLING_ENABLED) return billingDisabled(res);
  try {
    const { walletAddress } = WalletParam.parse(req.params);
    const [profile] = await db
      .select({ id: schema.billingProfiles.id })
      .from(schema.billingProfiles)
      .where(eq(schema.billingProfiles.walletAddress, walletAddress.toLowerCase()))
      .limit(1);

    if (!profile) {
      res.status(404).json({ error: "Billing profile not found" });
      return;
    }

    const methods = await db
      .select()
      .from(schema.billingPaymentMethods)
      .where(eq(schema.billingPaymentMethods.profileId, profile.id));

    res.json({
      success: true,
      data: methods.map((m) => ({ ...m, metadata: JSON.parse(m.metadata) })),
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/billing/profile/:walletAddress/payment-methods
billingRouter.post("/billing/profile/:walletAddress/payment-methods", async (req, res, next) => {
  if (!env.BILLING_ENABLED) return billingDisabled(res);
  try {
    const { walletAddress } = WalletParam.parse(req.params);
    const body = PaymentMethodBody.parse(req.body);

    const [profile] = await db
      .select({ id: schema.billingProfiles.id })
      .from(schema.billingProfiles)
      .where(eq(schema.billingProfiles.walletAddress, walletAddress.toLowerCase()))
      .limit(1);

    if (!profile) {
      res.status(404).json({ error: "Billing profile not found" });
      return;
    }

    if (body.isDefault) {
      await db
        .update(schema.billingPaymentMethods)
        .set({ isDefault: false })
        .where(eq(schema.billingPaymentMethods.profileId, profile.id));
    }

    const [created] = await db
      .insert(schema.billingPaymentMethods)
      .values({
        id: crypto.randomUUID(),
        profileId: profile.id,
        type: body.type,
        metadata: JSON.stringify(body.metadata),
        isDefault: body.isDefault ?? false,
      })
      .returning();

    res.status(201).json({
      success: true,
      data: { ...created, metadata: JSON.parse(created.metadata) },
    });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/v1/billing/profile/:walletAddress/payment-methods/:methodId
billingRouter.delete("/billing/profile/:walletAddress/payment-methods/:methodId", async (req, res, next) => {
  if (!env.BILLING_ENABLED) return billingDisabled(res);
  try {
    const { walletAddress, methodId } = z
      .object({ walletAddress: z.string().min(3), methodId: z.string().uuid() })
      .parse(req.params);

    const [profile] = await db
      .select({ id: schema.billingProfiles.id })
      .from(schema.billingProfiles)
      .where(eq(schema.billingProfiles.walletAddress, walletAddress.toLowerCase()))
      .limit(1);

    if (!profile) {
      res.status(404).json({ error: "Billing profile not found" });
      return;
    }

    const deleted = await db
      .delete(schema.billingPaymentMethods)
      .where(
        and(
          eq(schema.billingPaymentMethods.id, methodId),
          eq(schema.billingPaymentMethods.profileId, profile.id)
        )
      )
      .returning({ id: schema.billingPaymentMethods.id });

    if (!deleted[0]) {
      res.status(404).json({ error: "Payment method not found" });
      return;
    }

    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/billing/profile/:walletAddress/invoices
billingRouter.get("/billing/profile/:walletAddress/invoices", async (req, res, next) => {
  if (!env.BILLING_ENABLED) return billingDisabled(res);
  try {
    const { walletAddress } = WalletParam.parse(req.params);
    const [profile] = await db
      .select({ id: schema.billingProfiles.id })
      .from(schema.billingProfiles)
      .where(eq(schema.billingProfiles.walletAddress, walletAddress.toLowerCase()))
      .limit(1);

    if (!profile) {
      res.status(404).json({ error: "Billing profile not found" });
      return;
    }

    const invoices = await db
      .select()
      .from(schema.billingInvoices)
      .where(eq(schema.billingInvoices.profileId, profile.id));

    res.json({ success: true, data: invoices });
  } catch (e) {
    next(e);
  }
});

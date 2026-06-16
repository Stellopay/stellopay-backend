import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc } from "drizzle-orm";
import { normalizeStarknetAddress } from "../utils/codec.js";

const normalizeAddress = normalizeStarknetAddress;

const AddressParam = z.string().min(3);

export const indexedRouter = Router();

// Get all agreements for a user (employer or contributor/employee)
indexedRouter.get("/indexed/agreements/:contract_address/user/:user_address", async (req, res, next) => {
  try {
    const contractAddress = AddressParam.parse(req.params.contract_address);
    const userAddress = normalizeAddress(req.params.user_address);

    // Find agreements where user is employer or contributor
    const agreements = await db
      .select()
      .from(schema.agreements)
      .where(
        and(
          eq(schema.agreements.contractAddress, contractAddress),
          or(
            eq(schema.agreements.employer, userAddress),
            eq(schema.agreements.contributor, userAddress)
          )
        )
      )
      .orderBy(desc(schema.agreements.createdAt));

    // Also check if user is an employee in any payroll agreements
    const employeeAgreements = await db
      .select({
        agreement: schema.agreements,
      })
      .from(schema.agreements)
      .innerJoin(
        schema.employees,
        eq(schema.agreements.id, schema.employees.agreementId)
      )
      .where(
        and(
          eq(schema.agreements.contractAddress, contractAddress),
          eq(schema.employees.employeeAddress, userAddress),
          eq(schema.agreements.mode, 1) // Payroll mode
        )
      )
      .orderBy(desc(schema.agreements.createdAt));

    // Combine and deduplicate
    const allAgreements = [
      ...agreements,
      ...employeeAgreements.map((e) => e.agreement),
    ];

    // Remove duplicates by agreement ID
    const uniqueAgreements = Array.from(
      new Map(allAgreements.map((a) => [a.id, a])).values()
    );

    res.json({
      agreements: uniqueAgreements,
      count: uniqueAgreements.length,
      source: "indexed",
    });
  } catch (e) {
    next(e);
  }
});

// Get agreement details by ID
indexedRouter.get("/indexed/agreement/:contract_address/:agreement_id", async (req, res, next) => {
  try {
    const contractAddress = AddressParam.parse(req.params.contract_address);
    const agreementId = req.params.agreement_id;

    const agreement = await db
      .select()
      .from(schema.agreements)
      .where(
        and(
          eq(schema.agreements.contractAddress, contractAddress),
          eq(schema.agreements.id, agreementId)
        )
      )
      .limit(1);

    if (agreement.length === 0) {
      res.status(404).json({ error: "Agreement not found" });
      return;
    }

    // Get related data
    const [events, payments, milestones, employees, escrowEvents] = await Promise.all([
      // Events
      db
        .select()
        .from(schema.agreementEvents)
        .where(eq(schema.agreementEvents.agreementId, agreementId))
        .orderBy(desc(schema.agreementEvents.blockNumber)),

      // Payments
      db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.agreementId, agreementId))
        .orderBy(desc(schema.payments.blockNumber)),

      // Milestones
      db
        .select()
        .from(schema.milestones)
        .where(eq(schema.milestones.agreementId, agreementId))
        .orderBy(schema.milestones.milestoneId),

      // Employees (for payroll)
      db
        .select()
        .from(schema.employees)
        .where(eq(schema.employees.agreementId, agreementId))
        .orderBy(schema.employees.employeeIndex),

      // Escrow events
      db
        .select()
        .from(schema.escrowEvents)
        .where(eq(schema.escrowEvents.agreementId, agreementId))
        .orderBy(desc(schema.escrowEvents.blockNumber)),
    ]);

    res.json({
      agreement: agreement[0],
      events,
      payments,
      milestones,
      employees,
      escrowEvents,
    });
  } catch (e) {
    next(e);
  }
});

// Get payments for a user
indexedRouter.get("/indexed/payments/user/:user_address", async (req, res, next) => {
  try {
    const userAddress = normalizeAddress(req.params.user_address);

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
      .limit(100);

    res.json({ payments, count: payments.length });
  } catch (e) {
    next(e);
  }
});

// Get escrow balance for an agreement
indexedRouter.get("/indexed/escrow/:contract_address/balance/:agreement_id", async (req, res, next) => {
  try {
    const contractAddress = AddressParam.parse(req.params.contract_address);
    const agreementId = req.params.agreement_id;

    // Calculate balance from escrow events
    const escrowEvents = await db
      .select()
      .from(schema.escrowEvents)
      .where(
        and(
          eq(schema.escrowEvents.contractAddress, contractAddress),
          eq(schema.escrowEvents.agreementId, agreementId)
        )
      )
      .orderBy(schema.escrowEvents.blockNumber);

    let balance = BigInt(0);
    for (const event of escrowEvents) {
      if (event.eventType === "Funded") {
        balance += BigInt(event.amount);
      } else if (event.eventType === "Released" || event.eventType === "Refunded") {
        balance -= BigInt(event.amount);
      }
    }

    res.json({
      agreement_id: agreementId,
      balance: balance.toString(),
      events: escrowEvents,
    });
  } catch (e) {
    next(e);
  }
});


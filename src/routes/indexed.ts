import { Router } from "express";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc } from "drizzle-orm";
import { StarknetAddress, AgreementId, parsePagination } from "../utils/validation.js";
import { notFoundResponse } from "./not-found.js";
import { applyIndexedCacheHeaders } from "../utils/cache-headers.js";
import { env, defaults } from "../config.js";
import { normalizeStarknetAddress as normalizeAddr } from "../utils/address.js";

export const indexedRouter = Router();

/** Shared cache options driven by the env – applied to every indexed read. */
const cacheOpts = { maxAgeSeconds: env.INDEXED_CACHE_MAX_AGE_SECONDS };

// Get all agreements for a user (employer or contributor/employee)
indexedRouter.get(
  "/indexed/agreements/:contract_address/user/:user_address",
  async (req, res, next) => {
    try {
      const contractAddress = StarknetAddress.parse(req.params.contract_address);
      if (contractAddress !== normalizeAddr(defaults.workAgreementAddress)) {
        res.status(400).json({ error: "Invalid contract address for agreements" });
        return;
      }
      const userAddress = StarknetAddress.parse(req.params.user_address);
      const { limit, offset } = parsePagination(req.query);

      // Find agreements where user is employer or contributor, and separately
      // check if the user is an employee in any payroll agreements. These two
      // queries don't depend on each other, so run them concurrently instead
      // of paying for two sequential round trips.
      const [agreements, employeeAgreements] = await Promise.all([
        db
          .select()
          .from(schema.agreements)
          .where(
            and(
              eq(schema.agreements.contractAddress, contractAddress),
              or(
                eq(schema.agreements.employer, userAddress),
                eq(schema.agreements.contributor, userAddress),
              ),
            ),
          )
          .orderBy(desc(schema.agreements.createdAt))
          .limit(limit)
          .offset(offset),

        db
          .select({
            agreement: schema.agreements,
          })
          .from(schema.agreements)
          .innerJoin(schema.employees, eq(schema.agreements.id, schema.employees.agreementId))
          .where(
            and(
              eq(schema.agreements.contractAddress, contractAddress),
              eq(schema.employees.employeeAddress, userAddress),
              eq(schema.agreements.mode, 1), // Payroll mode
            ),
          )
          .orderBy(desc(schema.agreements.createdAt))
          .limit(limit),
      ]);

      // Combine and deduplicate
      const allAgreements = [...agreements, ...employeeAgreements.map((e) => e.agreement)];

      // Remove duplicates by agreement ID, then bound the combined result.
      const uniqueAgreements = Array.from(
        new Map(allAgreements.map((a) => [a.id, a])).values(),
      ).slice(0, limit);

      const body = {
        agreements: uniqueAgreements,
        count: uniqueAgreements.length,
        source: "indexed",
      };

      applyIndexedCacheHeaders(res, body, cacheOpts);
      res.json(body);
    } catch (e) {
      next(e);
    }
  },
);

// Get agreement details by ID
indexedRouter.get("/indexed/agreement/:contract_address/:agreement_id", async (req, res, next) => {
  try {
    const contractAddress = StarknetAddress.parse(req.params.contract_address);
    if (contractAddress !== normalizeAddr(defaults.workAgreementAddress)) {
      res.status(400).json({ error: "Invalid contract address for agreement details" });
      return;
    }
    const agreementId = AgreementId.parse(req.params.agreement_id);

    const agreement = await db
      .select()
      .from(schema.agreements)
      .where(
        and(
          eq(schema.agreements.contractAddress, contractAddress),
          eq(schema.agreements.id, agreementId),
        ),
      )
      .limit(1);

    if (agreement.length === 0) {
      notFoundResponse(res, "Agreement not found");
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

    const body = {
      agreement: agreement[0],
      events,
      payments,
      milestones,
      employees,
      escrowEvents,
    };

    applyIndexedCacheHeaders(res, body, cacheOpts);
    res.json(body);
  } catch (e) {
    next(e);
  }
});

// Get payments for a user
indexedRouter.get("/indexed/payments/user/:user_address", async (req, res, next) => {
  try {
    const userAddress = StarknetAddress.parse(req.params.user_address);
    const { limit, offset } = parsePagination(req.query);

    const payments = await db
      .select()
      .from(schema.payments)
      .where(or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)))
      .orderBy(desc(schema.payments.blockNumber))
      .limit(limit)
      .offset(offset);

    const body = { payments, count: payments.length };

    applyIndexedCacheHeaders(res, body, cacheOpts);
    res.json(body);
  } catch (e) {
    next(e);
  }
});

// Get escrow balance for an agreement
indexedRouter.get(
  "/indexed/escrow/:contract_address/balance/:agreement_id",
  async (req, res, next) => {
    try {
      const contractAddress = StarknetAddress.parse(req.params.contract_address);
      if (contractAddress !== normalizeAddr(defaults.payrollEscrowAddress)) {
        res.status(400).json({ error: "Invalid contract address for escrow balance" });
        return;
      }
      const agreementId = AgreementId.parse(req.params.agreement_id);

      // Calculate balance from escrow events
      const escrowEvents = await db
        .select()
        .from(schema.escrowEvents)
        .where(
          and(
            eq(schema.escrowEvents.contractAddress, contractAddress),
            eq(schema.escrowEvents.agreementId, agreementId),
          ),
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

      const body = {
        agreement_id: agreementId,
        balance: balance.toString(),
        events: escrowEvents,
      };

      applyIndexedCacheHeaders(res, body, cacheOpts);
      res.json(body);
    } catch (e) {
      next(e);
    }
  },
);

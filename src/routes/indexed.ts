import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc } from "drizzle-orm";
import { StarknetAddress, AgreementId, parsePagination } from "../utils/validation.js";
import { defaults, env } from "../config.js";
import { normalizeStarknetAddress } from "../utils/address.js";
import { notFoundResponse } from "./not-found.js";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { applyIndexedCacheHeaders } from "../utils/cache-headers.js";

/**
 * Source identifier tag returned in indexed route responses.
 */
export const INDEXED_DATA_SOURCE = "indexed";

/**
 * Hard limit for sub-resources (events, payments, etc.) inside a detail view
 * to prevent unbounded database scans.
 */
export const MAX_INTERNAL_LIMIT = 200;

const indexedCacheOptions = {
  maxAgeSeconds: env.INDEXED_CACHE_MAX_AGE_SECONDS,
};

/**
 * Centralized authorization gate for indexer freshness and sync checkpoint operations.
 * Requires an authenticated principal (requireAuth) with admin privileges (requireAdmin).
 * Permission evaluation occurs before any database or internal indexer state access.
 */
export const authorizeIndexedFreshness = [requireAuth, requireAdmin];

/**
 * Derives the indexer sync checkpoint (highest block number) from a set of
 * database records indexed from Starknet events.
 *
 * This function is pure and deterministic: repeated calls with the same input
 * always produce the same output, making sync checkpoint derivation idempotent.
 *
 * @param records Array of database entities with an optional blockNumber property
 * @returns High-water mark block number, or 0 if records list is empty or lacks block numbers.
 */
export function deriveSyncCheckpoint(
  records: Array<{ blockNumber?: number | bigint | null }>
): number {
  if (!records || !Array.isArray(records) || records.length === 0) return 0;
  let maxBlock = 0;
  for (const record of records) {
    if (record && record.blockNumber !== undefined && record.blockNumber !== null) {
      const bn = typeof record.blockNumber === "bigint" ? Number(record.blockNumber) : Number(record.blockNumber);
      if (Number.isFinite(bn) && bn >= 0) {
        if (bn > maxBlock) {
          maxBlock = bn;
        }
      } else {
        console.warn({ event: "indexer_checkpoint_invalid_block", blockNumber: record.blockNumber, reason: "invalid_format_or_negative" });
      }
    }
  }
  return maxBlock;
}

export const indexedRouter = Router();

// Output Schemas for Contract Hardening
const AgreementSchema = z.object({
  id: z.string(),
  contractAddress: z.string().optional(),
  employer: z.string().optional(),
  contributor: z.string().nullable().optional(),
  mode: z.number().optional(),
  createdAt: z.date().or(z.string()).optional(),
}).passthrough();

/**
 * GET /indexed/freshness
 *
 * Retrieves indexer sync checkpoint block and freshness state.
 *
 * Authorization Contract:
 * - Requires authenticated session (requireAuth) and admin privileges (requireAdmin).
 * - Permission evaluation occurs BEFORE any database query or indexer state access.
 * - Standard 401 response for unauthorized requests ({ error: "Unauthorized" }).
 * - Standard 403 response for forbidden requests ({ error: "Forbidden" }).
 * - Unauthorized requests receive no state information or execution timing payload.
 *
 * Idempotency: This endpoint is read-only. Repeated requests with the same
 * underlying database state produce identical responses.
 */
indexedRouter.get(
  "/indexed/freshness",
  requireAuth,
  requireAdmin,
  async (_req, res, next) => {
    try {
      const records = await db
        .select({ blockNumber: schema.agreementEvents.blockNumber })
        .from(schema.agreementEvents)
        .orderBy(desc(schema.agreementEvents.blockNumber))
        .limit(100);

      const checkpointBlock = deriveSyncCheckpoint(records);

      const body = {
        source: INDEXED_DATA_SOURCE,
        checkpointBlock,
        freshness: records.length > 0 ? "synced" : "empty",
      };

      res.setHeader("x-indexer-sync-checkpoint", String(checkpointBlock));
      res.json(body);
    } catch (e) {
      next(e);
    }
  },
);

/**
 * GET /indexed/checkpoint
 *
 * Retrieves indexer sync checkpoint block number.
 *
 * Authorization Contract:
 * - Requires authenticated session (requireAuth) and admin privileges (requireAdmin).
 * - Permission evaluation occurs BEFORE any database query or indexer state access.
 * - Standard 401 response for unauthorized requests ({ error: "Unauthorized" }).
 * - Standard 403 response for forbidden requests ({ error: "Forbidden" }).
 * - Unauthorized requests receive no state information or execution timing payload.
 *
 * Idempotency: This endpoint is read-only. Repeated requests with the same
 * underlying database state produce identical responses.
 */
indexedRouter.get(
  "/indexed/checkpoint",
  requireAuth,
  requireAdmin,
  async (_req, res, next) => {
    try {
      const records = await db
        .select({ blockNumber: schema.agreementEvents.blockNumber })
        .from(schema.agreementEvents)
        .orderBy(desc(schema.agreementEvents.blockNumber))
        .limit(100);

      const checkpointBlock = deriveSyncCheckpoint(records);

      const body = {
        source: INDEXED_DATA_SOURCE,
        checkpointBlock,
      };

      res.setHeader("x-indexer-sync-checkpoint", String(checkpointBlock));
      res.json(body);
    } catch (e) {
      next(e);
    }
  },
);

/**
 * GET /indexed/agreements/:contract_address/user/:user_address
 *
 * Retrieves all agreements associated with a specific user (as employer, contributor,
 * or payroll employee).
 */
indexedRouter.get(
  "/indexed/agreements/:contract_address/user/:user_address",
  async (req, res, next) => {
    try {
      const contractAddress = StarknetAddress.parse(req.params.contract_address);
      if (contractAddress === normalizeStarknetAddress(defaults.payrollEscrowAddress)) {
        res.status(400).json({ error: "Invalid contract address for agreements" });
        return;
      }
      const userAddress = StarknetAddress.parse(req.params.user_address);
      const { limit, offset } = parsePagination(req.query);

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
              eq(schema.agreements.mode, 1),
            ),
          )
          .orderBy(desc(schema.agreements.createdAt))
          .limit(limit),
      ]);

      const allAgreements = [...agreements, ...employeeAgreements.map((e) => e.agreement)];
      const uniqueAgreements = [...new Map(allAgreements.map((a) => [a.id, a])).values()];
      const pagedAgreements = uniqueAgreements.slice(0, limit);

      const checkpointBlock = deriveSyncCheckpoint(allAgreements);

      const body = {
        agreements: z.array(AgreementSchema).parse(pagedAgreements),
        count: pagedAgreements.length,
        source: INDEXED_DATA_SOURCE,
      };

      res.setHeader("x-indexer-sync-checkpoint", String(checkpointBlock));
      applyIndexedCacheHeaders(res, body, indexedCacheOptions);
      res.json(body);
    } catch (e) {
      next(e);
    }
  },
);

/**
 * GET /indexed/agreement/:contract_address/:agreement_id
 *
 * Retrieves full details for a single agreement including related events, payments,
 * milestones, employees, and escrow events.
 */
indexedRouter.get("/indexed/agreement/:contract_address/:agreement_id", async (req, res, next) => {
  try {
    const contractAddress = StarknetAddress.parse(req.params.contract_address);
    if (contractAddress === normalizeStarknetAddress(defaults.payrollEscrowAddress)) {
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

    const [events, payments, milestones, employees, escrowEvents] = await Promise.all([
      db.select().from(schema.agreementEvents)
        .where(eq(schema.agreementEvents.agreementId, agreementId))
        .orderBy(desc(schema.agreementEvents.blockNumber)).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.payments)
        .where(eq(schema.payments.agreementId, agreementId))
        .orderBy(desc(schema.payments.blockNumber)).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.milestones)
        .where(eq(schema.milestones.agreementId, agreementId))
        .orderBy(schema.milestones.milestoneId).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.employees)
        .where(eq(schema.employees.agreementId, agreementId))
        .orderBy(schema.employees.employeeIndex).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.escrowEvents)
        .where(eq(schema.escrowEvents.agreementId, agreementId))
        .orderBy(desc(schema.escrowEvents.blockNumber)).limit(MAX_INTERNAL_LIMIT),
    ]);

    const body = {
      agreement: AgreementSchema.parse(agreement[0]),
      events,
      payments,
      milestones,
      employees,
      escrowEvents,
    };

    const checkpointBlock = deriveSyncCheckpoint(
      [agreement[0], ...events, ...payments, ...milestones, ...employees, ...escrowEvents],
    );

    res.setHeader("x-indexer-sync-checkpoint", String(checkpointBlock));
    applyIndexedCacheHeaders(res, body, indexedCacheOptions);
    res.json(body);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /indexed/payments/user/:user_address
 *
 * Retrieves payments sent or received by a specific user address.
 */
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
    res.json(body);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /indexed/escrow/:contract_address/balance/:agreement_id
 *
 * Computes agreement escrow balance by replaying indexed escrow events.
 */
indexedRouter.get(
  "/indexed/escrow/:contract_address/balance/:agreement_id",
  async (req, res, next) => {
    try {
      const contractAddress = StarknetAddress.parse(req.params.contract_address);
      if (contractAddress !== normalizeStarknetAddress(defaults.payrollEscrowAddress)) {
        res.status(400).json({ error: "Invalid contract address for escrow balance" });
        return;
      }
      const agreementId = AgreementId.parse(req.params.agreement_id);

      const escrowEvents = await db
        .select()
        .from(schema.escrowEvents)
        .where(
          and(
            eq(schema.escrowEvents.contractAddress, contractAddress),
            eq(schema.escrowEvents.agreementId, agreementId),
          ),
        )
        .orderBy(schema.escrowEvents.blockNumber)
        .limit(500); 

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

      res.json(body);
    } catch (e) {
      next(e);
    }
  },
);

export default indexedRouter;


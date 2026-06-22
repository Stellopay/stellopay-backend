import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { provider } from "../starknet/client.js";
import { eq, and, gte, lte } from "drizzle-orm";
import { Contract } from "starknet";
import { defaults, abiPaths } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "../starknet/abi.js";
import { processTxReceipt, TxHashSchema, MAX_BATCH_SIZE } from "./events.js";

export const reprocessEventsRouter = Router();

/** Maximum number of events to reprocess in a single status-changes request. */
const MAX_STATUS_LIMIT = 1000;

/** Zod schema for the status-changes query parameters. */
const StatusChangesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_STATUS_LIMIT).optional().default(100),
  fromBlock: z.coerce.number().int().positive().optional(),
  toBlock: z.coerce.number().int().positive().optional(),
});

// Load contract ABIs
let workAgreementAbi: any[] | null = null;
let payrollEscrowAbi: any[] | null = null;

async function getWorkAgreementAbi(): Promise<any[]> {
  if (!workAgreementAbi) {
    if (!abiPaths.agreement) {
      throw new Error("AGREEMENT_CONTRACT_CLASS_JSON path is not configured");
    }
    workAgreementAbi = loadAbiFromContractClassJsonPath(abiPaths.agreement);
  }
  return workAgreementAbi;
}

async function getPayrollEscrowAbi(): Promise<any[]> {
  if (!payrollEscrowAbi) {
    if (!abiPaths.escrow) {
      throw new Error("ESCROW_CONTRACT_CLASS_JSON path is not configured");
    }
    payrollEscrowAbi = loadAbiFromContractClassJsonPath(abiPaths.escrow);
  }
  return payrollEscrowAbi;
}

/**
 * POST /reprocess-events/tx/:tx_hash
 *
 * Reprocess events for a single transaction to decode event names.
 * Delegates to the shared `processTxReceipt` which uses `ON CONFLICT DO NOTHING`
 * keyed on `transaction_hash + event_index` — re-runs are safe no-ops.
 *
 * **Validation**
 * - `:tx_hash` must be a valid Starknet transaction hash (0x-prefixed, 3–66 chars).
 */
reprocessEventsRouter.post(
  "/reprocess-events/tx/:tx_hash",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { tx_hash } = z.object({ tx_hash: TxHashSchema }).parse(req.params);

      const result = await processTxReceipt(tx_hash);

      if (result.status === "not_found") {
        res.status(404).json({ error: "Transaction not found" });
        return;
      }

      res.json({
        message: "Events reprocessed",
        result,
      });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid Starknet transaction hash format" });
        return;
      }
      if (e.message === "Transaction not found") {
        res.status(404).json({ error: "Transaction not found" });
        return;
      }
      next(e);
    }
  },
);

/**
 * POST /reprocess-events/batch
 *
 * Reprocess events for multiple transactions. Each tx hash is processed
 * independently using the same shared `processTxReceipt` logic so the
 * operation is fully idempotent — re-submitting the same batch produces
 * no duplicate rows.
 *
 * **Validation**
 * - `tx_hashes` must be a non-empty array of valid Starknet tx hashes.
 * - A maximum of {@link MAX_BATCH_SIZE} hashes is accepted per request.
 *
 * **Response**
 * Returns a `results` array where each entry corresponds to one tx hash.
 * A per-tx error never aborts the rest of the batch.
 */
reprocessEventsRouter.post(
  "/reprocess-events/batch",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { tx_hashes } = z
        .object({
          tx_hashes: z
            .array(TxHashSchema)
            .min(1, "tx_hashes must contain at least one hash")
            .max(
              MAX_BATCH_SIZE,
              `tx_hashes must contain at most ${MAX_BATCH_SIZE} hashes per request`,
            ),
        })
        .parse(req.body);

      const results = [];

      for (const txHash of tx_hashes) {
        try {
          const result = await processTxReceipt(txHash);
          results.push(result);
        } catch (e: any) {
          results.push({
            txHash,
            status: "error",
            eventsProcessed: 0,
            eventLabels: [],
            error: e?.message ?? String(e),
          });
        }
      }

      const totalProcessed = results.reduce((sum, r) => sum + r.eventsProcessed, 0);

      res.json({
        summary: {
          total: results.length,
          processed: results.filter((r) => r.status === "processed").length,
          noEvents: results.filter((r) => r.status === "no_events").length,
          notFound: results.filter((r) => r.status === "not_found").length,
          errors: results.filter((r) => r.status === "error").length,
          totalEventsProcessed: totalProcessed,
        },
        results,
      });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: e.errors[0]?.message || "Invalid request body" });
        return;
      }
      next(e);
    }
  },
);

/**
 * POST /reprocess-events/status-changes
 *
 * Reprocess all AgreementStatusChange events to decode their actual names.
 * Only processes events that still have `eventType === "AgreementStatusChange"`,
 * so re-runs automatically skip already-updated events.  An in-memory dedup
 * set keyed on `transaction_hash + event_index` prevents processing the same
 * event twice within a single request.
 *
 * **Validation**
 * - `limit` (query, optional, default 100, max {@link MAX_STATUS_LIMIT})
 * - `fromBlock` / `toBlock` (query, optional) — filter by block number range.
 */
reprocessEventsRouter.post(
  "/reprocess-events/status-changes",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { limit, fromBlock, toBlock } = StatusChangesQuerySchema.parse(req.query);

      // Get contract ABIs
      const workAgreementAbi = await getWorkAgreementAbi();
      const payrollEscrowAbi = await getPayrollEscrowAbi();
      const workAgreementAddress = defaults.workAgreementAddress.toLowerCase();
      const payrollEscrowAddress = defaults.payrollEscrowAddress.toLowerCase();

      // Create contract instances for event parsing
      const workAgreementContract = new Contract(workAgreementAbi, workAgreementAddress, provider);
      const payrollEscrowContract = new Contract(payrollEscrowAbi, payrollEscrowAddress, provider);

      // Build where clause: only process events still tagged as AgreementStatusChange
      const conditions = [eq(schema.agreementEvents.eventType, "AgreementStatusChange")];
      if (fromBlock !== undefined) {
        conditions.push(gte(schema.agreementEvents.blockNumber, fromBlock));
      }
      if (toBlock !== undefined) {
        conditions.push(lte(schema.agreementEvents.blockNumber, toBlock));
      }

      // Get AgreementStatusChange events matching the filter
      const statusChangeEvents = await db
        .select()
        .from(schema.agreementEvents)
        .where(and(...conditions))
        .limit(limit);

      const results = [];
      let updated = 0;
      // In-memory dedup keyed on transaction_hash + event_index to prevent
      // processing the same event twice within a single request.
      const processedKeys = new Set<string>();

      for (const event of statusChangeEvents) {
        // Dedup on transaction_hash + event_index — skip if already seen in this request
        const dedupKey = `${event.transactionHash}_${event.eventIndex}`;
        if (processedKeys.has(dedupKey)) {
          results.push({ eventId: event.id, status: "dedup_skipped" });
          continue;
        }
        processedKeys.add(dedupKey);

        try {
          // Get transaction receipt to decode event
          const receipt = await provider.getTransactionReceipt(event.transactionHash);
          if (!receipt || !("events" in receipt && receipt.events)) {
            results.push({ eventId: event.id, status: "no_receipt" });
            continue;
          }

          // Find the event in the receipt
          const receiptEvent = receipt.events[event.eventIndex];
          if (!receiptEvent) {
            results.push({ eventId: event.id, status: "event_not_found" });
            continue;
          }

          // Decode event using contract ABI
          const fromAddress = receiptEvent.from_address?.toLowerCase() || "";
          const eventContractAddress = event.contractAddress?.toLowerCase() || fromAddress;
          let decodedEvent: any = null;
          let eventType = "AgreementStatusChange";

          try {
            // Try to parse with WorkAgreement contract (use event's contract address)
            const workContract = new Contract(workAgreementAbi, eventContractAddress, provider);
            try {
              decodedEvent = workContract.parseEvent(receiptEvent);
              eventType = decodedEvent.name;
            } catch (e1) {
              // Try with PayrollEscrow contract
              const escrowContract = new Contract(payrollEscrowAbi, eventContractAddress, provider);
              try {
                decodedEvent = escrowContract.parseEvent(receiptEvent);
                eventType = decodedEvent.name;
              } catch (e2) {
                // If both fail, try to decode from event selector directly
                const eventSelector = receiptEvent.keys?.[0] || "";
                const selectorMap: Record<string, string> = {
                  "0x39935559db9e6f265020b5e7f9e32f707ec95bc7744e4313651be569076f335":
                    "AgreementActivated",
                  "0x2fd23973c113c5a29f0779620b5bee73d19782f53a0d36ab5fb34fee90d61f3":
                    "AgreementPaused",
                  "0xd8daf85c1fa0887e802a145d9f3c7db99b61aa78d5beb5c98ffd0fc8df3d45":
                    "AgreementResumed",
                  "0x191e18e7a94a169e8b312a6640b0c4044d7eff6f223d39c1f71b73d6de1f701":
                    "AgreementCancelled",
                  "0x12be36ac260b6bcaaeb819d1673545d25c1028519a08bb569e0622654c96218":
                    "AgreementCompleted",
                  "0x17babb38579af523049462702ad3f85d2827a23c68e1d9cfdcf6115ad2adcf4":
                    "EmployeeAdded",
                  "0x12e84408ed2be37d5b7d3bb7d832aa3cf1f44f39a1add754c77048fb820f445":
                    "MilestoneAdded",
                  "0x16e453add3d657589b2875d4b5297f7c350b8eea55fecbdd84a5516ed81dc0a":
                    "MilestoneApproved",
                  "0x3bd85f42a3b157753a56c683adb962a9b52ebe31ead396608da3903e9729a27":
                    "MilestoneClaimed",
                  "0xaee5edac2a21de2e1003994d9fe958621235a659a2ea93d7a584ddd70671b3":
                    "PayrollClaimed",
                  "0xad330e12dae484af39764778243710c62245fbdd601ba5122e7200c8bedcee":
                    "DisputeRaised",
                  "0x27eac42673c7b6ad77b281f32dfd605fc2994c6e2ba3bcb526bb46f4eaa636c":
                    "DisputeResolved",
                };

                const normalizedSelector = eventSelector.toLowerCase();
                if (selectorMap[normalizedSelector]) {
                  eventType = selectorMap[normalizedSelector];
                }
              }
            }
          } catch (parseError) {
            console.log(
              `[reprocess] Could not parse event ${event.id}, keeping AgreementStatusChange`,
            );
          }

          // Update the event type in the database
          if (eventType !== "AgreementStatusChange") {
            await db
              .update(schema.agreementEvents)
              .set({ eventType })
              .where(eq(schema.agreementEvents.id, event.id));

            updated++;
            results.push({
              eventId: event.id,
              status: "updated",
              oldType: "AgreementStatusChange",
              newType: eventType,
            });
          } else {
            results.push({ eventId: event.id, status: "no_change", eventType });
          }
        } catch (e) {
          results.push({ eventId: event.id, status: "error", error: String(e) });
        }
      }

      res.json({
        message: `Reprocessed ${results.length} events, updated ${updated}`,
        updated,
        results,
      });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: e.errors[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    }
  },
);

// reprocess-events.ts
import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { provider } from "../starknet/client.js";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { Contract } from "starknet";
import { processTxReceipt, normalizeTransactionHash, TxHashSchema, MAX_BATCH_SIZE, getWorkAgreementAbi, getPayrollEscrowAbi } from "./events.js";
import { notFoundResponse } from "./not-found.js";
import fs from "fs";
import path from "path";

export const reprocessEventsRouter = Router();

/** Maximum number of events to reprocess in a single status‑changes request.
 * This limit caps the number of rows returned by the `/reprocess-events/status-changes`
 * endpoint to protect against excessively large responses.
 */
export const MAX_STATUS_LIMIT = 1000;

/** Default retry budget for reprocessing failures.
 * The number of allowed attempts before a transaction is moved to quarantine.
 * Can be overridden via the `RETRY_BUDGET` environment variable.
 */
export const RETRY_BUDGET = Number(process.env.RETRY_BUDGET) || 3;

/** Directory where quarantined transaction hashes are persisted.
 * The path can be overridden with the `QUARANTINE_PATH` environment variable.
 * When not set, a `quarantine` folder is created in the current working directory.
 */
export const QUARANTINE_PATH = process.env.QUARANTINE_PATH
  ? path.resolve(process.env.QUARANTINE_PATH)
  : path.resolve(process.cwd(), "quarantine");
/** In‑memory map tracking retry attempts per normalized transaction hash. */
const retryCounts = new Map<string, number>();

/** Per‑event retry counts for status‑changes reprocessing (keyed by txHash_eventIndex). */
const statusChangeRetryCounts = new Map<string, number>();

/** Set of event keys (txHash_eventIndex) that have exceeded the retry budget
 * and should be skipped on subsequent status‑changes passes. */
const statusChangeQuarantine = new Set<string>();

/**
 * Reset in‑memory retry counts. Exported for tests to ensure isolation.
 */
export function __resetRetryCounts() {
  retryCounts.clear();
}

/** Reset in‑memory status‑changes retry counts. Exported for tests. */
export function __resetStatusChangeRetryCounts() {
  statusChangeRetryCounts.clear();
}

/** Reset in‑memory status‑changes quarantine set. Exported for tests. */
export function __resetStatusChangeQuarantine() {
  statusChangeQuarantine.clear();
}

/** Global in-memory lock state tracking active reprocess tasks. */
let isReprocessingActive = false;

/**
 * Check whether a reprocessing operation is currently in progress.
 */
export function getReprocessingLockStatus(): boolean {
  return isReprocessingActive;
}

/**
 * Attempt to acquire the reprocessing lock.
 * @returns `true` if lock was successfully acquired; `false` if already locked.
 */
export function acquireReprocessLock(): boolean {
  if (isReprocessingActive) {
    return false;
  }
  isReprocessingActive = true;
  return true;
}

/**
 * Release the reprocessing lock.
 */
export function releaseReprocessLock(): void {
  isReprocessingActive = false;
}

/**
 * Reset in-memory reprocessing lock state. Exported for tests to ensure isolation.
 */
export function __resetReprocessLocks(): void {
  isReprocessingActive = false;
}

/**
 * Helper to record a failure and optionally quarantine the transaction.
 * Uses `attempts > RETRY_BUDGET` (quarantines on the 4th failure when budget is 3)
 * because the tx/batch routes track per-transaction retries across requests.
 */
function handleRetry(txHash: string, error: any) {
  const norm = normalizeTransactionHash(txHash);
  const attempts = (retryCounts.get(norm) ?? 0) + 1;
  retryCounts.set(norm, attempts);
  if (attempts > RETRY_BUDGET) {
    try {
      fs.mkdirSync(QUARANTINE_PATH, { recursive: true });
      const filePath = path.join(QUARANTINE_PATH, `${norm}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({ txHash: norm, error: error?.message ?? String(error) }, null, 2),
      );
    } catch (e) {
      console.error("[reprocess] Failed to write quarantine file", e);
    }
    return { status: "quarantined" as const, attempts, error: error?.message ?? String(error) };
  }
  return { status: "error" as const, attempts, error: error?.message ?? String(error) };
}

/** Zod schema for the status‑changes query parameters. */
const StatusChangesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_STATUS_LIMIT).optional().default(100),
  fromBlock: z.coerce.number().int().positive().optional(),
  toBlock: z.coerce.number().int().positive().optional(),
});

// ABI functions are imported from events.ts (single source of truth).
// The lazy‑loaded ABIs are shared across routes to avoid duplicate I/O.

/** POST /reprocess-events/tx/:tx_hash */
reprocessEventsRouter.post(
  "/reprocess-events/tx/:tx_hash",
  requireAuth,
  requireAdmin,
  async (req, res, _next) => {
    if (!acquireReprocessLock()) {
      res.status(409).json({ error: "Reprocessing operation already in progress" });
      return;
    }
    try {
      const { tx_hash } = z.object({ tx_hash: TxHashSchema }).parse(req.params);
      const result = await processTxReceipt(tx_hash);
      if (result.status === "not_found") {
        notFoundResponse(res, "Transaction not found");
        return;
      }
      res.json({ message: "Events reprocessed", result });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid Starknet transaction hash format" });
        return;
      }
      const retry = handleRetry(req.params.tx_hash, e);
      if (retry.status === "quarantined") {
        res.json({
          message: "Transaction quarantined after repeated failures",
          attempts: retry.attempts,
          error: retry.error,
        });
        return;
      }
      res.status(500).json({ attempts: retry.attempts, error: retry.error });
      return;
    } finally {
      releaseReprocessLock();
    }
  });

/** POST /reprocess-events/batch */
reprocessEventsRouter.post(
  "/reprocess-events/batch",
  requireAuth,
  requireAdmin,
  async (req, res, _next) => {
    if (!acquireReprocessLock()) {
      res.status(409).json({ error: "Reprocessing operation already in progress" });
      return;
    }
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

      const results: any[] = [];
      const resultByNormalizedHash = new Map<string, any>();
      let duplicates = 0;

      for (const txHash of tx_hashes) {
        const normalizedHash = normalizeTransactionHash(txHash);
        const cached = resultByNormalizedHash.get(normalizedHash);
        if (cached) {
          duplicates++;
          results.push(cached);
          continue;
        }
        let result;
        try {
          result = await processTxReceipt(txHash);
        } catch (e: any) {
          const retry = handleRetry(txHash, e);
          if (retry.status === "quarantined") {
            result = { txHash, status: "quarantined", attempts: retry.attempts, error: retry.error };
          } else {
            result = { txHash, status: "error", attempts: retry.attempts, eventsProcessed: 0, eventLabels: [], error: retry.error };
          }

          resultByNormalizedHash.set(normalizedHash, result);
          results.push(result);
          continue;
        }
        resultByNormalizedHash.set(normalizedHash, result);
        results.push(result);
      }

      const totalProcessed = results.reduce((sum, r) => sum + (r.eventsProcessed ?? 0), 0);

      res.json({
        summary: {
          total: results.length,
          processed: results.filter((r) => r.status === "processed").length,
          noEvents: results.filter((r) => r.status === "no_events").length,
          notFound: results.filter((r) => r.status === "not_found").length,
          errors: results.filter((r) => r.status === "error").length,
          totalEventsProcessed: totalProcessed,
          duplicates,
        },
        results,
      });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: e.issues[0]?.message || "Invalid request body" });
        return;
      }
      _next(e);
    } finally {
      releaseReprocessLock();
    }
  });

/** POST /reprocess-events/status-changes */
reprocessEventsRouter.post(
  "/reprocess-events/status-changes",
  requireAuth,
  requireAdmin,
  async (req, res, _next) => {
    if (!acquireReprocessLock()) {
      res.status(409).json({ error: "Reprocessing operation already in progress" });
      return;
    }
    try {
      const { limit, fromBlock, toBlock } = StatusChangesQuerySchema.parse(req.query);
      const evtStart = Date.now();

      // Declare result accumulators up front so helpers can reference them.
      const results: any[] = [];
      let updated = 0;
      const processedKeys = new Set<string>();

      /** Emit a structured telemetry record for status‑changes processing. */
      const logReprocess = (level: "info" | "error", operation: string, data: Record<string, any>) => {
        const entry = {
          timestamp: new Date().toISOString(),
          level,
          module: "reprocess",
          operation,
          ...data,
        };
        if (process.env.LOG_FORMAT === "json") {
          (level === "error" ? console.error : console.info)(JSON.stringify(entry));
        } else {
          console.log(`[reprocess] ${operation} ${JSON.stringify(data)}`);
        }
      };

      /**
       * Record a failure for the current event, applying retry budget and
       * quarantine logic.
       *
       * Uses `attempts >= RETRY_BUDGET` (quarantines on the 3rd failure when
       * budget is 3) because status‑changes events are retried less aggressively
       * than tx-level operations — per-event failures are common during batch
       * reprocessing and we want to move persistently broken events out of the
       * processing path sooner.
       *
       * `status` is one of "no_receipt", "event_not_found", "no_change", or
       * "error". `no_change` is not treated as a retryable failure because it
       * means the event was already correctly typed.
       */
      const handleFailure = (evt: any, status: string, error?: string) => {
        if (status === "no_change") {
          results.push({ eventId: evt.id, status: "no_change", eventType: "AgreementStatusChange" });
          return;
        }

        const eventKey = `${evt.transactionHash}_${evt.eventIndex}`;
        const attempts = (statusChangeRetryCounts.get(eventKey) ?? 0) + 1;
        statusChangeRetryCounts.set(eventKey, attempts);

        if (attempts >= RETRY_BUDGET) {
          statusChangeQuarantine.add(eventKey);
          results.push({ eventId: evt.id, status: "quarantined", reason: status });
          logReprocess("error", "status_changes", {
            eventId: evt.id,
            outcome: "quarantined",
            eventKey,
            reason: status,
            attempts,
            retryBudget: RETRY_BUDGET,
            elapsed_ms: Date.now() - evtStart,
          });
          return;
        }

        const entry: any = { eventId: evt.id, status };
        if (error) entry.error = error;
        results.push(entry);
        logReprocess("info", "status_changes", {
          eventId: evt.id,
          outcome: status,
          eventKey,
          attempts,
          elapsed_ms: Date.now() - evtStart,
        });
      };

      const workAgreementAbi = await getWorkAgreementAbi();
      const payrollEscrowAbi = await getPayrollEscrowAbi();

      const conditions = [eq(schema.agreementEvents.eventType, "AgreementStatusChange")];
      if (fromBlock !== undefined) conditions.push(gte(schema.agreementEvents.blockNumber, fromBlock));
      if (toBlock !== undefined) conditions.push(lte(schema.agreementEvents.blockNumber, toBlock));

      const statusChangeEvents = await db
        .select()
        .from(schema.agreementEvents)
        .where(and(...conditions))
        .orderBy(asc(schema.agreementEvents.blockNumber), asc(schema.agreementEvents.eventIndex))
        .limit(limit);

      for (const event of statusChangeEvents) {
        const dedupKey = `${event.transactionHash}_${event.eventIndex}`;
        if (processedKeys.has(dedupKey)) {
          logReprocess("info", "status_changes", {
            eventId: event.id,
            outcome: "dedup_skipped",
            dedupKey,
            elapsed_ms: Date.now() - evtStart,
          });
          results.push({ eventId: event.id, status: "dedup_skipped" });
          continue;
        }
        processedKeys.add(dedupKey);

        // Skip events that have been quarantined (exceeded retry budget) —
        // no RPC call needed, returned immediately to avoid repeated I/O.
        if (statusChangeQuarantine.has(dedupKey)) {
          results.push({ eventId: event.id, status: "quarantined" });
          logReprocess("info", "status_changes", {
            eventId: event.id,
            outcome: "quarantine_skipped",
            eventKey: dedupKey,
            elapsed_ms: Date.now() - evtStart,
          });
          continue;
        }

        try {
          const receipt = await provider.getTransactionReceipt(event.transactionHash);
          if (!receipt || !("events" in receipt && receipt.events)) {
            handleFailure(event, "no_receipt");
            continue;
          }
          const receiptEvent = receipt.events[event.eventIndex];
          if (!receiptEvent) {
            handleFailure(event, "event_not_found");
            continue;
          }
          const fromAddress = receiptEvent.from_address?.toLowerCase() || "";
          const eventContractAddress = event.contractAddress?.toLowerCase() || fromAddress;
          let decodedEvent: any = null;
          let eventType = "AgreementStatusChange";
          try {
            const workContract = new Contract(workAgreementAbi, eventContractAddress, provider);
            try {
              decodedEvent = workContract.parseEvent(receiptEvent);
              eventType = decodedEvent.name;
            } catch {
              const escrowContract = new Contract(payrollEscrowAbi, eventContractAddress, provider);
              try {
                decodedEvent = escrowContract.parseEvent(receiptEvent);
                eventType = decodedEvent.name;
              } catch {
                const selector = receiptEvent.keys?.[0] || "";
                const map: Record<string, string> = {
                  "0x39935559db9e6f265020b5e7f9e32f707ec95bc7744e4313651be569076f335": "AgreementActivated",
                  "0x2fd23973c113c5a29f0779620b5bee73d19782f53a0d36ab5fb34fee90d61f3": "AgreementPaused",
                  "0xd8daf85c1fa0887e802a145d9f3c7db99b61aa78d5beb5c98ffd0fc8df3d45": "AgreementResumed",
                  "0x191e18e7a94a169e8b312a6640b0c4044d7eff6f223d39c1f71b73d6de1f701": "AgreementCancelled",
                  "0x12be36ac260b6bcaaeb819d1673545d25c1028519a08bb569e0622654c96218": "AgreementCompleted",
                  "0x17babb38579af523049462702ad3f85d2827a23c68e1d9cfdcf6115ad2adcf4": "EmployeeAdded",
                  "0x12e84408ed2be37d5b7d3bb7d832aa3cf1f44f39a1add754c77048fb820f445": "MilestoneAdded",
                  "0x16e453add3d657589b2875d4b5297f7c350b8eea55fecbdd84a5516ed81dc0a": "MilestoneApproved",
                  "0x3bd85f42a3b157753a56c683adb962a9b52ebe31ead396608da3903e9729a27": "MilestoneClaimed",
                  "0xaee5edac2a21de2e1003994d9fe958621235a659a2ea93d7a584ddd70671b3": "PayrollClaimed",
                  "0xad330e12dae484af39764778243710c62245fbdd601ba5122e7200c8bedcee": "DisputeRaised",
                  "0x27eac42673c7b6ad77b281f32dfd605fc2994c6e2ba3bcb526bb46f4eaa636c": "DisputeResolved",
                };
                const normSel = selector.toLowerCase();
                if (map[normSel]) eventType = map[normSel];
              }
            }
          } catch {
            console.log(`[reprocess] Could not parse event ${event.id}, keeping AgreementStatusChange`);
          }
          if (eventType !== "AgreementStatusChange") {
            await db.update(schema.agreementEvents).set({ eventType }).where(eq(schema.agreementEvents.id, event.id));
            updated++;
            results.push({ eventId: event.id, status: "updated", oldType: "AgreementStatusChange", newType: eventType });
          } else {
            handleFailure(event, "no_change");
          }
        } catch (e) {
          handleFailure(event, "error", String(e));
        }
      }

      const hasMore = statusChangeEvents.length === limit;
      res.json({ message: `Reprocessed ${results.length} events, updated ${updated}`, updated, results, hasMore });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: e.issues[0]?.message || "Invalid request parameters" });
        return;
      }
      _next(e);
    } finally {
      releaseReprocessLock();
    }
  });

export default reprocessEventsRouter;

// reprocess-events.ts
import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { provider } from "../starknet/client.js";
import { eq, and, gte, lte, asc } from "drizzle-orm";
import { Contract } from "starknet";
import { defaults, abiPaths } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "../starknet/abi.js";
import { processTxReceipt, TxHashSchema, MAX_BATCH_SIZE } from "./events.js";
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
 * A value of 0 means events are quarantined on the first failure.
 */
export const RETRY_BUDGET = (() => {
  const raw = process.env.RETRY_BUDGET;
  if (raw === undefined) return 3;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 3;
  return Math.floor(parsed);
})();

/** Directory where quarantined transaction hashes are persisted.
 * The path can be overridden with the `QUARANTINE_PATH` environment variable.
 * When not set, a `quarantine` folder is created in the current working directory.
 */
export const QUARANTINE_PATH = process.env.QUARANTINE_PATH
  ? path.resolve(process.env.QUARANTINE_PATH)
  : path.resolve(process.cwd(), "quarantine");

/** In‑memory map tracking retry attempts per normalized transaction hash (batch/tx routes). */
const retryCounts = new Map<string, number>();

/**
 * In-memory retry and quarantine tracking for /status-changes.
 * Events that fail more than MAX_RETRIES times are quarantined and skipped
 * on subsequent calls to avoid endless spinning on unparseable events.
 */
export const MAX_RETRIES = 3;
export const statusChangeRetryCounts = new Map<string, number>();
export const statusChangeQuarantine = new Set<string>();

/**
 * Reset in‑memory status-change retry and quarantine state. Exported for tests.
 */
export function __resetStatusChangeState() {
  statusChangeRetryCounts.clear();
  statusChangeQuarantine.clear();
}

/**
 * Reset in‑memory retry counts. Exported for tests to ensure isolation.
 */
export function __resetRetryCounts() {
  retryCounts.clear();
  statusChangeRetryCounts.clear();
  statusChangeQuarantine.clear();
}

/**
 * Clear retry count for a specific transaction after successful reprocessing.
 * This allows the event to be safely reprocessed fresh if needed later.
 */
function clearRetryCount(txHash: string): void {
  const norm = normaliseHash(txHash);
  retryCounts.delete(norm);
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

/** Normalise a transaction hash to the canonical 0x + 64‑hex form.
 * Uses the same normalization as processTxReceipt for consistency.
 */
function normaliseHash(hash: string): string {
  return normalizeTransactionHash(hash);
}

/** Helper to record a failure and optionally quarantine the transaction.
 * Uses >= comparison: RETRY_BUDGET=3 means 3 failed attempts are allowed,
 * and the 3rd failure triggers quarantine.
 */
function handleRetry(txHash: string, error: any) {
  const norm = normaliseHash(txHash);
  const attempts = (retryCounts.get(norm) ?? 0) + 1;
  retryCounts.set(norm, attempts);
  if (attempts >= RETRY_BUDGET) {
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

/**
 * Structured log helper for the reprocess routes.
 * Emits a JSON line to stdout (info) or stderr (error).
 */
function logReprocess(
  level: "info" | "warn" | "error",
  operation: string,
  meta: Record<string, unknown>,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    operation: `reprocess.${operation}`,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else {
    console.info(line);
  }
}

/** Zod schema for the status‑changes query parameters. */
const StatusChangesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_STATUS_LIMIT).optional().default(100),
  fromBlock: z.coerce.number().int().positive().optional(),
  toBlock: z.coerce.number().int().positive().optional(),
});

/** Lazy‑loaded ABIs for contracts used by status‑changes processing. */
let workAgreementAbi: any[] | null = null;
let payrollEscrowAbi: any[] | null = null;
async function getWorkAgreementAbi(): Promise<any[]> {
  if (!workAgreementAbi) {
    if (!abiPaths.agreement) throw new Error("AGREEMENT_CONTRACT_CLASS_JSON path is not configured");
    workAgreementAbi = loadAbiFromContractClassJsonPath(abiPaths.agreement);
  }
  return workAgreementAbi;
}
async function getPayrollEscrowAbi(): Promise<any[]> {
  if (!payrollEscrowAbi) {
    if (!abiPaths.escrow) throw new Error("ESCROW_CONTRACT_CLASS_JSON path is not configured");
    payrollEscrowAbi = loadAbiFromContractClassJsonPath(abiPaths.escrow);
  }
  return payrollEscrowAbi;
}

/** In-memory map tracking retry attempts per event ID for status-changes processing. */
const statusChangeRetryCounts = new Map<string, number>();

/** In-memory set of quarantined event IDs for status-changes processing. */
const statusChangeQuarantine = new Set<string>();

/**
 * Reset in-memory retry counts for status-changes. Exported for tests.
 */
export function __resetStatusChangeRetryCounts() {
  statusChangeRetryCounts.clear();
}

/**
 * Reset in-memory quarantine set for status-changes. Exported for tests.
 */
export function __resetStatusChangeQuarantine() {
  statusChangeQuarantine.clear();
}

/**
 * Log reprocessing telemetry for status-changes.
 */
function logReprocess(level: string, operation: string, data: Record<string, unknown>): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    operation,
    ...data,
  };
  if (level === "error") {
    console.error(JSON.stringify(logEntry));
  } else {
    console.log(JSON.stringify(logEntry));
  }
}

/**
 * Handle a failure during status-changes reprocessing.
 * Tracks retries and moves events to quarantine when budget is exhausted.
 */
function handleFailure(
  eventId: string,
  reason: string,
): { eventId: string; status: "quarantined" | "no_receipt" | "event_not_found" | "no_change" | "error"; reason?: string } {
  // If already quarantined, return immediately without incrementing count
  if (statusChangeQuarantine.has(eventId)) {
    return { eventId, status: "quarantined" };
  }

  const attempts = (statusChangeRetryCounts.get(eventId) ?? 0) + 1;
  statusChangeRetryCounts.set(eventId, attempts);

  if (attempts >= RETRY_BUDGET) {
    statusChangeQuarantine.add(eventId);
    // Write quarantine file
    try {
      fs.mkdirSync(QUARANTINE_PATH, { recursive: true });
      const filePath = path.join(QUARANTINE_PATH, `${eventId}.json`);
      fs.writeFileSync(filePath, JSON.stringify({ eventId, reason, attempts }, null, 2));
    } catch (e) {
      console.error("[reprocess] Failed to write quarantine file for event", e);
    }
    return { eventId, status: "quarantined", reason };
  }

  // Return appropriate status based on reason (no reason field for non-quarantined failures)
  const statusMap: Record<string, "no_receipt" | "event_not_found" | "no_change" | "error"> = {
    no_receipt: "no_receipt",
    event_not_found: "event_not_found",
    no_change: "no_change",
    error: "error",
  };
  return { eventId, status: statusMap[reason] ?? "error" };
}

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
       clearRetryCount(tx_hash);
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
      // For non‑quarantined errors, include attempt count for backward compatibility info
      res.status(500).json({ attempts: retry.attempts, error: retry.error });
      return;
} finally {
       releaseReprocessLock();
     }
  },
);

/** POST /reprocess-events/batch */
reprocessEventsRouter.post(
  "/reprocess-events/batch",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
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
        const normalizedHash = normaliseHash(txHash);
        const cached = resultByNormalizedHash.get(normalizedHash);
        if (cached) {
          duplicates++;
          results.push(cached);
          continue;
        }
        let result;
        try {
          result = await processTxReceipt(txHash);
          clearRetryCount(txHash);
        } catch (e: any) {
          const retry = handleRetry(txHash, e);
          if (retry.status === "quarantined") {
            result = { txHash, status: "quarantined", attempts: retry.attempts, error: retry.error };
          } else {
            result = {
              txHash,
              status: "error",
              attempts: retry.attempts,
              eventsProcessed: 0,
              eventLabels: [],
              error: retry.error,
            };
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
      next(e);
} finally {
       releaseReprocessLock();
     }
  },
);

/** POST /reprocess-events/status-changes */
reprocessEventsRouter.post(
  "/reprocess-events/status-changes",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    if (!acquireReprocessLock()) {
      res.status(409).json({ error: "Reprocessing operation already in progress" });
      return;
    }
    try {
      const { limit, fromBlock, toBlock } = StatusChangesQuerySchema.parse(req.query);

      const workAgreementAbiResolved = await getWorkAgreementAbi();
      const payrollEscrowAbiResolved = await getPayrollEscrowAbi();
      const workAgreementAddress = defaults.workAgreementAddress.toLowerCase();
      const payrollEscrowAddress = defaults.payrollEscrowAddress.toLowerCase();

      const workAgreementContract = new Contract(workAgreementAbiResolved, workAgreementAddress, provider);
      const payrollEscrowContract = new Contract(payrollEscrowAbiResolved, payrollEscrowAddress, provider);
      void workAgreementContract; // used for ABI loading side-effect; per-event contracts created below
      void payrollEscrowContract;

      const conditions = [eq(schema.agreementEvents.eventType, "AgreementStatusChange")];
      if (fromBlock !== undefined) conditions.push(gte(schema.agreementEvents.blockNumber, fromBlock));
      if (toBlock !== undefined) conditions.push(lte(schema.agreementEvents.blockNumber, toBlock));

      const statusChangeEvents = await db
        .select()
        .from(schema.agreementEvents)
        .where(and(...conditions))
        .orderBy(asc(schema.agreementEvents.blockNumber), asc(schema.agreementEvents.eventIndex))
        .limit(limit);

      const results: any[] = [];
      let updated = 0;
      const processedKeys = new Set<string>();

      for (const event of statusChangeEvents) {
        const evtStart = Date.now();
        const dedupKey = `${event.transactionHash}_${event.eventIndex}`;
        if (processedKeys.has(dedupKey)) {
          results.push({ eventId: event.id, status: "dedup_skipped" });
          continue;
        }
        processedKeys.add(dedupKey);

        const handleFailure = (status: string, errorMsg?: string) => {
          const attempts = (statusChangeRetryCounts.get(event.id) || 0) + 1;
          if (attempts >= MAX_RETRIES) {
            statusChangeQuarantine.add(event.id);
            statusChangeRetryCounts.delete(event.id);
            results.push({ eventId: event.id, status: "quarantined", reason: status, ...(errorMsg ? { error: errorMsg } : {}) });
          } else {
            statusChangeRetryCounts.set(event.id, attempts);
            results.push({ eventId: event.id, status, ...(errorMsg ? { error: errorMsg } : {}) });
          }
        };

        try {
          const receipt = await provider.getTransactionReceipt(event.transactionHash);
          if (!receipt || !("events" in receipt && receipt.events)) {
            const failure = handleFailure(event.id, "no_receipt");
            results.push(failure);
            continue;
          }
          const receiptEvent = receipt.events[event.eventIndex];
          if (!receiptEvent) {
            const failure = handleFailure(event.id, "event_not_found");
            results.push(failure);
            continue;
          }
          const fromAddress = receiptEvent.from_address?.toLowerCase() || "";
          const eventContractAddress = event.contractAddress?.toLowerCase() || fromAddress;
          let decodedEvent: any = null;
          let eventType = "AgreementStatusChange";
          try {
            const workContract = new Contract(workAgreementAbiResolved, eventContractAddress, provider);
            try {
              decodedEvent = workContract.parseEvent(receiptEvent);
              eventType = decodedEvent.name;
            } catch {
              const escrowContract = new Contract(payrollEscrowAbiResolved, eventContractAddress, provider);
              try {
                decodedEvent = escrowContract.parseEvent(receiptEvent);
                eventType = decodedEvent.name;
              } catch {
                const selector = receiptEvent.keys?.[0] || "";
                const selectorMap: Record<string, string> = {
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
                if (selectorMap[normSel]) eventType = selectorMap[normSel];
              }
            }
          } catch {
            console.log(`[reprocess] Could not parse event ${event.id}, keeping AgreementStatusChange`);
          }
          if (eventType !== "AgreementStatusChange") {
            await db.update(schema.agreementEvents).set({ eventType }).where(eq(schema.agreementEvents.id, event.id));
            statusChangeRetryCounts.delete(event.id);
            updated++;
            logReprocess("info", "status_changes", {
              eventId: event.id,
              outcome: "updated",
              newType: eventType,
              elapsed_ms: Date.now() - evtStart,
            });
            results.push({ eventId: event.id, status: "updated", oldType: "AgreementStatusChange", newType: eventType });
          } else {
            const failure = handleFailure(event.id, "no_change");
            results.push(failure);
          }
        } catch (e: any) {
          const failure = handleFailure(event.id, "error");
          failure.error = e?.message ?? String(e);
          results.push(failure);
        }
      }

      const hasMore = statusChangeEvents.length === limit;
      res.json({
        message: `Reprocessed ${results.length} events, updated ${updated}`,
        updated,
        results,
        hasMore,
      });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        res.status(400).json({ error: e.issues[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    } finally {
      releaseReprocessLock();
    }
  });

export default reprocessEventsRouter;

import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, gte, lte, inArray, desc, SQL } from "drizzle-orm";
import { provider, agreementContract, escrowContract } from "../starknet/client.js";
import { toHexString } from "../utils/codec.js";
import { normalizeStarknetAddress as normalizeAddress } from "../utils/address.js";
import { defaults } from "../config.js";
import { notFoundResponse } from "./not-found.js";
import { parsePagination } from "../utils/validation.js";

/** Maximum number of tx hashes accepted by process_batch in a single request. */
export const MAX_BATCH_SIZE = 50;

/**
 * Zod schema for a Starknet transaction hash.
 * Accepts the canonical 0x-prefixed hex form (up to 66 chars) as well as the
 * un-padded variant emitted by some RPC providers.
 */
export const TxHashSchema = z
  .string()
  .min(3)
  .max(66)
  .regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid Starknet transaction hash format");

/**
 * Envelope schema for batch processing of Starknet transaction receipts.
 * Validates a non-empty array of Starknet transaction hashes bounded by MAX_BATCH_SIZE.
 */
export const BatchProcessEnvelopeSchema = z.object({
  tx_hashes: z
    .array(TxHashSchema)
    .min(1, "tx_hashes must contain at least one hash")
    .max(
      MAX_BATCH_SIZE,
      `tx_hashes must contain at most ${MAX_BATCH_SIZE} hashes per request`,
    ),
});

export const eventsRouter = Router();

/**
 * Normalize a Starknet transaction hash to the canonical 0x + 64-hex form.
 * If the hash is already 66 chars, it is returned as-is to preserve leading
 * zeros; otherwise the hex part is left-padded to 64 characters.
 */
export function normalizeTransactionHash(hash: string): string {
  if (!hash) return "";
  let normalized = hash.toLowerCase().trim();
  if (!normalized.startsWith("0x")) {
    normalized = `0x${normalized}`;
  }

  // If already 66 chars (0x + 64 hex), return as-is (preserves leading zeros)
  if (normalized.length === 66) {
    return normalized;
  }

  // Otherwise, pad to 64 hex characters
  const hex = normalized.replace(/^0x/, "");
  const paddedHex = hex.padStart(64, "0");
  return `0x${paddedHex}`;
}


// ---------------------------------------------------------------------------
// Shared per-receipt processor
// ---------------------------------------------------------------------------

/**
 * Result returned by {@link processTxReceipt} for a single transaction.
 */
export interface TxProcessResult {
  /** Normalised (0x + 64-hex) transaction hash that was processed. */
  txHash: string;
  /**
   * - `"processed"` – receipt was fetched and events were decoded/stored.
   * - `"no_events"` – receipt exists but contained no decodable events.
   * - `"not_found"` – provider returned no receipt for this hash.
   * - `"error"`     – an unexpected error occurred.
   */
  status: "processed" | "no_events" | "not_found" | "error";
  /** Number of event items persisted (agreement/payment/escrow rows). */
  eventsProcessed: number;
  /** Human-readable labels of every event that was persisted. */
  eventLabels: string[];
  /**
   * For a receipt containing one or more `AgreementCreated` events, whether the
   * on-chain token verification completed for all of them. `true` when every
   * agreement's token was checked against the contract (and corrected on
   * mismatch), `false` when at least one check could not be completed, and
   * `undefined` when the receipt had no `AgreementCreated` event.
   */
  tokenVerified?: boolean;
  /** Present only when status === "error". */
  error?: string;
}

/**
 * Verify an agreement's token against the on-chain contract and correct the
 * stored row when they disagree. The on-chain value is authoritative, so a
 * mismatched event token is overwritten here before the caller responds.
 *
 * Errors are caught and reported through the return value rather than left as a
 * floating promise rejection.
 *
 * @param agreementId - The agreement whose token is being verified.
 * @param contractAddress - The WorkAgreement contract that emitted the event.
 * @param eventToken - The normalized token taken from the event payload.
 * @returns `true` when the on-chain token was read and the stored row reflects
 *   it, `false` when the contract call or update failed.
 */
async function verifyAndUpdateToken(
  agreementId: string,
  contractAddress: string,
  eventToken: string,
): Promise<boolean> {
  try {
    const contract = agreementContract(contractAddress);
    const contractToken = await contract.get_token(agreementId);
    const normalizedContractToken = normalizeAddress(toHexString(contractToken));

    if (normalizedContractToken !== eventToken) {
      await db
        .update(schema.agreements)
        .set({ token: normalizedContractToken, updatedAt: new Date() })
        .where(eq(schema.agreements.id, agreementId));
    }
    return true;
  } catch (err: any) {
    console.error(`[events] Token verification failed for agreement ${agreementId}:`, err?.message);
    return false;
  }
}

/**
 * Fetch the on-chain receipt for `txHash`, decode every StarkNet event using
 * the WorkAgreement and PayrollEscrow ABIs, and persist the results to the
 * database with `onConflictDoNothing` so the operation is idempotent.
 *
 * This function is the single source of truth for event decoding and
 * persistence; both `POST /events/process_tx/:tx_hash` and
 * `POST /events/process_batch` delegate to it.
 *
 * @param txHash - Raw transaction hash (will be normalised internally).
 * @returns A {@link TxProcessResult} describing what was stored.
 */
export async function processTxReceipt(txHash: string): Promise<TxProcessResult> {
  const normalizedTxHash = normalizeTransactionHash(txHash);

  // ------------------------------------------------------------------
  // 1. Fetch receipt – try normalised hash first, then un-padded fallback
  // ------------------------------------------------------------------
  let receipt: any;
  try {
    receipt = await provider.getTransactionReceipt(normalizedTxHash);
  } catch (error: any) {
    const hex = normalizedTxHash.replace(/^0x/, "");
    const withoutLeadingZeros = `0x${hex.replace(/^0+/, "")}`;
    if (withoutLeadingZeros !== normalizedTxHash && withoutLeadingZeros.length >= 3) {
      try {
        receipt = await provider.getTransactionReceipt(withoutLeadingZeros);
      } catch {
        // Both forms failed – re-throw the original error
        receipt = await provider.getTransactionReceipt(normalizedTxHash);
      }
    } else {
      throw error;
    }
  }

  if (!receipt) {
    return { txHash: normalizedTxHash, status: "not_found", eventsProcessed: 0, eventLabels: [] };
  }

  if (!("events" in receipt && receipt.events && receipt.events.length > 0)) {
    return { txHash: normalizedTxHash, status: "no_events", eventsProcessed: 0, eventLabels: [] };
  }

  // ------------------------------------------------------------------
  // 2. Resolve block number
  // ------------------------------------------------------------------
  let blockNumber = 0;
  if ("blockNumber" in receipt && receipt.blockNumber) {
    blockNumber =
      typeof receipt.blockNumber === "number" ? receipt.blockNumber : Number(receipt.blockNumber);
  } else if ("block_number" in receipt && receipt.block_number) {
    blockNumber =
      typeof receipt.block_number === "number"
        ? receipt.block_number
        : Number(receipt.block_number);
  }

  // ------------------------------------------------------------------
  // 3. Prepare ABI contract instances for event parsing (cached singletons)
  // ------------------------------------------------------------------
  const workAgreementAddress = defaults.workAgreementAddress.toLowerCase();
  const payrollEscrowAddress = defaults.payrollEscrowAddress.toLowerCase();

  const workAgreementContract = agreementContract(workAgreementAddress);
  const payrollEscrowContract = escrowContract(payrollEscrowAddress);

  const eventLabels: string[] = [];

  // Token verification outcome across any AgreementCreated events in this tx.
  let sawAgreementCreated = false;
  let allTokensVerified = true;

  // ------------------------------------------------------------------
  // 4. Decode and persist each event
  // ------------------------------------------------------------------
  for (let i = 0; i < receipt.events.length; i++) {
    const event = receipt.events[i];
    const fromAddress = event.from_address?.toLowerCase() || "";
    const eventData: string[] = event.data || [];

    if (!fromAddress || eventData.length === 0) continue;

    let decodedEvent: any = null;
    let eventType = "Unknown";
    let agreementId: string | null = null;

    // Try ABI-based decoding first
    try {
      if (fromAddress === workAgreementAddress) {
        decodedEvent = workAgreementContract.parseEvent(event);
        eventType = decodedEvent.name;
      } else if (fromAddress === payrollEscrowAddress) {
        decodedEvent = payrollEscrowContract.parseEvent(event);
        eventType = decodedEvent.name;
      }
    } catch {
      console.log(
        `[events] Could not parse event ${i} from ${fromAddress} via ABI, falling back to heuristics`,
      );
    }

    // Extract agreement_id from decoded event or raw data
    if (decodedEvent?.data) {
      agreementId =
        decodedEvent.data.agreement_id?.toString() ||
        decodedEvent.data.agreementId?.toString() ||
        (eventData.length > 0 ? BigInt(eventData[0]).toString() : null);
    } else if (eventData.length > 0) {
      try {
        agreementId = BigInt(eventData[0]).toString();
      } catch {
        /* non-numeric first field – skip */
      }
    }

    // ----------------------------------------------------------------
    // 4a. ABI-decoded path
    // ----------------------------------------------------------------
    if (decodedEvent && eventType !== "Unknown" && agreementId) {
      // Agreement lifecycle events
      if (
        [
          "AgreementCreated",
          "AgreementActivated",
          "AgreementPaused",
          "AgreementResumed",
          "AgreementCancelled",
          "AgreementCompleted",
          "EmployeeAdded",
          "MilestoneAdded",
          "MilestoneApproved",
          "MilestoneClaimed",
          "PayrollClaimed",
          "DisputeRaised",
          "DisputeResolved",
        ].includes(eventType)
      ) {
        try {
          await db
            .insert(schema.agreementEvents)
            .values({
              id: `${normalizedTxHash}_${i}`,
              agreementId,
              contractAddress: fromAddress,
              eventType,
              blockNumber: Number(blockNumber),
              transactionHash: normalizedTxHash,
              eventIndex: i,
            })
            .onConflictDoNothing();

          // On AgreementCreated, also upsert the agreements row
          if (eventType === "AgreementCreated" && decodedEvent.data) {
            const employer = normalizeAddress(
              toHexString(BigInt(decodedEvent.data.employer || eventData[1])),
            );
            const contributor = decodedEvent.data.contributor
              ? normalizeAddress(toHexString(BigInt(decodedEvent.data.contributor || eventData[2])))
              : null;
            const tokenFromEvent = normalizeAddress(
              toHexString(BigInt(decodedEvent.data.token || eventData[3])),
            );
            const mode = Number(decodedEvent.data.mode || eventData[4] || 0);
            const paymentType = Number(
              decodedEvent.data.payment_type || decodedEvent.data.paymentType || eventData[5] || 0,
            );

            await db
              .insert(schema.agreements)
              .values({
                id: agreementId,
                contractAddress: fromAddress,
                employer,
                contributor: contributor || null,
                token: tokenFromEvent,
                mode,
                paymentType,
                status: 0,
                totalAmount: "0",
                paidAmount: "0",
                disputeStatus: 0,
                blockNumber: Number(blockNumber),
                transactionHash: normalizedTxHash,
              })
              .onConflictDoUpdate({
                target: schema.agreements.id,
                set: { updatedAt: new Date() },
              });

            // Verify the token against the on-chain contract before responding.
            // Awaited, not fire and forget, so the authoritative on-chain value
            // settles the stored row before process_tx returns.
            sawAgreementCreated = true;
            const verified = await verifyAndUpdateToken(agreementId, fromAddress, tokenFromEvent);
            if (!verified) allTokensVerified = false;
          }

          eventLabels.push(`${eventType}-${agreementId}`);
        } catch (e) {
          console.error(`[events] Failed to store ${eventType}:`, e);
        }
      }

      // Payment events
      else if (["PaymentSent", "PaymentReceived"].includes(eventType) && decodedEvent.data) {
        try {
          const from = normalizeAddress(
            toHexString(BigInt(decodedEvent.data.from || eventData[1])),
          );
          const to = normalizeAddress(toHexString(BigInt(decodedEvent.data.to || eventData[2])));
          const amount = decodedEvent.data.amount
            ? typeof decodedEvent.data.amount === "object" &&
              decodedEvent.data.amount.low &&
              decodedEvent.data.amount.high
              ? (
                  BigInt(decodedEvent.data.amount.low) +
                  (BigInt(decodedEvent.data.amount.high) << 128n)
                ).toString()
              : decodedEvent.data.amount.toString()
            : eventData.length >= 4
              ? BigInt(eventData[3]).toString()
              : "0";
          const token = normalizeAddress(
            toHexString(BigInt(decodedEvent.data.token || eventData[4] || eventData[2])),
          );

          await db
            .insert(schema.payments)
            .values({
              id: `${normalizedTxHash}_${i}`,
              agreementId,
              contractAddress: fromAddress,
              from,
              to,
              amount,
              token,
              eventType,
              blockNumber: Number(blockNumber),
              transactionHash: normalizedTxHash,
            })
            .onConflictDoNothing();

          eventLabels.push(`${eventType}-${agreementId}`);
        } catch (e) {
          console.error(`[events] Failed to store payment event:`, e);
        }
      }

      // Escrow events
      else if (["Funded", "Released", "Refunded"].includes(eventType) && decodedEvent.data) {
        try {
          const employer = decodedEvent.data.employer
            ? normalizeAddress(toHexString(BigInt(decodedEvent.data.employer)))
            : "";
          const to = decodedEvent.data.to
            ? normalizeAddress(toHexString(BigInt(decodedEvent.data.to)))
            : null;
          const amount = decodedEvent.data.amount
            ? typeof decodedEvent.data.amount === "object" &&
              decodedEvent.data.amount.low &&
              decodedEvent.data.amount.high
              ? (
                  BigInt(decodedEvent.data.amount.low) +
                  (BigInt(decodedEvent.data.amount.high) << 128n)
                ).toString()
              : decodedEvent.data.amount.toString()
            : eventData.length >= 3
              ? BigInt(eventData[2]).toString()
              : "0";

          await db
            .insert(schema.escrowEvents)
            .values({
              id: `${normalizedTxHash}_${i}`,
              agreementId,
              contractAddress: fromAddress,
              eventType,
              employer: eventType === "Funded" ? employer : "",
              to: eventType !== "Funded" ? to : null,
              amount,
              blockNumber: Number(blockNumber),
              transactionHash: normalizedTxHash,
            })
            .onConflictDoNothing();

          eventLabels.push(`${eventType}-${agreementId}`);
        } catch (e) {
          console.error(`[events] Failed to store escrow event:`, e);
        }
      }
    }

    // ----------------------------------------------------------------
    // 4b. Heuristic fallback (ABI decoding unavailable)
    // ----------------------------------------------------------------
    else if (eventData.length >= 6) {
      try {
        const hAgreementId = BigInt(eventData[0]).toString();
        const employer = normalizeAddress(toHexString(BigInt(eventData[1])));
        const contributor = eventData[2]
          ? normalizeAddress(toHexString(BigInt(eventData[2])))
          : null;
        const token = normalizeAddress(toHexString(BigInt(eventData[3])));
        const mode = Number(eventData[4]);
        const paymentType = Number(eventData[5]);

        await db
          .insert(schema.agreementEvents)
          .values({
            id: `${normalizedTxHash}_${i}`,
            agreementId: hAgreementId,
            contractAddress: fromAddress,
            eventType: "AgreementCreated",
            blockNumber: Number(blockNumber),
            transactionHash: normalizedTxHash,
            eventIndex: i,
          })
          .onConflictDoNothing();

        await db
          .insert(schema.agreements)
          .values({
            id: hAgreementId,
            contractAddress: fromAddress,
            employer,
            contributor: contributor || null,
            token,
            mode,
            paymentType,
            status: 0,
            totalAmount: "0",
            paidAmount: "0",
            disputeStatus: 0,
            blockNumber: Number(blockNumber),
            transactionHash: normalizedTxHash,
          })
          .onConflictDoUpdate({
            target: schema.agreements.id,
            set: { updatedAt: new Date() },
          });

        eventLabels.push(`AgreementCreated-${hAgreementId}`);
      } catch (e) {
        console.error(`[events] Failed to store heuristic AgreementCreated:`, e);
      }
    }
  }

  return {
    txHash: normalizedTxHash,
    status: "processed",
    eventsProcessed: eventLabels.length,
    eventLabels,
    tokenVerified: sawAgreementCreated ? allTokensVerified : undefined,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /events/process_tx/:tx_hash
 *
 * Process a single Starknet transaction: fetch its receipt, decode all events
 * using the on-chain ABIs, and persist them to the database.
 *
 * **Authentication:** Requires an active admin session (`requireAuth` +
 * `requireAdmin`). Ingestion writes `agreements`/`agreementEvents`/`payments`/
 * `escrowEvents` rows for whatever tx hash the caller supplies and can
 * overwrite a stored agreement's `token` from the on-chain value — matching
 * the admin-only gate already used by the sibling ingestion routes in
 * `backfill-events.ts` and `reprocess-events.ts`.
 */
eventsRouter.post("/events/process_tx/:tx_hash", requireAuth, async (req, res, next) => {
  try {
    const { tx_hash } = z.object({ tx_hash: TxHashSchema }).parse(req.params);

      const result = await processTxReceipt(tx_hash);

    if (result.status === "not_found") {
      notFoundResponse(res, "Transaction not found");
      return;
    }

    if (result.status === "no_events") {
      res.json({ message: "No events found in transaction", eventsProcessed: 0 });
      return;
    }

    res.json({
      message: `Processed ${result.eventsProcessed} events`,
      eventsProcessed: result.eventsProcessed,
      transactionHash: result.txHash,
      tokenVerified: result.tokenVerified,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid Starknet transaction hash format" });
      return;
    }
    next(e);
  }
});

/**
 * POST /events/process_batch
 *
 * Process multiple Starknet transactions in a single request.  Each *unique*
 * tx hash is decoded and persisted independently using the same logic as
 * `process_tx/:tx_hash` so the operation is fully idempotent – re-submitting
 * the same batch produces no duplicate rows.
 *
 * **Validation**
 * - `tx_hashes` must be a non-empty array of valid Starknet tx hash strings.
 * - A maximum of {@link MAX_BATCH_SIZE} hashes is accepted per request to
 *   prevent unbounded RPC calls and DB writes.
 *
 * **Within-request deduplication**
 * Hashes are normalised (see {@link normalizeTransactionHash}) and any hash
 * that has already appeared earlier in the same `tx_hashes` array is *not*
 * re-fetched or re-processed – the result from its first occurrence is reused.
 * This avoids redundant RPC calls and keeps the response `summary` accurate
 * when a batch contains repeated/duplicated deliveries of the same tx. The
 * `results` array still has one entry per input hash, in the same order, so
 * `results[i]` always corresponds to `tx_hashes[i]`. The count of duplicate
 * occurrences is reported as `summary.duplicates`.
 *
 * **Response**
 * Returns a `results` array where each entry corresponds to one tx hash and
 * contains `{ txHash, status, eventsProcessed, eventLabels?, error? }`.
 * A per-tx error never aborts the rest of the batch.
 *
 * **Authentication:** Requires an active admin session (`requireAuth` +
 * `requireAdmin`) — see the note on `process_tx/:tx_hash` above; the same
 * privileged ingestion capability applies per tx hash in the batch.
 */
eventsRouter.post(
  "/events/process_batch",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { tx_hashes } = BatchProcessEnvelopeSchema.parse(req.body);

      // Deduplicate unique hashes while preserving the first raw hash representation
      const uniqueEntriesMap = new Map<string, string>();
      for (const rawHash of tx_hashes) {
        const normalized = normalizeTransactionHash(rawHash);
        if (!uniqueEntriesMap.has(normalized)) {
          uniqueEntriesMap.set(normalized, rawHash);
        }
      }

      // Concurrent fan-out processing across unique receipts to eliminate sequential bottlenecks
      const uniqueResults = await Promise.all(
        Array.from(uniqueEntriesMap.entries()).map(async ([normalized, rawHash]) => {
          try {
            const result = await processTxReceipt(rawHash);
            return [normalized, result] as const;
          } catch (e: any) {
            const errorResult: TxProcessResult = {
              txHash: rawHash,
              status: "error",
              eventsProcessed: 0,
              eventLabels: [],
              error: e?.message ?? String(e),
            };
            return [normalized, errorResult] as const;
          }
        }),
      );

      const resultsByNormalizedHash = new Map<string, TxProcessResult>(uniqueResults);

      const results: TxProcessResult[] = [];
      let duplicates = 0;
      const seenHashes = new Set<string>();

      for (const txHash of tx_hashes) {
        const normalized = normalizeTransactionHash(txHash);
        if (seenHashes.has(normalized)) {
          duplicates++;
        } else {
          seenHashes.add(normalized);
        }
        results.push(resultsByNormalizedHash.get(normalized)!);
      }

      const uniqueResultsList = Array.from(resultsByNormalizedHash.values());
      const totalProcessed = uniqueResultsList.reduce((sum, r) => sum + r.eventsProcessed, 0);

      res.json({
        summary: {
          total: results.length,
          processed: uniqueResultsList.filter((r) => r.status === "processed").length,
          noEvents: uniqueResultsList.filter((r) => r.status === "no_events").length,
          notFound: uniqueResultsList.filter((r) => r.status === "not_found").length,
          errors: uniqueResultsList.filter((r) => r.status === "error").length,
          duplicates,
          totalEventsProcessed: totalProcessed,
        },
        results,
      });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Parse an `eventType` query parameter into a clean array of event type strings.
 * Supports single strings ("AgreementCreated"), comma-separated values
 * ("AgreementCreated,PaymentSent"), or multiple query parameters (`?eventType=A&eventType=B`).
 */
export function parseEventTypeQuery(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const result: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const parts = item.split(",").map((s) => s.trim()).filter(Boolean);
      result.push(...parts);
    }
  }
  return Array.from(new Set(result));
}

/**
 * Parse a `from` or `to` timestamp query parameter into a valid JavaScript `Date` object.
 * Accepts ISO 8601 strings or numeric timestamp strings.
 *
 * @throws {z.ZodError} If the timestamp format is malformed or invalid.
 */
export function parseTimestampQuery(raw: unknown, paramName: string): Date | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;

  let date: Date;
  if (typeof raw === "number") {
    date = new Date(raw < 10000000000 ? raw * 1000 : raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      // Handles 10-digit epoch timestamps (seconds) vs 13-digit (milliseconds)
      date = new Date(num < 10000000000 ? num * 1000 : num);
    } else {
      date = new Date(trimmed);
    }
  } else {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [paramName],
        message: `Invalid timestamp format for parameter '${paramName}'`,
      },
    ]);
  }

  if (isNaN(date.getTime())) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [paramName],
        message: `Invalid timestamp format for parameter '${paramName}'`,
      },
    ]);
  }

  return date;
}

/**
 * Validates that `from` timestamp is less than or equal to `to` timestamp.
 *
 * @throws {z.ZodError} If `from` is strictly after `to`.
 */
export function validateTimeRange(from?: Date, to?: Date): void {
  if (from && to && from.getTime() > to.getTime()) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "from timestamp must be less than or equal to to timestamp",
      },
    ]);
  }
}

/**
 * GET /events
 *
 * Fetch indexed agreement events with optional filtering by event type, time range,
 * agreement ID, or contract address, pushed down into database queries with pagination.
 *
 * Query parameters:
 * - `eventType`: single string, comma-separated string, or repeated parameter
 * - `from`: ISO 8601 or numeric timestamp for start bound (inclusive: createdAt >= from)
 * - `to`: ISO 8601 or numeric timestamp for end bound (inclusive: createdAt <= to)
 * - `agreement_id` / `agreementId`: optional filter by agreement ID
 * - `contract_address` / `contractAddress`: optional filter by contract address
 * - `limit`, `offset`: standard pagination parameters (via parsePagination)
 */
eventsRouter.get("/events", async (req, res, next) => {
  try {
    const eventTypes = parseEventTypeQuery(req.query.eventType);
    const fromDate = parseTimestampQuery(req.query.from, "from");
    const toDate = parseTimestampQuery(req.query.to, "to");
    validateTimeRange(fromDate, toDate);

    const { limit, offset } = parsePagination(req.query);

    const rawAgreementId = req.query.agreement_id ?? req.query.agreementId;
    const agreementId = rawAgreementId ? String(rawAgreementId).trim() : undefined;

    const rawContractAddr = req.query.contract_address ?? req.query.contractAddress;
    const contractAddress = rawContractAddr ? String(rawContractAddr).trim().toLowerCase() : undefined;

    const conditions: SQL[] = [];

    if (eventTypes.length > 0) {
      conditions.push(inArray(schema.agreementEvents.eventType, eventTypes));
    }
    if (fromDate) {
      conditions.push(gte(schema.agreementEvents.createdAt, fromDate));
    }
    if (toDate) {
      conditions.push(lte(schema.agreementEvents.createdAt, toDate));
    }
    if (agreementId) {
      conditions.push(eq(schema.agreementEvents.agreementId, agreementId));
    }
    if (contractAddress) {
      conditions.push(eq(schema.agreementEvents.contractAddress, contractAddress));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const events = await db
      .select()
      .from(schema.agreementEvents)
      .where(whereClause)
      .orderBy(desc(schema.agreementEvents.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      events,
      count: events.length,
      limit,
      offset,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      res.status(400).json({
        error: "Validation failed",
        details: e.issues,
      });
      return;
    }
    next(e);
  }
});


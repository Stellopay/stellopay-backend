import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { provider } from "../starknet/client.js";
import { toHexString, u256ToString } from "../utils/codec.js";
import { normalizeStarknetAddress as normalizeAddress } from "../utils/address.js";
import { shortString, Contract } from "starknet";
import { defaults, abiPaths } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "../starknet/abi.js";
import { agreementContract } from "../starknet/client.js";

const AddressParam = z.string().min(3);

/** Maximum number of tx hashes accepted by process_batch in a single request. */
const MAX_BATCH_SIZE = 50;

/**
 * Zod schema for a Starknet transaction hash.
 * Accepts the canonical 0x-prefixed hex form (up to 66 chars) as well as the
 * un-padded variant emitted by some RPC providers.
 */
const TxHashSchema = z
  .string()
  .min(3)
  .max(66)
  .regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid Starknet transaction hash format");

export const eventsRouter = Router();

/**
 * Normalize a Starknet transaction hash to the canonical 0x + 64-hex form.
 * If the hash is already 66 chars, it is returned as-is to preserve leading
 * zeros; otherwise the hex part is left-padded to 64 characters.
 */
function normalizeTransactionHash(hash: string): string {
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

// Load contract ABIs (lazy-cached singletons)
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
  /** Present only when status === "error". */
  error?: string;
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
  // 3. Prepare ABI contract instances for event parsing
  // ------------------------------------------------------------------
  const wAgreementAbi = await getWorkAgreementAbi();
  const pEscrowAbi = await getPayrollEscrowAbi();
  const workAgreementAddress = defaults.workAgreementAddress.toLowerCase();
  const payrollEscrowAddress = defaults.payrollEscrowAddress.toLowerCase();

  const workAgreementContract = new Contract(wAgreementAbi, workAgreementAddress, provider);
  const payrollEscrowContract = new Contract(pEscrowAbi, payrollEscrowAddress, provider);

  const eventLabels: string[] = [];

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
              ? normalizeAddress(
                  toHexString(BigInt(decodedEvent.data.contributor || eventData[2])),
                )
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

            // Async token verification (non-blocking, best-effort)
            (async () => {
              try {
                console.log(
                  `[events] Verifying token for agreement ${agreementId} from contract ${fromAddress}`,
                );
                const c = agreementContract(fromAddress);
                const contractToken = await c.get_token(agreementId);
                const normalizedContractToken = normalizeAddress(toHexString(contractToken));

                if (normalizedContractToken !== tokenFromEvent) {
                  console.log(
                    `[events] Token mismatch for agreement ${agreementId}: updating ${tokenFromEvent} → ${normalizedContractToken}`,
                  );
                  await db
                    .update(schema.agreements)
                    .set({ token: normalizedContractToken, updatedAt: new Date() })
                    .where(eq(schema.agreements.id, agreementId!));
                } else {
                  console.log(`[events] Token verified for agreement ${agreementId}`);
                }
              } catch (err: any) {
                console.error(
                  `[events] Token verification failed for agreement ${agreementId}:`,
                  err?.message,
                );
              }
            })();
          }

          eventLabels.push(`${eventType}-${agreementId}`);
        } catch (e) {
          console.error(`[events] Failed to store ${eventType}:`, e);
        }
      }

      // Payment events
      else if (
        ["PaymentSent", "PaymentReceived"].includes(eventType) &&
        decodedEvent.data
      ) {
        try {
          const from = normalizeAddress(
            toHexString(BigInt(decodedEvent.data.from || eventData[1])),
          );
          const to = normalizeAddress(
            toHexString(BigInt(decodedEvent.data.to || eventData[2])),
          );
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
      else if (
        ["Funded", "Released", "Refunded"].includes(eventType) &&
        decodedEvent.data
      ) {
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
 */
eventsRouter.post("/events/process_tx/:tx_hash", requireAuth, async (req, res, next) => {
  try {
    const { tx_hash } = z.object({ tx_hash: z.string() }).parse(req.params);

    const result = await processTxReceipt(tx_hash);

    if (result.status === "not_found") {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }

    if (result.status === "no_events") {
      res.json({ message: "No events found in transaction", eventsProcessed: 0 });
      return;
    }

    res.json({
      message: `Processed ${result.eventsProcessed} events`,
      eventsProcessed: result.eventLabels,
      transactionHash: result.txHash,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /events/process_batch
 *
 * Process multiple Starknet transactions in a single request.  Each tx hash is
 * decoded and persisted independently using the same logic as
 * `process_tx/:tx_hash` so the operation is fully idempotent – re-submitting
 * the same batch produces no duplicate rows.
 *
 * **Validation**
 * - `tx_hashes` must be a non-empty array of valid Starknet tx hash strings.
 * - A maximum of {@link MAX_BATCH_SIZE} hashes is accepted per request to
 *   prevent unbounded RPC calls and DB writes.
 *
 * **Response**
 * Returns a `results` array where each entry corresponds to one tx hash and
 * contains `{ txHash, status, eventsProcessed, eventLabels?, error? }`.
 * A per-tx error never aborts the rest of the batch.
 */
eventsRouter.post("/events/process_batch", requireAuth, async (req, res, next) => {
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

    const results: TxProcessResult[] = [];

    for (const txHash of tx_hashes) {
      try {
        const result = await processTxReceipt(txHash);
        results.push(result);
      } catch (e: any) {
        // Per-tx errors are captured so they don't abort the rest of the batch
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
  } catch (e) {
    next(e);
  }
});

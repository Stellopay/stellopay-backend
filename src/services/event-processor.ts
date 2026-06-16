/**
 * Shared event processing logic used by:
 *   POST /events/process_tx/:tx_hash
 *   POST /events/process_batch
 *   POST /reprocess-events/tx/:tx_hash
 *
 * Extracted so each endpoint can call the same decode-and-persist logic
 * without loopback HTTP self-calls.
 */

import { eq } from "drizzle-orm";
import { Contract } from "starknet";
import { db, schema } from "../db/index.js";
import { provider } from "../starknet/client.js";
import { agreementContract } from "../starknet/client.js";
import { toHexString, normalizeStarknetAddress, normalizeTransactionHash } from "../utils/codec.js";
import { defaults, abiPaths } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "../starknet/abi.js";

export interface ProcessTxResult {
  txHash: string;
  eventsProcessed: string[];
  message: string;
}

// Lazily loaded ABIs
let workAgreementAbiCache: any[] | null = null;
let payrollEscrowAbiCache: any[] | null = null;

function getWorkAgreementAbi(): any[] {
  if (!workAgreementAbiCache) {
    if (!abiPaths.agreement) {
      throw new Error("AGREEMENT_CONTRACT_CLASS_JSON path is not configured");
    }
    workAgreementAbiCache = loadAbiFromContractClassJsonPath(abiPaths.agreement);
  }
  return workAgreementAbiCache;
}

function getPayrollEscrowAbi(): any[] {
  if (!payrollEscrowAbiCache) {
    if (!abiPaths.escrow) {
      throw new Error("ESCROW_CONTRACT_CLASS_JSON path is not configured");
    }
    payrollEscrowAbiCache = loadAbiFromContractClassJsonPath(abiPaths.escrow);
  }
  return payrollEscrowAbiCache;
}

/**
 * Fetch, decode, and persist all on-chain events for a single transaction.
 * Idempotent — uses onConflictDoNothing() / onConflictDoUpdate() so
 * re-processing the same tx is safe.
 */
export async function processTxHash(rawTxHash: string): Promise<ProcessTxResult> {
  const normalizedTxHash = normalizeTransactionHash(rawTxHash);

  // Fetch receipt — try normalized first, fall back to un-padded form if RPC
  // rejects leading zeros (some providers do).
  let receipt: Awaited<ReturnType<typeof provider.getTransactionReceipt>>;
  try {
    receipt = await provider.getTransactionReceipt(normalizedTxHash);
  } catch {
    const hex = normalizedTxHash.replace(/^0x/, "");
    const withoutLeadingZeros = `0x${hex.replace(/^0+/, "")}`;
    if (withoutLeadingZeros !== normalizedTxHash && withoutLeadingZeros.length >= 3) {
      receipt = await provider.getTransactionReceipt(withoutLeadingZeros);
    } else {
      receipt = await provider.getTransactionReceipt(normalizedTxHash);
    }
  }

  if (!receipt) {
    return { txHash: normalizedTxHash, eventsProcessed: [], message: "Transaction not found" };
  }

  if (!("events" in receipt && receipt.events)) {
    return { txHash: normalizedTxHash, eventsProcessed: [], message: "No events in transaction" };
  }

  let blockNumber = 0;
  if ("blockNumber" in receipt && receipt.blockNumber) {
    blockNumber = Number(receipt.blockNumber);
  } else if ("block_number" in receipt && (receipt as any).block_number) {
    blockNumber = Number((receipt as any).block_number);
  }

  const workAgreementAbi = getWorkAgreementAbi();
  const payrollEscrowAbi = getPayrollEscrowAbi();
  const workAgreementAddress = defaults.workAgreementAddress.toLowerCase();
  const payrollEscrowAddress = defaults.payrollEscrowAddress.toLowerCase();
  const workAgreementContract = new Contract(workAgreementAbi, workAgreementAddress, provider);
  const payrollEscrowContract = new Contract(payrollEscrowAbi, payrollEscrowAddress, provider);

  const eventsProcessed: string[] = [];

  for (let i = 0; i < receipt.events.length; i++) {
    const event = receipt.events[i];
    const fromAddress = event.from_address?.toLowerCase() || "";
    const eventData = event.data || [];

    if (!fromAddress || eventData.length === 0) continue;

    let decodedEvent: any = null;
    let eventType = "Unknown";
    let agreementId: string | null = null;

    try {
      if (fromAddress === workAgreementAddress) {
        decodedEvent = workAgreementContract.parseEvent(event);
        eventType = decodedEvent.name;
      } else if (fromAddress === payrollEscrowAddress) {
        decodedEvent = payrollEscrowContract.parseEvent(event);
        eventType = decodedEvent.name;
      }
    } catch {
      console.log(`[event-processor] Could not parse event ${i} from ${fromAddress}, using heuristics`);
    }

    if (decodedEvent?.data) {
      agreementId =
        decodedEvent.data.agreement_id?.toString() ||
        decodedEvent.data.agreementId?.toString() ||
        (eventData.length > 0 ? BigInt(eventData[0]).toString() : null);
    } else if (eventData.length > 0) {
      agreementId = BigInt(eventData[0]).toString();
    }

    if (decodedEvent && eventType !== "Unknown" && agreementId) {
      // ── Agreement lifecycle events ────────────────────────────────────
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
              blockNumber,
              transactionHash: normalizedTxHash,
              eventIndex: i,
            })
            .onConflictDoNothing();

          if (eventType === "AgreementCreated" && decodedEvent.data) {
            const employer = normalizeStarknetAddress(
              toHexString(BigInt(decodedEvent.data.employer || eventData[1])),
            );
            const contributor = decodedEvent.data.contributor
              ? normalizeStarknetAddress(
                  toHexString(BigInt(decodedEvent.data.contributor || eventData[2])),
                )
              : null;
            const tokenFromEvent = normalizeStarknetAddress(
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
                blockNumber,
                transactionHash: normalizedTxHash,
              })
              .onConflictDoUpdate({
                target: schema.agreements.id,
                set: { updatedAt: new Date() },
              });

            // Async token verification — non-blocking
            (async () => {
              try {
                const c = agreementContract(fromAddress);
                const contractToken = await c.get_token(agreementId);
                const normalizedContractToken = normalizeStarknetAddress(toHexString(contractToken));
                if (normalizedContractToken !== tokenFromEvent) {
                  await db
                    .update(schema.agreements)
                    .set({ token: normalizedContractToken, updatedAt: new Date() })
                    .where(eq(schema.agreements.id, agreementId!));
                }
              } catch {
                // Non-fatal — event data token is good enough as a fallback
              }
            })();
          }

          eventsProcessed.push(`${eventType}-${agreementId}`);
        } catch (e) {
          console.error(`[event-processor] Failed to store ${eventType}:`, e);
        }
      }
      // ── Payment events ────────────────────────────────────────────────
      else if (["PaymentSent", "PaymentReceived"].includes(eventType) && decodedEvent.data) {
        try {
          const from = normalizeStarknetAddress(
            toHexString(BigInt(decodedEvent.data.from || eventData[1])),
          );
          const to = normalizeStarknetAddress(
            toHexString(BigInt(decodedEvent.data.to || eventData[2])),
          );
          const amount =
            decodedEvent.data.amount &&
            typeof decodedEvent.data.amount === "object" &&
            decodedEvent.data.amount.low != null &&
            decodedEvent.data.amount.high != null
              ? (
                  BigInt(decodedEvent.data.amount.low) +
                  (BigInt(decodedEvent.data.amount.high) << 128n)
                ).toString()
              : (decodedEvent.data.amount?.toString() ?? (eventData[3] ? BigInt(eventData[3]).toString() : "0"));
          const token = normalizeStarknetAddress(
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
              blockNumber,
              transactionHash: normalizedTxHash,
            })
            .onConflictDoNothing();

          eventsProcessed.push(`${eventType}-${agreementId}`);
        } catch (e) {
          console.error("[event-processor] Failed to store payment:", e);
        }
      }
      // ── Escrow events ─────────────────────────────────────────────────
      else if (["Funded", "Released", "Refunded"].includes(eventType) && decodedEvent.data) {
        try {
          const employer = decodedEvent.data.employer
            ? normalizeStarknetAddress(toHexString(BigInt(decodedEvent.data.employer)))
            : "";
          const to = decodedEvent.data.to
            ? normalizeStarknetAddress(toHexString(BigInt(decodedEvent.data.to)))
            : null;
          const amount =
            decodedEvent.data.amount &&
            typeof decodedEvent.data.amount === "object" &&
            decodedEvent.data.amount.low != null &&
            decodedEvent.data.amount.high != null
              ? (
                  BigInt(decodedEvent.data.amount.low) +
                  (BigInt(decodedEvent.data.amount.high) << 128n)
                ).toString()
              : (decodedEvent.data.amount?.toString() ?? (eventData[2] ? BigInt(eventData[2]).toString() : "0"));

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
              blockNumber,
              transactionHash: normalizedTxHash,
            })
            .onConflictDoNothing();

          eventsProcessed.push(`${eventType}-${agreementId}`);
        } catch (e) {
          console.error("[event-processor] Failed to store escrow event:", e);
        }
      }
    } else {
      // ── Heuristic fallback (ABI decode failed) ────────────────────────
      if (eventData.length >= 6) {
        const fallbackAgreementId = BigInt(eventData[0]).toString();
        const employer = normalizeStarknetAddress(toHexString(BigInt(eventData[1])));
        const contributor = eventData[2]
          ? normalizeStarknetAddress(toHexString(BigInt(eventData[2])))
          : null;
        const token = normalizeStarknetAddress(toHexString(BigInt(eventData[3])));
        const mode = Number(eventData[4]);
        const paymentType = Number(eventData[5]);

        try {
          await db
            .insert(schema.agreementEvents)
            .values({
              id: `${normalizedTxHash}_${i}`,
              agreementId: fallbackAgreementId,
              contractAddress: fromAddress,
              eventType: "AgreementCreated",
              blockNumber,
              transactionHash: normalizedTxHash,
              eventIndex: i,
            })
            .onConflictDoNothing();

          await db
            .insert(schema.agreements)
            .values({
              id: fallbackAgreementId,
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
              blockNumber,
              transactionHash: normalizedTxHash,
            })
            .onConflictDoUpdate({
              target: schema.agreements.id,
              set: { updatedAt: new Date() },
            });

          eventsProcessed.push(`AgreementCreated-${fallbackAgreementId}`);
        } catch (e) {
          console.error("[event-processor] Failed to store heuristic AgreementCreated:", e);
        }
      }
    }
  }

  return {
    txHash: normalizedTxHash,
    eventsProcessed,
    message: `Processed ${eventsProcessed.length} events`,
  };
}

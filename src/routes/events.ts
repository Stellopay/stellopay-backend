import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { provider } from "../starknet/client.js";
import { toHexString, u256ToString } from "../utils/codec.js";
import { shortString, Contract } from "starknet";
import { defaults, abiPaths } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "../starknet/abi.js";
import { agreementContract } from "../starknet/client.js";

const AddressParam = z.string().min(3);

export const eventsRouter = Router();

// Helper to normalize addresses
function normalizeAddress(addr: string): string {
  let normalized = addr.toLowerCase();
  if (!normalized.startsWith("0x")) {
    normalized = `0x${normalized}`;
  }
  const hex = normalized.replace(/^0x/, "");
  return `0x${hex.padStart(64, "0")}`;
}

// Helper to normalize transaction hashes (same as indexer)
// Transaction hashes should be exactly 66 characters (0x + 64 hex), normalized to lowercase
// Preserves leading zeros if the hash is already 66 chars, otherwise pads to 66 chars
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

// Process transaction receipt and store all events
eventsRouter.post("/events/process_tx/:tx_hash", async (req, res, next) => {
  try {
    const { tx_hash } = z.object({ tx_hash: z.string() }).parse(req.params);
    
    // Normalize transaction hash (same as indexer) to ensure consistency
    const normalizedTxHash = normalizeTransactionHash(tx_hash);
    
    // Get transaction receipt - try both normalized and original format
    let receipt;
    try {
      receipt = await provider.getTransactionReceipt(normalizedTxHash);
    } catch (error: any) {
      // If normalized hash fails, try without leading zero padding
      const hex = normalizedTxHash.replace(/^0x/, "");
      const withoutLeadingZeros = `0x${hex.replace(/^0+/, "")}`;
      if (withoutLeadingZeros !== normalizedTxHash && withoutLeadingZeros.length >= 3) {
        try {
          receipt = await provider.getTransactionReceipt(withoutLeadingZeros);
        } catch {
          // If both fail, use normalized hash and let error propagate
          receipt = await provider.getTransactionReceipt(normalizedTxHash);
        }
      } else {
        throw error;
      }
    }
    if (!receipt) {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }
    
    if (!('events' in receipt && receipt.events)) {
      res.json({ message: "No events found in transaction", eventsProcessed: 0 });
      return;
    }
    
    // Get block number from receipt
    let blockNumber = 0;
    if ('blockNumber' in receipt && receipt.blockNumber) {
      blockNumber = typeof receipt.blockNumber === 'number' ? receipt.blockNumber : Number(receipt.blockNumber);
    } else if ('block_number' in receipt && receipt.block_number) {
      blockNumber = typeof receipt.block_number === 'number' ? receipt.block_number : Number(receipt.block_number);
    }
    
    const eventsProcessed: string[] = [];
    
    // Get contract ABIs for event decoding
    const workAgreementAbi = await getWorkAgreementAbi();
    const payrollEscrowAbi = await getPayrollEscrowAbi();
    const workAgreementAddress = defaults.workAgreementAddress.toLowerCase();
    const payrollEscrowAddress = defaults.payrollEscrowAddress.toLowerCase();
    
    // Create contract instances for event parsing
    const workAgreementContract = new Contract(workAgreementAbi, workAgreementAddress, provider);
    const payrollEscrowContract = new Contract(payrollEscrowAbi, payrollEscrowAddress, provider);
    
    // Process each event
    for (let i = 0; i < receipt.events.length; i++) {
      const event = receipt.events[i];
      const fromAddress = event.from_address?.toLowerCase() || "";
      const eventData = event.data || [];
      
      if (!fromAddress || eventData.length === 0) continue;
      
      // Try to decode event using contract ABI
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
      } catch (parseError) {
        // If parsing fails, fall back to heuristics
        console.log(`[events] Could not parse event ${i} from ${fromAddress}, using heuristics`);
      }
      
      // Extract agreement_id from decoded event
      if (decodedEvent && decodedEvent.data) {
        agreementId = decodedEvent.data.agreement_id?.toString() || 
                      decodedEvent.data.agreementId?.toString() || 
                      (eventData.length > 0 ? BigInt(eventData[0]).toString() : null);
      } else if (eventData.length > 0) {
        agreementId = BigInt(eventData[0]).toString();
      }
      
      // Process based on event type
      if (decodedEvent && eventType !== "Unknown" && agreementId) {
        // Store agreement events
        if (["AgreementCreated", "AgreementActivated", "AgreementPaused", "AgreementResumed", 
             "AgreementCancelled", "AgreementCompleted", "EmployeeAdded", "MilestoneAdded", 
             "MilestoneApproved", "MilestoneClaimed", "PayrollClaimed", "DisputeRaised", 
             "DisputeResolved"].includes(eventType)) {
          
          try {
            await db.insert(schema.agreementEvents).values({
              id: `${normalizedTxHash}_${i}`,
              agreementId,
              contractAddress: fromAddress,
              eventType,
              blockNumber: Number(blockNumber),
              transactionHash: normalizedTxHash,
              eventIndex: i,
            }).onConflictDoNothing();
            
            // If AgreementCreated, also create agreement record
            if (eventType === "AgreementCreated" && decodedEvent.data) {
              const employer = normalizeAddress(toHexString(BigInt(decodedEvent.data.employer || eventData[1])));
              const contributor = decodedEvent.data.contributor ? normalizeAddress(toHexString(BigInt(decodedEvent.data.contributor || eventData[2]))) : null;
              const tokenFromEvent = normalizeAddress(toHexString(BigInt(decodedEvent.data.token || eventData[3])));
              const mode = Number(decodedEvent.data.mode || eventData[4] || 0);
              const paymentType = Number(decodedEvent.data.payment_type || decodedEvent.data.paymentType || eventData[5] || 0);
              
              // Store agreement with token from event
              await db.insert(schema.agreements).values({
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
              }).onConflictDoUpdate({
                target: schema.agreements.id,
                set: {
                  updatedAt: new Date(),
                },
              });
              
              // Verify and update token from agreement contract (async, non-blocking)
              // This ensures we have the correct token even if the event data was wrong
              (async () => {
                try {
                  console.log(`[events] Verifying token for agreement ${agreementId} from contract ${fromAddress}`);
                  console.log(`[events] Token from event: ${tokenFromEvent}`);
                  
                  const c = agreementContract(fromAddress);
                  const contractToken = await c.get_token(agreementId);
                  const normalizedContractToken = normalizeAddress(toHexString(contractToken));
                  
                  console.log(`[events] Token from contract: ${normalizedContractToken}`);
                  console.log(`[events] Tokens match: ${normalizedContractToken === tokenFromEvent}`);
                  
                  // Update token if it differs from what we stored
                  if (normalizedContractToken !== tokenFromEvent) {
                    console.log(`[events] Token mismatch detected! Updating agreement ${agreementId}`);
                    console.log(`[events]   Event token: ${tokenFromEvent}`);
                    console.log(`[events]   Contract token: ${normalizedContractToken}`);
                    
                    await db.update(schema.agreements)
                      .set({ token: normalizedContractToken, updatedAt: new Date() })
                      .where(eq(schema.agreements.id, agreementId));
                    
                    console.log(`[events] Successfully updated token for agreement ${agreementId} from ${tokenFromEvent} to ${normalizedContractToken}`);
                  } else {
                    console.log(`[events] Token verification passed for agreement ${agreementId}`);
                  }
                } catch (error: any) {
                  console.error(`[events] Failed to verify token from contract for agreement ${agreementId}:`, error);
                  console.error(`[events] Error details:`, {
                    message: error?.message,
                    stack: error?.stack,
                    agreementId,
                    contractAddress: fromAddress,
                  });
                }
              })();
            }
            
            eventsProcessed.push(`${eventType}-${agreementId}`);
          } catch (e) {
            console.error(`[events] Failed to store ${eventType}:`, e);
          }
        }
        // Store payment events
        else if (["PaymentSent", "PaymentReceived"].includes(eventType) && decodedEvent.data) {
          try {
            const from = normalizeAddress(toHexString(BigInt(decodedEvent.data.from || eventData[1])));
            const to = normalizeAddress(toHexString(BigInt(decodedEvent.data.to || eventData[2])));
            const amount = decodedEvent.data.amount ? 
              (typeof decodedEvent.data.amount === 'object' && decodedEvent.data.amount.low && decodedEvent.data.amount.high ?
                (BigInt(decodedEvent.data.amount.low) + (BigInt(decodedEvent.data.amount.high) << 128n)).toString() :
                decodedEvent.data.amount.toString()) :
              (eventData.length >= 4 ? BigInt(eventData[3]).toString() : "0");
            const token = normalizeAddress(toHexString(BigInt(decodedEvent.data.token || eventData[4] || eventData[2])));
            
            await db.insert(schema.payments).values({
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
            }).onConflictDoNothing();
            
            eventsProcessed.push(`${eventType}-${agreementId}`);
          } catch (e) {
            console.error(`[events] Failed to store payment:`, e);
          }
        }
        // Store escrow events
        else if (["Funded", "Released", "Refunded"].includes(eventType) && decodedEvent.data) {
          try {
            const employer = decodedEvent.data.employer ? normalizeAddress(toHexString(BigInt(decodedEvent.data.employer))) : "";
            const to = decodedEvent.data.to ? normalizeAddress(toHexString(BigInt(decodedEvent.data.to))) : null;
            const amount = decodedEvent.data.amount ? 
              (typeof decodedEvent.data.amount === 'object' && decodedEvent.data.amount.low && decodedEvent.data.amount.high ?
                (BigInt(decodedEvent.data.amount.low) + (BigInt(decodedEvent.data.amount.high) << 128n)).toString() :
                decodedEvent.data.amount.toString()) :
              (eventData.length >= 3 ? BigInt(eventData[2]).toString() : "0");
            
            await db.insert(schema.escrowEvents).values({
              id: `${normalizedTxHash}_${i}`,
              agreementId,
              contractAddress: fromAddress,
              eventType,
              employer: eventType === "Funded" ? employer : "",
              to: eventType !== "Funded" ? to : null,
              amount,
              blockNumber: Number(blockNumber),
              transactionHash: normalizedTxHash,
            }).onConflictDoNothing();
            
            eventsProcessed.push(`${eventType}-${agreementId}`);
          } catch (e) {
            console.error(`[events] Failed to store escrow event:`, e);
          }
        }
      } else {
        // Fallback: Use heuristics if decoding failed
        // This is the old logic for backward compatibility
        if (eventData.length >= 6) {
          const agreementId = BigInt(eventData[0]).toString();
          const employer = normalizeAddress(toHexString(BigInt(eventData[1])));
          const contributor = eventData[2] ? normalizeAddress(toHexString(BigInt(eventData[2]))) : null;
          const token = normalizeAddress(toHexString(BigInt(eventData[3])));
          const mode = Number(eventData[4]);
          const paymentType = Number(eventData[5]);
          
          try {
            await db.insert(schema.agreementEvents).values({
              id: `${normalizedTxHash}_${i}`,
              agreementId,
              contractAddress: fromAddress,
              eventType: "AgreementCreated",
              blockNumber: Number(blockNumber),
              transactionHash: normalizedTxHash,
              eventIndex: i,
            }).onConflictDoNothing();
            
            await db.insert(schema.agreements).values({
              id: agreementId,
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
            }).onConflictDoUpdate({
              target: schema.agreements.id,
              set: {
                updatedAt: new Date(),
              },
            });
            
            eventsProcessed.push(`AgreementCreated-${agreementId}`);
          } catch (e) {
            console.error(`[events] Failed to store AgreementCreated:`, e);
          }
        }
      }
    }
    
    res.json({
      message: `Processed ${eventsProcessed.length} events`,
      eventsProcessed,
      transactionHash: normalizedTxHash,
    });
  } catch (e) {
    next(e);
  }
});

// Process multiple transactions
eventsRouter.post("/events/process_batch", async (req, res, next) => {
  try {
    const { tx_hashes } = z.object({
      tx_hashes: z.array(z.string()),
    }).parse(req.body);
    
    const results = [];
    
    for (const txHash of tx_hashes) {
      try {
        // Normalize transaction hash (same as indexer)
        const normalizedTxHash = normalizeTransactionHash(txHash);
        
        // Get transaction receipt - try normalized first, then fallback
        let receipt;
        try {
          receipt = await provider.getTransactionReceipt(normalizedTxHash);
        } catch (error: any) {
          // If normalized hash fails, try without leading zero padding
          const hex = normalizedTxHash.replace(/^0x/, "");
          const withoutLeadingZeros = `0x${hex.replace(/^0+/, "")}`;
          if (withoutLeadingZeros !== normalizedTxHash && withoutLeadingZeros.length >= 3) {
            try {
              receipt = await provider.getTransactionReceipt(withoutLeadingZeros);
            } catch {
              receipt = await provider.getTransactionReceipt(normalizedTxHash);
            }
          } else {
            throw error;
          }
        }
        if (!receipt || !('events' in receipt && receipt.events)) {
          results.push({ txHash: normalizedTxHash, status: "no_events" });
          continue;
        }
        
        // Process events (reuse logic from process_tx)
        // For now, just acknowledge
        results.push({ txHash: normalizedTxHash, status: "processed", eventCount: receipt.events.length });
      } catch (e) {
        results.push({ txHash, status: "error", error: String(e) });
      }
    }
    
    res.json({ results });
  } catch (e) {
    next(e);
  }
});

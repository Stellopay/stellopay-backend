import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { provider } from "../starknet/client.js";
import { eq, inArray } from "drizzle-orm";
import { Contract } from "starknet";
import { defaults, abiPaths } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "../starknet/abi.js";
import { processTxReceipt } from "./events.js";

export const reprocessEventsRouter = Router();

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

// Reprocess events for a specific transaction to update event names
reprocessEventsRouter.post(
  "/reprocess-events/tx/:tx_hash",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { tx_hash } = z.object({ tx_hash: z.string() }).parse(req.params);

      // Validate tx_hash format before processing to prevent invalid inputs/SSRF
      const txHashRegex = /^0x?[0-9a-fA-F]{1,64}$/;
      if (!tx_hash || !txHashRegex.test(tx_hash) || tx_hash.length > 66) {
        res.status(400).json({ error: "Invalid Starknet transaction hash format" });
        return;
      }

      // Format tx hash
      let formattedTxHash = tx_hash;
      if (!tx_hash.startsWith("0x")) {
        formattedTxHash = `0x${tx_hash}`;
      }

      // Call the shared events processing logic directly, avoiding loopback HTTP requests
      const result = await processTxReceipt(formattedTxHash);

      if (result.status === "not_found") {
        res.status(404).json({ error: "Transaction not found" });
        return;
      }

      res.json({
        message: "Events reprocessed",
        result,
      });
    } catch (e: any) {
      if (e.message === "Transaction not found") {
        res.status(404).json({ error: "Transaction not found" });
        return;
      }
      next(e);
    }
  },
);

// Reprocess all AgreementStatusChange events to decode their actual names
reprocessEventsRouter.post(
  "/reprocess-events/status-changes",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const limit =
        z.coerce.number().int().positive().max(1000).optional().parse(req.query.limit) || 100;

      // Get contract ABIs
      const workAgreementAbi = await getWorkAgreementAbi();
      const payrollEscrowAbi = await getPayrollEscrowAbi();
      const workAgreementAddress = defaults.workAgreementAddress.toLowerCase();
      const payrollEscrowAddress = defaults.payrollEscrowAddress.toLowerCase();

      // Create contract instances for event parsing
      const workAgreementContract = new Contract(workAgreementAbi, workAgreementAddress, provider);
      const payrollEscrowContract = new Contract(payrollEscrowAbi, payrollEscrowAddress, provider);

      // Get all AgreementStatusChange events
      const statusChangeEvents = await db
        .select()
        .from(schema.agreementEvents)
        .where(eq(schema.agreementEvents.eventType, "AgreementStatusChange"))
        .limit(limit);

      const results = [];
      let updated = 0;

      for (const event of statusChangeEvents) {
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
    } catch (e) {
      next(e);
    }
  },
);

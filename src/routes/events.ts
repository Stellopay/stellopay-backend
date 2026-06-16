import { Router } from "express";
import { z } from "zod";
import { normalizeTransactionHash } from "../utils/codec.js";
import { processTxHash } from "../services/event-processor.js";

export const eventsRouter = Router();

// Process transaction receipt and store all events
eventsRouter.post("/events/process_tx/:tx_hash", async (req, res, next) => {
  try {
    const { tx_hash } = z.object({ tx_hash: z.string() }).parse(req.params);
    const result = await processTxHash(tx_hash);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// Process multiple transactions — each tx is fully decoded and persisted.
// Idempotent: re-processing is safe (onConflictDoNothing).
eventsRouter.post("/events/process_batch", async (req, res, next) => {
  try {
    const { tx_hashes } = z
      .object({ tx_hashes: z.array(z.string()).min(1).max(100) })
      .parse(req.body);

    const results = await Promise.allSettled(
      tx_hashes.map(async (txHash) => {
        try {
          const result = await processTxHash(txHash);
          return {
            txHash: normalizeTransactionHash(txHash),
            status: "processed" as const,
            eventsProcessed: result.eventsProcessed.length,
            events: result.eventsProcessed,
          };
        } catch (e) {
          return {
            txHash: normalizeTransactionHash(txHash),
            status: "error" as const,
            error: String(e),
          };
        }
      }),
    );

    const processed = results.map((r) =>
      r.status === "fulfilled" ? r.value : { txHash: "unknown", status: "error" as const, error: String(r.reason) },
    );

    const totalEvents = processed.reduce(
      (sum, r) => sum + ("eventsProcessed" in r ? r.eventsProcessed : 0),
      0,
    );

    res.json({
      results: processed,
      summary: {
        total: processed.length,
        succeeded: processed.filter((r) => r.status === "processed").length,
        failed: processed.filter((r) => r.status === "error").length,
        totalEventsProcessed: totalEvents,
      },
    });
  } catch (e) {
    next(e);
  }
});

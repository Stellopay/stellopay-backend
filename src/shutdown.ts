import { Server } from "http";

/**
 * Sets up graceful shutdown handling for the application.
 * Captures SIGTERM and SIGINT, stops accepting new connections,
 * waits for in-flight requests to complete with a bounded timeout,
 * and then closes the database pool.
 *
 * Force-exit timeout guard (issue #144)
 * ──────────────────────────────────────
 * A hard overall timeout wraps the entire shutdown sequence via Promise.race.
 * If ANY step (server.close or pool.close) hangs beyond `forceExitTimeoutMs`,
 * the process force-exits with code 1 and logs which phase was still pending.
 * This prevents indefinite hangs that block orchestrators expecting a bounded
 * shutdown window.
 *
 * The guard fires independently of the per-drain `drainTimeoutMs` timer, so
 * even if the drain timer is cleared early or never fires, the overall guard
 * still terminates the process.
 *
 * @param server            - The active HTTP server instance
 * @param closePool         - A function to close the database connection pool
 * @param drainTimeoutMs    - Bounded timeout for the drain phase (server.close)
 * @param forceExitTimeoutMs - Hard overall timeout for the entire shutdown
 *                            sequence. Defaults to drainTimeoutMs + 5000 when
 *                            not supplied. Must be > drainTimeoutMs.
 */
type ShutdownPhase = "starting" | "server_close" | "pool_close";

export function setupGracefulShutdown(
  server: Server,
  closePool: () => Promise<void>,
  drainTimeoutMs: number,
  forceExitTimeoutMs?: number,
): void {
  // Overall guard defaults to drain + 5 s so normal exits are not affected.
  const _forceExitMs = forceExitTimeoutMs ?? drainTimeoutMs + 5_000;

  let isShuttingDown = false;
  let currentPhase: ShutdownPhase = "starting";

  const shutdownHandler = async (signal: string) => {
    if (isShuttingDown) {
      console.warn(`[shutdown] Received ${signal} again, forcing exit`);
      process.exit(1);
    }
    isShuttingDown = true;
    console.log(`[shutdown] Received ${signal}, starting graceful shutdown...`);

    // ── Overall force-exit guard ─────────────────────────────────────────────
    // Races the entire sequence against a hard timer so a hung step never
    // blocks the process indefinitely.
    let forceTimer: ReturnType<typeof setTimeout>;
    const forceExitRace = new Promise<never>((_, reject) => {
      forceTimer = setTimeout(() => {
        reject(new Error(`force-exit-timeout:${currentPhase}`));
      }, _forceExitMs);
      forceTimer.unref();
    });

    // ── Per-drain timeout ────────────────────────────────────────────────────
    const timeout = setTimeout(() => {
      console.warn(
        `[shutdown] Drain timeout (${drainTimeoutMs}ms) exceeded during ${currentPhase}, forcing exit`,
      );
      process.exit(1);
    }, drainTimeoutMs);
    timeout.unref();

    const sequence = async () => {
      currentPhase = "server_close";
      console.log("[shutdown] Stopping HTTP server from accepting new connections...");
      await new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) {
            console.error("[shutdown] Error during server close:", err);
          } else {
            console.log("[shutdown] HTTP server closed");
          }
          resolve();
        });
      });

      currentPhase = "pool_close";
      try {
        await closePool();
        clearTimeout(timeout);
        clearTimeout(forceTimer!);
        console.log("[shutdown] Graceful shutdown complete, exiting (0)");
        process.exit(0);
      } catch (poolErr) {
        console.error("[shutdown] Error closing pool:", poolErr);
        process.exit(1);
      }
    };

    try {
      await Promise.race([sequence(), forceExitRace]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("force-exit-timeout:")) {
        const phase = msg.replace("force-exit-timeout:", "");
        console.error(
          `[shutdown] Force-exit timeout (${_forceExitMs}ms) exceeded — step still pending: ${phase}`,
        );
        process.exit(1);
      }
      // Non-timeout error — already handled inside sequence()
    }
  };

  process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
  process.on("SIGINT", () => shutdownHandler("SIGINT"));

  process.on("unhandledRejection", (reason, promise) => {
    console.error("[shutdown] Unhandled Rejection at:", promise, "reason:", reason);
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    console.error("[shutdown] Uncaught Exception:", error);
    process.exit(1);
  });
}

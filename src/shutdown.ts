import { Server } from "http";

/**
 * Sets up graceful shutdown handling for the application.
 * Captures SIGTERM and SIGINT, stops accepting new connections,
 * waits for in-flight requests to complete with a bounded timeout,
 * and then closes the database pool.
 *
 * @param server - The active HTTP server instance
 * @param closePool - A function to close the database connection pool
 * @param drainTimeoutMs - The bounded timeout in milliseconds to wait for connections to drain
 */
export function setupGracefulShutdown(
  server: Server,
  closePool: () => Promise<void>,
  drainTimeoutMs: number
): void {
  let isShuttingDown = false;

  const shutdownHandler = async (signal: string) => {
    if (isShuttingDown) {
      console.warn(`[shutdown] Received ${signal} again, forcing exit`);
      process.exit(1);
    }
    isShuttingDown = true;
    console.log(`[shutdown] Received ${signal}, starting graceful shutdown...`);

    // Create a bounded drain timeout
    const timeout = setTimeout(() => {
      console.error(`[shutdown] Drain timeout (${drainTimeoutMs}ms) exceeded, forcing exit`);
      process.exit(1);
    }, drainTimeoutMs);
    timeout.unref();

    console.log("[shutdown] Stopping HTTP server from accepting new connections...");
    server.close(async (err) => {
      if (err) {
        console.error("[shutdown] Error during server close:", err);
      } else {
        console.log("[shutdown] HTTP server closed");
      }

      try {
        await closePool();
        clearTimeout(timeout);
        console.log("[shutdown] Graceful shutdown complete, exiting (0)");
        process.exit(0);
      } catch (poolErr) {
        console.error("[shutdown] Error closing pool:", poolErr);
        process.exit(1);
      }
    });
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

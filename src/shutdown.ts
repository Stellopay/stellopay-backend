import { Server } from "http";

/**
 * Sets up graceful shutdown handling for the application.
 * Captures SIGTERM and SIGINT, stops accepting new connections,
 * waits for in-flight requests to complete with a bounded timeout,
 * and then closes the database pool.
 *
 * Also registers `unhandledRejection` and `uncaughtException` handlers that
 * log structured context and route through the same graceful shutdown sequence
 * rather than calling `process.exit` directly. This ensures in-flight HTTP
 * requests are drained and the database pool is closed cleanly even when an
 * unhandled async error occurs. The existing force-exit timeout guard still
 * applies so a hung shutdown never blocks the process indefinitely.
 *
 * Logged error context deliberately excludes request bodies and auth tokens
 * to prevent accidental secret exposure in logs.
 *
 * @param server - The active HTTP server instance
 * @param closePool - A function to close the database connection pool
 * @param drainTimeoutMs - The bounded timeout in milliseconds to wait for
 *   connections to drain before force-exiting
 */
type ShutdownPhase = "starting" | "server_close" | "pool_close";

export function setupGracefulShutdown(
  server: Server,
  closePool: () => Promise<void>,
  drainTimeoutMs: number,
): void {
  let isShuttingDown = false;
  let currentPhase: ShutdownPhase = "starting";

  const shutdownHandler = async (signal: string) => {
    if (isShuttingDown) {
      console.warn(`[shutdown] Received ${signal} again, forcing exit`);
      process.exit(1);
    }
    isShuttingDown = true;
    console.log(`[shutdown] Received ${signal}, starting graceful shutdown...`);

    // Create a bounded drain timeout
    const timeout = setTimeout(() => {
      console.warn(
        `[shutdown] Drain timeout (${drainTimeoutMs}ms) exceeded during ${currentPhase}, forcing exit`,
      );
      process.exit(1);
    }, drainTimeoutMs);
    timeout.unref();

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
      console.log("[shutdown] Graceful shutdown complete, exiting (0)");
      process.exit(0);
    } catch (poolErr) {
      console.error("[shutdown] Error closing pool:", poolErr);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
  process.on("SIGINT", () => shutdownHandler("SIGINT"));

  /**
   * Unhandled promise rejections route through the graceful shutdown sequence
   * rather than calling process.exit directly. Structured context (error
   * message and stack) is logged before shutdown begins. The promise and
   * `reason` are used only for logging — request body contents and auth
   * tokens are never reachable from here so there is no secret-exposure risk.
   */
  process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    console.error("[shutdown] Unhandled promise rejection — initiating graceful shutdown", {
      event: "unhandledRejection",
      message,
      stack,
      promise: String(promise),
    });
    void shutdownHandler("unhandledRejection");
  });

  /**
   * Uncaught synchronous exceptions route through the graceful shutdown
   * sequence rather than calling process.exit directly. Full error context
   * (message, stack, error name) is logged before shutdown begins.
   */
  process.on("uncaughtException", (error: Error) => {
    console.error("[shutdown] Uncaught exception — initiating graceful shutdown", {
      event: "uncaughtException",
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    void shutdownHandler("uncaughtException");
  });
}

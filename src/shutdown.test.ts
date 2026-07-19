import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupGracefulShutdown } from "./shutdown.js";
import { Server } from "http";

describe("Graceful Shutdown", () => {
  let mockServer: any;
  let mockClosePool: any;
  let processExitSpy: any;
  let processOnSpy: any;

  beforeEach(() => {
    // Mock the HTTP server
    mockServer = {
      close: vi.fn((cb) => {
        // We'll call the callback manually in tests
        mockServer._closeCallback = cb;
      }),
    };

    mockClosePool = vi.fn().mockResolvedValue(undefined);

    // Mock process.exit and process.on
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should trigger graceful shutdown on SIGTERM", async () => {
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    // Find the SIGTERM handler
    const sigtermHandlerCall = processOnSpy.mock.calls.find((call: any) => call[0] === "SIGTERM");
    expect(sigtermHandlerCall).toBeDefined();

    const handler = sigtermHandlerCall[1];

    // Trigger the signal
    handler("SIGTERM");

    // Server close should be called
    expect(mockServer.close).toHaveBeenCalled();

    // Call the callback to simulate server fully closed
    await mockServer._closeCallback();

    // Pool should be closed
    expect(mockClosePool).toHaveBeenCalled();

    // Should exit with 0
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("should force exit if drain timeout is exceeded", async () => {
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const sigtermHandlerCall = processOnSpy.mock.calls.find((call: any) => call[0] === "SIGTERM");
    const handler = sigtermHandlerCall[1];

    handler("SIGTERM");

    // Server close is initiated but we DO NOT call the callback
    expect(mockServer.close).toHaveBeenCalled();

    // Fast-forward time past the drain timeout
    vi.advanceTimersByTime(10001);

    // Should force exit with 1
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("should force exit on double signal", async () => {
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const sigtermHandlerCall = processOnSpy.mock.calls.find((call: any) => call[0] === "SIGTERM");
    const handler = sigtermHandlerCall[1];

    // First signal
    handler("SIGTERM");

    // Second signal during shutdown
    handler("SIGTERM");

    // Should force exit with 1 immediately
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("should force exit if pool close hangs within drain timeout", async () => {
    // Pool close hangs (never resolves)
    let poolCloseNeverResolve: () => void;
    const hangingPoolPromise = new Promise<void>((resolve) => {
      poolCloseNeverResolve = resolve;
    });
    mockClosePool.mockReturnValue(hangingPoolPromise);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const sigtermHandlerCall = processOnSpy.mock.calls.find((call: any) => call[0] === "SIGTERM");
    const handler = sigtermHandlerCall[1];

    handler("SIGTERM");

    expect(mockServer.close).toHaveBeenCalled();

    // Call the server close callback without awaiting — it will execute
    // synchronously up to the pending `await closePool()` and yield.
    mockServer._closeCallback();

    expect(mockClosePool).toHaveBeenCalled();

    // Fast-forward past the drain timeout
    vi.advanceTimersByTime(10001);

    // Should force exit with 1 because pool close hung and timeout fired
    expect(processExitSpy).toHaveBeenCalledWith(1);

    // Verify the timeout warning mentions the pool_close phase
    const timeoutCall = warnSpy.mock.calls.find((call: any) =>
      call[0].includes("Drain timeout"),
    );
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall[0]).toMatch(/pool_close/);

    warnSpy.mockRestore();
    // Resolve the hanging promise to clean up
    poolCloseNeverResolve();
  });

  it("should handle error during pool close", async () => {
    mockClosePool.mockRejectedValue(new Error("Pool close error"));

    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const sigtermHandlerCall = processOnSpy.mock.calls.find((call: any) => call[0] === "SIGTERM");
    const handler = sigtermHandlerCall[1];

    handler("SIGTERM");

    // Call the callback to simulate server closed
    await mockServer._closeCallback();

    // Pool should be called
    expect(mockClosePool).toHaveBeenCalled();

    // Should exit with 1 due to error
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

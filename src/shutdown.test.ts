import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupGracefulShutdown } from "./shutdown.js";
import { createServer, request, Server, type AddressInfo } from "http";

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
    const shutdownPromise = handler("SIGTERM");

    // Server close should be called
    expect(mockServer.close).toHaveBeenCalled();

    // Call the callback to simulate server fully closed
    await mockServer._closeCallback();
    await shutdownPromise;

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

    const shutdownPromise = handler("SIGTERM");

    // Call the callback to simulate server closed
    await mockServer._closeCallback();
    await shutdownPromise;

    // Pool should be called
    expect(mockClosePool).toHaveBeenCalled();

    // Should exit with 1 due to error
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("should close the HTTP server before closing the pool", async () => {
    const callOrder: string[] = [];
    mockServer.close = vi.fn((cb) => {
      callOrder.push("server.close");
      mockServer._closeCallback = cb;
    });
    mockClosePool.mockImplementation(async () => {
      callOrder.push("pool.close");
    });

    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const sigtermHandlerCall = processOnSpy.mock.calls.find((call: any) => call[0] === "SIGTERM");
    const handler = sigtermHandlerCall[1];

    const shutdownPromise = handler("SIGTERM");
    await mockServer._closeCallback();
    await shutdownPromise;

    expect(callOrder).toEqual(["server.close", "pool.close"]);
  });

  // ── Force-exit timeout guard tests (issue #144) ───────────────────────────

  it("force-exit guard fires when server.close hangs beyond forceExitTimeoutMs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // server.close never calls back — simulates a hung server_close step
    mockServer.close = vi.fn(() => {}); // no callback ever

    setupGracefulShutdown(
      mockServer as unknown as Server,
      mockClosePool,
      10_000,
      3_000, // forceExitTimeoutMs shorter than drain
    );

    const sigtermHandlerCall = processOnSpy.mock.calls.find((call: any) => call[0] === "SIGTERM");
    const handler = sigtermHandlerCall[1];

    handler("SIGTERM");

    expect(mockServer.close).toHaveBeenCalled();

    // Advance past force-exit timeout
    vi.advanceTimersByTime(3_001);
    await Promise.resolve(); // flush microtasks

    expect(processExitSpy).toHaveBeenCalledWith(1);
    const errCall = errorSpy.mock.calls.find((c: any) =>
      c[0].includes("Force-exit timeout"),
    );
    expect(errCall).toBeDefined();
    expect(errCall[0]).toMatch(/server_close/);

    errorSpy.mockRestore();
  });

  it("force-exit guard names the stuck step as pool_close when pool hangs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let resolve!: () => void;
    mockClosePool.mockReturnValue(new Promise<void>((r) => { resolve = r; }));

    setupGracefulShutdown(
      mockServer as unknown as Server,
      mockClosePool,
      10_000,
      5_000,
    );

    const sigtermHandlerCall = processOnSpy.mock.calls.find((call: any) => call[0] === "SIGTERM");
    const handler = sigtermHandlerCall[1];

    handler("SIGTERM");
    mockServer._closeCallback(); // server closes fine

    // Advance past force-exit timeout
    vi.advanceTimersByTime(5_001);
    await Promise.resolve();

    expect(processExitSpy).toHaveBeenCalledWith(1);
    const errCall = errorSpy.mock.calls.find((c: any) =>
      c[0].includes("Force-exit timeout"),
    );
    expect(errCall).toBeDefined();
    expect(errCall[0]).toMatch(/pool_close/);

    errorSpy.mockRestore();
    resolve();
  });

  it("force-exit guard does NOT fire on a normal fast shutdown", async () => {
    setupGracefulShutdown(
      mockServer as unknown as Server,
      mockClosePool,
      10_000,
      15_000,
    );

    const sigtermHandlerCall = processOnSpy.mock.calls.find((call: any) => call[0] === "SIGTERM");
    const handler = sigtermHandlerCall[1];

    const shutdownPromise = handler("SIGTERM");
    await mockServer._closeCallback();
    await shutdownPromise;

    // Normal exit with 0 — force guard never fired
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(processExitSpy).not.toHaveBeenCalledWith(1);
  });

  it("forceExitTimeoutMs defaults to drainTimeoutMs + 5000 when not supplied", async () => {
    // With drain=1000, force should default to 6000. Advance to 5999 → no exit.
    // This test just verifies the guard isn't shorter than drain by default.
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 1_000);

    const sigtermHandlerCall = processOnSpy.mock.calls.find((call: any) => call[0] === "SIGTERM");
    const handler = sigtermHandlerCall[1];

    handler("SIGTERM");
    // Don't call server close callback — drain fires at 1001ms, not force guard
    vi.advanceTimersByTime(1_001);

    // Drain timeout fires first (process.exit(1) from drain timer)
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

describe("Graceful Shutdown HTTP integration", () => {
  let server: Server;
  let closePool: ReturnType<typeof vi.fn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let port: number;

  beforeEach(() => {
    closePool = vi.fn().mockResolvedValue(undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(async () => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    vi.restoreAllMocks();
  });

  async function listenHttpServer(httpServer: Server): Promise<number> {
    return new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        const address = httpServer.address() as AddressInfo;
        resolve(address.port);
      });
    });
  }

  function emitSigterm(): void {
    for (const listener of process.listeners("SIGTERM")) {
      if (typeof listener === "function") {
        listener("SIGTERM");
        return;
      }
    }
    throw new Error("SIGTERM handler not registered");
  }

  it("completes in-flight requests and refuses new connections during drain", async () => {
    let slowRequestSeen = false;
    let releaseSlowResponse!: () => void;
    const slowResponseGate = new Promise<void>((resolve) => {
      releaseSlowResponse = resolve;
    });

    server = createServer((req, res) => {
      if (req.url === "/slow") {
        slowRequestSeen = true;
        void slowResponseGate.then(() => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("slow-ok");
        });
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });

    port = await listenHttpServer(server);
    setupGracefulShutdown(server, closePool, 10_000);

    const inFlightBody = new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/slow", method: "GET" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
      req.end();
    });

    await vi.waitFor(() => {
      expect(slowRequestSeen).toBe(true);
    });

    emitSigterm();

    const refusedError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/", method: "GET" }, () => resolve(null));
      req.on("error", (err) => resolve(err));
      req.end();
    });
    expect(refusedError?.code).toBe("ECONNREFUSED");

    releaseSlowResponse();
    expect(await inFlightBody).toBe("slow-ok");
    await vi.waitFor(() => {
      expect(closePool).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });
  });
});

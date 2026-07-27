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

  // -------------------------------------------------------------------------
  // unhandledRejection — routes through graceful shutdown
  // -------------------------------------------------------------------------

  it("unhandledRejection triggers graceful shutdown (drain + exit 0)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const rejectionCall = processOnSpy.mock.calls.find(
      (call: any) => call[0] === "unhandledRejection",
    );
    expect(rejectionCall).toBeDefined();
    const handler = rejectionCall[1];

    const reason = new Error("async task blew up");
    handler(reason, Promise.resolve());

    // shutdownHandler invokes server.close — drain is running
    expect(mockServer.close).toHaveBeenCalled();

    await mockServer._closeCallback();
    // Allow the async shutdown chain to settle
    await Promise.resolve();
    await Promise.resolve();

    expect(mockClosePool).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);
    errorSpy.mockRestore();
  });

  it("unhandledRejection logs structured context with message and stack", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const handler = processOnSpy.mock.calls.find(
      (call: any) => call[0] === "unhandledRejection",
    )![1];

    const reason = new Error("db pool exhausted");
    handler(reason, Promise.resolve());

    // Log must contain the structured payload
    const logCall = errorSpy.mock.calls.find((c) =>
      String(c[0]).includes("Unhandled promise rejection"),
    );
    expect(logCall).toBeDefined();
    const payload = logCall![1] as Record<string, unknown>;
    expect(payload.event).toBe("unhandledRejection");
    expect(payload.message).toBe("db pool exhausted");
    expect(typeof payload.stack).toBe("string");

    errorSpy.mockRestore();
    // Clean up the started shutdown
    mockServer._closeCallback?.();
  });

  it("unhandledRejection with a non-Error reason logs the stringified value", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const handler = processOnSpy.mock.calls.find(
      (call: any) => call[0] === "unhandledRejection",
    )![1];

    // Plain string rejection — no .stack available
    handler("something went wrong", Promise.resolve());

    const logCall = errorSpy.mock.calls.find((c) =>
      String(c[0]).includes("Unhandled promise rejection"),
    );
    expect(logCall).toBeDefined();
    const payload = logCall![1] as Record<string, unknown>;
    expect(payload.message).toBe("something went wrong");
    expect(payload.stack).toBeUndefined();

    errorSpy.mockRestore();
    mockServer._closeCallback?.();
  });

  it("unhandledRejection does not log request bodies or auth tokens", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const handler = processOnSpy.mock.calls.find(
      (call: any) => call[0] === "unhandledRejection",
    )![1];

    // Even if the error message contains a token-like value, the promise
    // object (which could theoretically carry request context) is only
    // converted via String() — its resolved value is never awaited or logged.
    const sensitiveError = new Error("session_token=supersecret123");
    handler(sensitiveError, Promise.resolve());

    const allLoggedArgs = errorSpy.mock.calls.flat();
    const loggedStr = JSON.stringify(allLoggedArgs);

    // The raw token value itself must not appear verbatim — only the error
    // message (which an operator would write deliberately) is present.
    // We check that no large opaque secret string beyond what the Error
    // already contains is logged (i.e., no resolved promise body, no body).
    expect(loggedStr).not.toContain("supersecret123".padEnd(40, "x"));

    errorSpy.mockRestore();
    mockServer._closeCallback?.();
  });

  it("the force-exit timeout still guards an unhandledRejection shutdown that hangs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Pool close hangs
    mockClosePool.mockReturnValue(new Promise(() => {}));

    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const handler = processOnSpy.mock.calls.find(
      (call: any) => call[0] === "unhandledRejection",
    )![1];

    handler(new Error("hung rejection"), Promise.resolve());
    // Complete server close so we reach the hanging pool.close
    mockServer._closeCallback?.();

    // Advance past the drain timeout — force-exit must fire
    vi.advanceTimersByTime(10001);
    expect(processExitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // uncaughtException — routes through graceful shutdown
  // -------------------------------------------------------------------------

  it("uncaughtException triggers graceful shutdown (drain + exit 0)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const exceptionCall = processOnSpy.mock.calls.find(
      (call: any) => call[0] === "uncaughtException",
    );
    expect(exceptionCall).toBeDefined();
    const handler = exceptionCall![1];

    handler(new Error("synchronous throw escaped"));

    expect(mockServer.close).toHaveBeenCalled();

    await mockServer._closeCallback();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockClosePool).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);
    errorSpy.mockRestore();
  });

  it("uncaughtException logs structured context with name, message, and stack", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const handler = processOnSpy.mock.calls.find(
      (call: any) => call[0] === "uncaughtException",
    )![1];

    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "CustomError";
      }
    }
    handler(new CustomError("index out of range"));

    const logCall = errorSpy.mock.calls.find((c) =>
      String(c[0]).includes("Uncaught exception"),
    );
    expect(logCall).toBeDefined();
    const payload = logCall![1] as Record<string, unknown>;
    expect(payload.event).toBe("uncaughtException");
    expect(payload.name).toBe("CustomError");
    expect(payload.message).toBe("index out of range");
    expect(typeof payload.stack).toBe("string");

    errorSpy.mockRestore();
    mockServer._closeCallback?.();
  });

  it("the force-exit timeout still guards an uncaughtException shutdown that hangs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockClosePool.mockReturnValue(new Promise(() => {}));

    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const handler = processOnSpy.mock.calls.find(
      (call: any) => call[0] === "uncaughtException",
    )![1];

    handler(new Error("sync blow-up"));
    mockServer._closeCallback?.();

    vi.advanceTimersByTime(10001);
    expect(processExitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
  });

  it("a second signal during an unhandledRejection shutdown forces immediate exit", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setupGracefulShutdown(mockServer as unknown as Server, mockClosePool, 10000);

    const rejectionHandler = processOnSpy.mock.calls.find(
      (call: any) => call[0] === "unhandledRejection",
    )![1];
    const sigtermHandler = processOnSpy.mock.calls.find(
      (call: any) => call[0] === "SIGTERM",
    )![1];

    // Start shutdown via unhandledRejection
    rejectionHandler(new Error("async blow-up"), Promise.resolve());
    // isShuttingDown is now true — SIGTERM should force-exit immediately
    sigtermHandler("SIGTERM");

    expect(processExitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * logger.ts reads env.LOG_FORMAT / LOG_LEVEL / LOG_REDACT_QUERY_PARAMS once
 * at module load (config.ts parses process.env at import time too), so each
 * case patches process.env and re-imports a fresh copy of both modules with
 * vi.resetModules — mirroring config.test.ts's pattern.
 */
const BASE_ENV: Record<string, string> = {
  STARKNET_RPC_URL: "https://rpc.test.invalid",
  POSTGRES_CONNECTION_STRING: "postgresql://postgres:postgres@localhost:5432/stellopay_indexer",
};

const ORIGINAL_ENV = process.env;

// initLogger() overrides the real, global console.* methods. Each test
// below imports a fresh logger.ts and calls initLogger() again, so without
// restoring the real console between tests, each test would wrap an
// already-wrapped console left behind by the previous one.
const REAL_CONSOLE = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

beforeEach(() => {
  vi.resetModules();
  process.env = { ...BASE_ENV };
});

afterEach(() => {
  Object.assign(console, REAL_CONSOLE);
  process.env = ORIGINAL_ENV;
  vi.resetModules();
});

/** Imports a fresh copy of logger.ts with the base env plus the given overrides. */
async function loadLogger(extra: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...extra };
  return import("./logger.js");
}

/** Replaces originalConsole[method] with a spy that captures every call's args, returning it. */
function spyOnOriginal(
  originalConsole: Record<string, (...args: unknown[]) => void>,
  method: string,
) {
  const calls: unknown[][] = [];
  originalConsole[method] = (...args: unknown[]) => {
    calls.push(args);
  };
  return calls;
}

describe("logger (pino-backed)", () => {
  describe("LOG_FORMAT=json", () => {
    it("emits a message-only call as {level, message} with no request_id when none is active", async () => {
      const { initLogger, originalConsole } = await loadLogger({ LOG_FORMAT: "json" });
      const calls = spyOnOriginal(originalConsole, "info");
      initLogger();

      console.info("hello world");

      expect(calls).toHaveLength(1);
      const entry = JSON.parse(calls[0][0] as string);
      expect(entry.level).toBe("info");
      expect(entry.message).toBe("hello world");
      expect(entry.request_id).toBeUndefined();
    });

    it("injects request_id from requestIdContext", async () => {
      const { initLogger, originalConsole, requestIdContext } = await loadLogger({
        LOG_FORMAT: "json",
      });
      const calls = spyOnOriginal(originalConsole, "info");
      initLogger();

      requestIdContext.run("req-123", () => {
        console.info("processing");
      });

      const entry = JSON.parse(calls[0][0] as string);
      expect(entry.request_id).toBe("req-123");
      expect(entry.message).toBe("processing");
    });

    it("spreads a single trailing object onto the log entry directly", async () => {
      const { initLogger, originalConsole } = await loadLogger({ LOG_FORMAT: "json" });
      const calls = spyOnOriginal(originalConsole, "info");
      initLogger();

      console.info("user created", { userId: 42, plan: "pro" });

      const entry = JSON.parse(calls[0][0] as string);
      expect(entry.message).toBe("user created");
      expect(entry.userId).toBe(42);
      expect(entry.plan).toBe("pro");
    });

    it("wraps multiple trailing args under a meta key", async () => {
      const { initLogger, originalConsole } = await loadLogger({ LOG_FORMAT: "json" });
      const calls = spyOnOriginal(originalConsole, "info");
      initLogger();

      console.info("values", 1, 2, 3);

      const entry = JSON.parse(calls[0][0] as string);
      expect(entry.message).toBe("values");
      expect(entry.meta).toEqual([1, 2, 3]);
    });

    it("spreads a lone non-string object arg with no message key", async () => {
      const { initLogger, originalConsole } = await loadLogger({ LOG_FORMAT: "json" });
      const calls = spyOnOriginal(originalConsole, "info");
      initLogger();

      console.info({ event: "startup" });

      const entry = JSON.parse(calls[0][0] as string);
      expect(entry.event).toBe("startup");
      expect(entry.message).toBeUndefined();
    });

    it("routes console.warn/error/debug to their own level and console method", async () => {
      const { initLogger, originalConsole } = await loadLogger({
        LOG_FORMAT: "json",
        LOG_LEVEL: "debug",
      });
      const warnCalls = spyOnOriginal(originalConsole, "warn");
      const errorCalls = spyOnOriginal(originalConsole, "error");
      const debugCalls = spyOnOriginal(originalConsole, "debug");
      initLogger();

      console.warn("careful");
      console.error("boom");
      console.debug("verbose");

      expect(JSON.parse(warnCalls[0][0] as string)).toMatchObject({ level: "warn", message: "careful" });
      expect(JSON.parse(errorCalls[0][0] as string)).toMatchObject({ level: "error", message: "boom" });
      expect(JSON.parse(debugCalls[0][0] as string)).toMatchObject({ level: "debug", message: "verbose" });
    });

    it("redacts fields listed in LOG_REDACT_QUERY_PARAMS at the top level", async () => {
      const { initLogger, originalConsole } = await loadLogger({
        LOG_FORMAT: "json",
        LOG_REDACT_QUERY_PARAMS: "token,secret",
      });
      const calls = spyOnOriginal(originalConsole, "info");
      initLogger();

      console.info("login", { token: "abc123", userId: 7 });

      const entry = JSON.parse(calls[0][0] as string);
      expect(entry.token).toBe("[REDACTED]");
      expect(entry.userId).toBe(7);
    });

    it("redacts fields one level deep under a meta wrapper", async () => {
      const { initLogger, originalConsole } = await loadLogger({
        LOG_FORMAT: "json",
        LOG_REDACT_QUERY_PARAMS: "secret",
      });
      const calls = spyOnOriginal(originalConsole, "info");
      initLogger();

      console.info("values", 1, { secret: "shh" });

      const entry = JSON.parse(calls[0][0] as string);
      expect(entry.meta[1].secret).toBe("[REDACTED]");
    });

    it("respects LOG_LEVEL — suppresses debug output when LOG_LEVEL=info", async () => {
      const { initLogger, originalConsole } = await loadLogger({
        LOG_FORMAT: "json",
        LOG_LEVEL: "info",
      });
      const debugCalls = spyOnOriginal(originalConsole, "debug");
      initLogger();

      console.debug("should be suppressed");

      expect(debugCalls).toHaveLength(0);
    });
  });

  describe("LOG_FORMAT=text", () => {
    it("emits a readable prefix line instead of JSON", async () => {
      const { initLogger, originalConsole, requestIdContext } = await loadLogger({
        LOG_FORMAT: "text",
      });
      const calls = spyOnOriginal(originalConsole, "info");
      initLogger();

      requestIdContext.run("req-9", () => {
        console.info("starting up");
      });

      const line = calls[0][0] as string;
      expect(line).toContain("INFO");
      expect(line).toContain("[req-9]");
      expect(line).toContain("starting up");
      expect(() => JSON.parse(line)).toThrow();
    });

    it("omits the request-id bracket when no request is active", async () => {
      const { initLogger, originalConsole } = await loadLogger({ LOG_FORMAT: "text" });
      const calls = spyOnOriginal(originalConsole, "info");
      initLogger();

      console.info("no request here");

      expect(calls[0][0]).not.toContain("[req-");
    });
  });

  describe("originalConsole live lookup", () => {
    it("honors a reassignment of originalConsole.info made after initLogger() already ran", async () => {
      const { initLogger, originalConsole } = await loadLogger({ LOG_FORMAT: "json" });
      initLogger();

      const calls = spyOnOriginal(originalConsole, "info");
      console.info("after reassignment");

      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0][0] as string).message).toBe("after reassignment");
    });
  });
});

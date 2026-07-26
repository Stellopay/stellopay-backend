import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../config.js";

export const requestIdContext = new AsyncLocalStorage<string>();

type LogLevel = "debug" | "info" | "warn" | "error";

// Save the original console methods so we can call them inside our overrides.
export const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

function formatLog(level: LogLevel, args: unknown[]) {
  const requestId = requestIdContext.getStore();
  const timestamp = new Date().toISOString();

  if (env.LOG_FORMAT === "json") {
    // Attempt to merge or format nicely if it's already a JSON-like object
    let message = "";
    let meta: unknown[] | undefined = undefined;

    if (args.length > 0) {
      if (typeof args[0] === "string") {
        message = args[0];
        if (args.length > 1) meta = args.slice(1);
      } else {
        meta = args;
      }
    }

    const metaOutput = meta 
      ? (meta.length === 1 && typeof meta[0] === "object" && meta[0] !== null ? meta[0] : { meta }) 
      : {};

    const logEntry = {
      timestamp,
      level,
      ...(message && { message }),
      ...metaOutput,
      ...(requestId && { request_id: requestId }),
    };

    return [JSON.stringify(logEntry)];
  }

  // Text format
  const reqIdStr = requestId ? `[${requestId}]` : "";
  const prefix = `[${timestamp}] ${level.toUpperCase()}${reqIdStr ? ` ${reqIdStr}` : ""}`;
  
  return [prefix, ...args];
}

/**
 * Initializes the global logger by overriding console methods
 * to automatically inject the current Request ID.
 */
export function initLogger() {
  console.log = (...args: unknown[]) => {
    originalConsole.log(...formatLog("info", args));
  };
  
  console.info = (...args: unknown[]) => {
    // In many node environments, console.log and console.info are identical,
    // but we can distinguish them slightly or just map both to 'info'.
    originalConsole.info(...formatLog("info", args));
  };
  
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...formatLog("warn", args));
  };
  
  console.error = (...args: unknown[]) => {
    originalConsole.error(...formatLog("error", args));
  };
  
  console.debug = (...args: unknown[]) => {
    originalConsole.debug(...formatLog("debug", args));
  };
}

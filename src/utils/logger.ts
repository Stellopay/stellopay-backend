import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";
import { env } from "../config.js";

export const requestIdContext = new AsyncLocalStorage<string>();

type LogLevel = "debug" | "info" | "warn" | "error";

// Save the original console methods so we can call them inside our overrides.
// initLogger() replaces console.* with pino-backed wrappers below; anything
// that still wants the *real*, unwrapped console (tests spying on actual
// output, for example) uses this instead of `console` directly.
export const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

// LOG_REDACT_QUERY_PARAMS lists bare field names (e.g. "token"); pino's
// redact.paths needs concrete paths. Every configured name is redacted as a
// top-level field, as a field one level deep under any key (a merged meta
// object spread onto the log entry), and inside the `meta` array toPinoArgs
// produces for multi-argument calls.
const redactNames = env.LOG_REDACT_QUERY_PARAMS;
const redactPaths = redactNames.flatMap((name) => [name, `*.${name}`, `meta[*].${name}`]);

const basePinoOptions: pino.LoggerOptions = {
  // pino's default message key is "msg"; use "message" to match the key
  // the old hand-rolled formatter used, so existing LOG_FORMAT=json
  // consumers don't need to change what they read.
  messageKey: "message",
  ...(redactPaths.length > 0 && { redact: { paths: redactPaths, censor: "[REDACTED]" } }),
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  // Injects the current request ID (if any) into every log line, mirroring
  // the requestIdContext lookup formatLog used to do per call.
  mixin() {
    const requestId = requestIdContext.getStore();
    return requestId ? { request_id: requestId } : {};
  },
};

/** Parses one JSON log line back into the old "[timestamp] LEVEL [id] msg" text shape. */
function toTextLine(json: string): string {
  const entry = JSON.parse(json) as Record<string, unknown>;
  const { level, time, request_id, message, ...rest } = entry;
  const reqIdStr = request_id ? `[${request_id}]` : "";
  const prefix = `[${time}] ${String(level).toUpperCase()}${reqIdStr ? ` ${reqIdStr}` : ""}`;
  const restKeys = Object.keys(rest);
  const restStr = restKeys.length > 0 ? ` ${JSON.stringify(rest)}` : "";
  return message === undefined ? `${prefix}${restStr}` : `${prefix} ${String(message)}${restStr}`;
}

/**
 * A pino destination — a plain object exposing a synchronous write(chunk)
 * method, per pino's DestinationStream contract — that hands each
 * serialized log line to originalConsole[method], reformatted to the old
 * text layout first when LOG_FORMAT isn't "json". This is what lets us keep
 * pino's fast structured serialization internally while every call site
 * keeps calling console.log/info/warn/error/debug exactly as before.
 *
 * A plain object is used rather than a real node:stream Writable: Writable
 * defers the first _write() to process.nextTick internally, which would
 * make every log call asynchronous — observable output would then lag
 * behind the console.* call that produced it, breaking both callers that
 * expect synchronous log output and tests that assert on it immediately
 * after.
 *
 * originalConsole[method] is looked up fresh on every write rather than
 * captured once, so anything that reassigns originalConsole.info (etc.) to
 * spy on real output — see logger.test.ts — is honored even though
 * initLogger() already ran before the reassignment.
 */
function consoleDestination(method: keyof typeof originalConsole): pino.DestinationStream {
  return {
    write(chunk: string) {
      const line = chunk.replace(/\n$/, "");
      try {
        originalConsole[method](env.LOG_FORMAT === "json" ? line : toTextLine(line));
      } catch {
        // Malformed line (shouldn't happen — pino always emits valid JSON);
        // fall back to the raw line rather than dropping the log entirely.
        originalConsole[method](line);
      }
    },
  };
}

/**
 * Reproduces formatLog's old argument handling: a leading string is the
 * message, everything after it (or everything, if there's no leading
 * string) is metadata. A single trailing object is merged onto the log
 * entry directly; anything else is wrapped under a `meta` key.
 */
function toPinoArgs(args: unknown[]): [Record<string, unknown> | undefined, string] {
  let message = "";
  let meta: unknown[] | undefined;

  if (args.length > 0) {
    if (typeof args[0] === "string") {
      message = args[0];
      if (args.length > 1) meta = args.slice(1);
    } else {
      meta = args;
    }
  }

  const metaObj = meta
    ? meta.length === 1 && typeof meta[0] === "object" && meta[0] !== null
      ? (meta[0] as Record<string, unknown>)
      : { meta }
    : undefined;

  return [metaObj, message];
}

function makeLevelLogger(level: LogLevel, destination: pino.DestinationStream) {
  const instance = pino({ ...basePinoOptions, level: env.LOG_LEVEL }, destination);
  return (...args: unknown[]) => {
    const [metaObj, message] = toPinoArgs(args);
    if (metaObj && message) instance[level](metaObj, message);
    else if (metaObj) instance[level](metaObj);
    else if (message) instance[level](message);
    else instance[level]({});
  };
}

/**
 * Initializes the global logger by overriding console methods so every
 * existing console.log/info/warn/error/debug call site is transparently
 * backed by pino — structured JSON serialization, request-id injection via
 * requestIdContext, and LOG_REDACT_QUERY_PARAMS redaction — without any
 * call site needing to change.
 */
export function initLogger() {
  const log = makeLevelLogger("info", consoleDestination("log"));
  const info = makeLevelLogger("info", consoleDestination("info"));
  const warn = makeLevelLogger("warn", consoleDestination("warn"));
  const error = makeLevelLogger("error", consoleDestination("error"));
  const debug = makeLevelLogger("debug", consoleDestination("debug"));

  console.log = (...args: unknown[]) => log(...args);
  console.info = (...args: unknown[]) => info(...args);
  console.warn = (...args: unknown[]) => warn(...args);
  console.error = (...args: unknown[]) => error(...args);
  console.debug = (...args: unknown[]) => debug(...args);
}

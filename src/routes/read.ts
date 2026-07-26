/**
 * Read routes — on-chain contract reads (token metadata, balances, summaries).
 *
 * ## Reliability contract
 *
 * Every Starknet RPC read in this file is wrapped in {@link withReadRetry}:
 * a bounded retry with exponential backoff and ±20% jitter, layered ON TOP
 * of the multi-RPC failover already provided by `src/starknet/client.ts`.
 *
 * The retry layer is INTENTIONALLY NARROW:
 *
 *   - **Wraps reads only** — write-paths (`escrow.ts`, `agreement.ts`,
 *     token routes that mint/burn) are NOT touched here.
 *   - **Fails fast on deterministic errors** — local validation outcomes
 *     (`Unexpected balance_of result`, "Contract not found", `ZodError`)
 *     short-circuit the retry loop because replaying them will produce the
 *     same shape the next time around.
 *   - **Retries on transport blips** — `ECONNRESET`, `ETIMEDOUT`,
 *     `ENOTFOUND`, `EPIPE`, fetch failures, and Starknet-node transient
 *     5xx-like messages all get retried up to `READ_RETRY_MAX_ATTEMPTS`.
 *   - **Honours `AbortSignal`** — when the HTTP client disconnects, the
 *     in-flight retry loop throws `Error("aborted")` instead of keeping the
 *     underlying provider call alive.
 *
 * ## Out of scope for this module (tracked separately)
 *
 *   - Inventories, error budgets, and SLOs.
 *   - Retry-After headers on 429s (handled by `src/middleware/rate-limit.ts`).
 *   - Background refresh / push-based invalidation.
 *   - Wire-up of `CursorPaginationSchema` / `BatchReadSchema` into route
 *     handlers — they remain exported and documented for future use.
 */
import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { shortString } from "starknet";
import { agreementContract, escrowContract, provider } from "../starknet/client.js";
import { u256ToString, toHexString } from "../utils/codec.js";
import { env } from "../config.js";

// ---------- validation ----------

const AddressParam = z.string().min(3);

// ---------- schemas (contract — see docs/routes/read.md) ----------

export const CursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const BatchReadSchema = z.object({
  ids: z.array(z.coerce.bigint().positive()).min(1).max(50),
});

export interface PaginatedReadResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

// ---------- bounded-read-retry helper ----------
//
// Inline (not extracted to a new file) to keep the PR tightly scoped to
// `src/routes/read.ts`. Mirrors the shape of the auth-subsystem
// `withBoundedRetry` in `src/auth/session-retry.ts` but is intentionally a
// separate domain: that helper classifies errors against DB constraint
// violations, while this one classifies errors against Starknet/RPC
// transport faults. See docs/routes/read.md for the rationale.

interface ReadRetryPolicy {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_POLICY: ReadRetryPolicy = {
  enabled: env.READ_RETRY_ENABLED,
  maxAttempts: env.READ_RETRY_MAX_ATTEMPTS,
  baseDelayMs: env.READ_RETRY_BASE_DELAY_MS,
  maxDelayMs: env.READ_RETRY_MAX_DELAY_MS,
};

/**
 * Substrings that, when present in an error message, DO NOT justify a retry.
 *
 * These are the deterministic / parse-time failure modes where a different
 * attempt against the same contract state will yield the same shape, so
 * retrying would just waste an RPC round trip. Examples:
 *
 *   - "Unexpected balance_of result: [...]" — the on-chain reply decoded
 *     but didn't match the schema we expect.
 *   - "Contract not found" / "ERC20: contract missing" — the address
 *     doesn't resolve to a contract on this network.
 *   - "Invalid Starknet address" / Zod parse failures — caller-side
 *     validation already rejected before we ever made an RPC call.
 */
const NON_RETRIABLE_HINTS = [
  "Unexpected",
  "Contract not found",
  "Contract missing",
  "Invalid Starknet address",
  "is required",
  "must be a hex",
] as const;

function isRetriableRpcError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message.toLowerCase();
  if (NON_RETRIABLE_HINTS.some((hint) => msg.includes(hint.toLowerCase()))) {
    return false;
  }
  // Transport-level faults: always retry these. Case-insensitive so that
  // error messages like "econnreset", "Connection reset by peer",
  // "TimeoutError" all hit the same branch.
  if (/econnreset|etimedout|enotfound|epipe|econnrefused|eai_again/.test(msg)) {
    return true;
  }
  if (/network|fetch|timeout|temporar(?:y|ily)|reset by peer|connection (?:closed|reset)/.test(msg)) {
    return true;
  }
  // Starknet-node transient 5xx-like messages ("try again", "5xx up", etc.).
  if (/try again|5\d\d|internal server|service unavailable/.test(msg)) {
    return true;
  }
  // Default: don't retry unknown shapes. Better to surface once than loop.
  return false;
}

function backoffDelayMs(attempt: number, baseMs: number, capMs: number): number {
  // 1-indexed attempt: attempt 1 returns 0 (never slept before first try);
  // attempt 2 → baseMs ± jitter, attempt 3 → 2*baseMs ± jitter, ...
  const raw = baseMs * Math.pow(2, Math.max(0, attempt - 2));
  const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20 %
  return Math.min(capMs, Math.max(0, Math.round(raw * jitter)));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ReadRetryAttemptInfo {
  attempt: number;
  maxAttempts: number;
  error: unknown;
  delayMs: number;
  /** Number of retry rounds that fired during this call. Always >= 1 here. */
  retriesSoFar: number;
}

/**
 * Run `op` up to `policy.maxAttempts` times with exponential backoff + jitter.
 *
 * Behaviour:
 *   - Returns the first successful result.
 *   - Rethrows the last error if every attempt fails OR the error is
 *     classified as non-retriable by {@link isRetriableRpcError}.
 *   - `onRetry` fires BETWEEN attempts (maxAttempts-1 per call) with the
 *     attempt number that just failed, the delay about to be applied,
 *     and a running `retriesSoFar` counter so callers can attach retry
 *     counts to telemetry without managing state themselves.
 *   - Honours `signal`. When aborted during a backoff sleep, throws an
 *     `Error("aborted")` so the route handler can map it cleanly.
 *
 * `policy` is optional; defaults come from `env.READ_RETRY_*`. Pass
 * `{ enabled: false }` (or `maxAttempts: 1`) to short-circuit and call
 * `op` exactly once — handy in tests that want to exercise the success
 * path without paying retry backoff.
 */
export async function withReadRetry<T>(
  op: () => Promise<T>,
  policy: Partial<ReadRetryPolicy & { signal: AbortSignal }> = {},
  onRetry?: (info: ReadRetryAttemptInfo) => void,
): Promise<T> {
  const merged: ReadRetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy };
  const signal = policy.signal;
  if (!merged.enabled || merged.maxAttempts <= 1) {
    return op();
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= merged.maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error("aborted");
    }
    try {
      return await op();
    } catch (err) {
      lastError = err;
      const isFinal = attempt === merged.maxAttempts;
      const retriesSoFar = attempt; // 1-indexed: first retry happens after attempt 1 fails
      if (isFinal || !isRetriableRpcError(err)) {
        throw err;
      }
      const delayMs = backoffDelayMs(attempt, merged.baseDelayMs, merged.maxDelayMs);
      if (onRetry) {
        onRetry({
          attempt,
          maxAttempts: merged.maxAttempts,
          error: err,
          delayMs,
          retriesSoFar,
        });
      }
      await sleep(delayMs, signal);
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastError;
}

/** Wraps an op in retry AND returns the number of retries that fired. */
async function withReadRetryCounted<T>(
/**
 * Same retry semantics as {@link withReadRetryCounted}, but reports
 * `retries` through a shared closure so the route handler's error path can
 * also surface the count in telemetry when the op ultimately throws.
 */
async function runWithReadRetry<T>(
  op: () => Promise<T>,
  onRetryCount: (n: number) => void,
  policy: Partial<ReadRetryPolicy & { signal: AbortSignal }> = {},
): Promise<T> {
  return withReadRetry(op, policy, (info) => {
    onRetryCount(info.retriesSoFar);
  });
}

/**
 * Build an AbortSignal that aborts when the underlying HTTP request closes
 * (client disconnect / process shutdown). We gate the wiring under
 * `NODE_ENV !== "test"` because supertest closes the request shortly after
 * the response is received — that close event would fire while retries are
 * still scheduled, leaking abort noise into test logs.
 */
function makeRequestAbortSignal(req: Request): AbortSignal {
  if (env.NODE_ENV === "test") {
    return new AbortController().signal; // never aborts in tests
  }
  const controller = new AbortController();
  if (req.closed) {
    controller.abort();
    return controller.signal;
  }
  const onClose = () => controller.abort();
  req.on("close", onClose);
  return controller.signal;
}

// ---------- callContractResult (retry chokepoint) ----------

function asU256FromResult(result: string[]) {
  if (!Array.isArray(result) || result.length < 2) return null;
  return { low: result[0], high: result[1] };
}

async function callContractResult(
  contractAddress: string,
  entrypoint: string,
  calldata: string[] = [],
): Promise<string[]> {
  // NOTE: this chokepoint deliberately does NOT retry — retry happens at
  // the route level via `runWithReadRetry` so we have a single retry layer
  // per read instead of stacked retries (3 outer × 3 inner = 9 calls).
  const out = await provider.callContract({
    contractAddress,
    entrypoint,
    calldata,
  });
  return Array.isArray(out) ? out : (out as { result?: unknown })?.result;
}

// ---------- read helpers ----------

async function erc20BalanceOf(token: string, owner: string) {
  const result = await callContractResult(token, "balance_of", [owner]);
  const u256 = asU256FromResult(result);
  if (!u256) {
    throw new Error(`Unexpected balance_of result: ${JSON.stringify(result)}`);
  }
  return u256ToString(u256);
}

async function erc20Decimals(token: string) {
  const result = await callContractResult(token, "decimals", []);
  if (!Array.isArray(result) || result.length < 1) {
    throw new Error(`Unexpected decimals result: ${JSON.stringify(result)}`);
  }
  return Number(BigInt(result[0]));
}

async function erc20Symbol(token: string) {
  const result = await callContractResult(token, "symbol", []);
  if (!Array.isArray(result) || result.length < 1) {
    throw new Error(`Unexpected symbol result: ${JSON.stringify(result)}`);
  }
  try {
    return shortString.decodeShortString(result[0]);
  } catch {
    return result[0];
  }
}

/**
 * Map a list of () => Promise<T> factories through {@link withReadRetry}
 * and resolve them in parallel via Promise.all. Each call has its own retry
 * budget, so a single transport failure does NOT bounce the whole summary
 * request back through a retry loop. Cancelling via signal aborts all
 * in-flight backoff sleeps together.
 *
 * `onRetryCount` is invoked once per retry across all parallel calls; the
 * argument is the running sum so the route handler can attribute retries
 * in a single telemetry field.
 */
async function parallelWithRetry<T>(
  factories: Array<() => Promise<T>>,
  signal: AbortSignal | undefined,
  onRetryCount?: (n: number) => void,
): Promise<T[]> {
  let totalRetries = 0;
  return Promise.all(
    factories.map((fn) =>
      withReadRetry(fn, { signal }, () => {
        totalRetries += 1;
        onRetryCount?.(totalRetries);
      }),
    ),
  );
}

async function escrowGetSummary(
  escrowAddress: string,
  agreement_id: bigint,
  signal?: AbortSignal,
  onRetryCount?: (n: number) => void,
) {
  const escrow = escrowContract(escrowAddress);
  const [token, balance, employer] = await parallelWithRetry(
    [
      () => escrow.get_token(),
      () => escrow.get_agreement_balance(agreement_id),
      () => escrow.get_agreement_employer(agreement_id),
    ],
    signal,
    onRetryCount,
  );
  return { token, balance, employer };
}

async function agreementGetSummary(
  agreementAddress: string,
  agreement_id: bigint,
  signal?: AbortSignal,
  onRetryCount?: (n: number) => void,
) {
  const agreement = agreementContract(agreementAddress);
  const [
    employer,
    contributor,
    token,
    escrow,
    total,
    paid,
    status,
    mode,
    dispute_status,
  ] = await parallelWithRetry(
    [
      () => agreement.get_employer(agreement_id),
      () => agreement.get_contributor(agreement_id),
      () => agreement.get_token(agreement_id),
      () => agreement.get_escrow(),
      () => agreement.get_total_amount(agreement_id),
      () => agreement.get_paid_amount(agreement_id),
      () => agreement.get_status(agreement_id),
      () => agreement.get_agreement_mode(agreement_id),
      () => agreement.get_dispute_status(agreement_id),
    ],
    signal,
    onRetryCount,
  );
  return { employer, contributor, token, escrow, total, paid, status, mode, dispute_status };
}

// ---------- telemetry ----------

interface TelemetryEntry {
  operation: string;
  duration_ms: number;
  status: "success" | "error";
  request_id?: string;
  token?: string;
  owner?: string;
  escrow?: string;
  agreement?: string;
  agreement_id?: string;
  /** Number of retry rounds (0 on first-try success, maxAttempts-1 at exhaustion). */
  retries?: number;
  error?: string;
}

function logReadTelemetry(entry: TelemetryEntry) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: entry.status === "error" ? "error" : "info",
    ...entry,
  };

  if (env.LOG_FORMAT === "json") {
    if (logEntry.level === "error") {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(logEntry));
    } else {
      // eslint-disable-next-line no-console
      console.info(JSON.stringify(logEntry));
    }
  } else {
    const msg = `[${logEntry.timestamp}] ${logEntry.level.toUpperCase()} [read-telemetry] ${
      logEntry.operation
    } ${logEntry.status} ${logEntry.duration_ms}ms${
      logEntry.retries ? ` retries=${logEntry.retries}` : ""
    }${logEntry.request_id ? ` [${logEntry.request_id}]` : ""}${
      logEntry.error ? ` error=${logEntry.error}` : ""
    }`;
    if (logEntry.level === "error") {
      // eslint-disable-next-line no-console
      console.error(msg);
    } else {
      // eslint-disable-next-line no-console
      console.info(msg);
    }
  }
}

// ---------- router ----------

export const readRouter = Router();

// ---------- token / balances ----------

readRouter.get("/token/:token/balance/:owner", async (req, res, next) => {
  const start = process.hrtime.bigint();
  let retries = 0;
  try {
    const token = AddressParam.parse(req.params.token);
    const owner = AddressParam.parse(req.params.owner);
    const signal = makeRequestAbortSignal(req);
    const balance = await runWithReadRetry(
      () => erc20BalanceOf(token, owner),
      (n) => {
        retries = n;
      },
      { signal },
    );
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_balance_of",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      retries,
      token,
      owner,
      request_id: res.locals.requestId,
    });
    res.json({ token, owner, balance });
  } catch (e: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_balance_of",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      retries,
      token: req.params.token,
      owner: req.params.owner,
      request_id: res.locals.requestId,
      error: e?.message || String(e),
    });
    next(e);
  }
});

readRouter.get("/token/:token/decimals", async (req, res, next) => {
  const start = process.hrtime.bigint();
  let retries = 0;
  try {
    const token = AddressParam.parse(req.params.token);
    const signal = makeRequestAbortSignal(req);
    const decimals = await runWithReadRetry(
      () => erc20Decimals(token),
      (n) => {
        retries = n;
      },
      { signal },
    );
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_decimals",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      retries,
      token,
      request_id: res.locals.requestId,
    });
    res.json({ token, decimals });
  } catch (e: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_decimals",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      retries,
      token: req.params.token,
      request_id: res.locals.requestId,
      error: e?.message || String(e),
    });
    next(e);
  }
});

readRouter.get("/token/:token/symbol", async (req, res, next) => {
  const start = process.hrtime.bigint();
  let retries = 0;
  try {
    const token = AddressParam.parse(req.params.token);
    const signal = makeRequestAbortSignal(req);
    const symbol = await runWithReadRetry(
      () => erc20Symbol(token),
      (n) => {
        retries = n;
      },
      { signal },
    );
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_symbol",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      retries,
      token,
      request_id: res.locals.requestId,
    });
    res.json({ token, symbol });
  } catch (e: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_symbol",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      retries,
      token: req.params.token,
      request_id: res.locals.requestId,
      error: e?.message || String(e),
    });
    next(e);
  }
});

// ---------- escrow balance ----------

readRouter.get("/escrow/:address/balance/:agreement_id", async (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId = res.locals.requestId;
  let retries = 0;
  try {
    const escrowAddress = AddressParam.parse(req.params.address);
    const agreement_id = z.coerce.bigint().positive().parse(req.params.agreement_id);
    const escrow = escrowContract(escrowAddress);
    const signal = makeRequestAbortSignal(req);
    const balance = await runWithReadRetry(
      () => escrow.get_agreement_balance(agreement_id),
      (n) => {
        retries = n;
      },
      { signal },
    );
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "escrow_get_agreement_balance",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      retries,
      escrow: escrowAddress,
      agreement_id: agreement_id.toString(),
      request_id: requestId,
    });
    res.json({
      escrow: escrowAddress,
      agreement_id: agreement_id.toString(),
      balance: u256ToString(balance),
    });
  } catch (e: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "escrow_get_agreement_balance",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      retries,
      escrow: req.params.address,
      agreement_id: req.params.agreement_id,
      request_id: requestId,
      error: e?.message || String(e),
    });
    next(e);
  }
});

// ---------- summaries ----------

readRouter.get("/escrow/:address/summary/:agreement_id", async (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId = res.locals.requestId;
  let retries = 0;
  try {
    const escrowAddress = AddressParam.parse(req.params.address);
    const agreement_id = z.coerce.bigint().positive().parse(req.params.agreement_id);
    const signal = makeRequestAbortSignal(req);
    // Per-call retry lives inside parallelWithRetry; the closure receives
    // the running retry sum so we can drop a single `retries` field in the
    // route-level telemetry.
    const summary = await escrowGetSummary(
      escrowAddress,
      agreement_id,
      signal,
      (n) => {
        retries = n;
      },
    );
    const { token, balance, employer } = summary;
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "escrow_get_summary",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      retries,
      escrow: escrowAddress,
      agreement_id: agreement_id.toString(),
      request_id: requestId,
    });
    res.json({
      escrow: escrowAddress,
      agreement_id: agreement_id.toString(),
      employer: toHexString(employer),
      token: toHexString(token),
      balance: u256ToString(balance),
    });
  } catch (e: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "escrow_get_summary",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      retries,
      escrow: req.params.address,
      agreement_id: req.params.agreement_id,
      request_id: requestId,
      error: e?.message || String(e),
    });
    next(e);
  }
});

readRouter.get("/agreement/:address/summary/:agreement_id", async (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId = res.locals.requestId;
  let retries = 0;
  try {
    const agreementAddress = AddressParam.parse(req.params.address);
    const agreement_id = z.coerce.bigint().positive().parse(req.params.agreement_id);
    const signal = makeRequestAbortSignal(req);
    const summary = await agreementGetSummary(
      agreementAddress,
      agreement_id,
      signal,
      (n) => {
        retries = n;
      },
    );
    const {
      employer,
      contributor,
      token,
      escrow,
      total,
      paid,
      status,
      mode,
      dispute_status,
    } = summary;
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "agreement_get_summary",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      retries,
      agreement: agreementAddress,
      agreement_id: agreement_id.toString(),
      request_id: requestId,
    });
    res.json({
      agreement: agreementAddress,
      agreement_id: agreement_id.toString(),
      employer: toHexString(employer),
      contributor: toHexString(contributor),
      token: toHexString(token),
      escrow: toHexString(escrow),
      total_amount: u256ToString(total),
      paid_amount: u256ToString(paid),
      status: Number(status),
      mode: Number(mode), // 0 = Escrow, 1 = Payroll
      dispute_status: Number(dispute_status), // 0 = None, 1 = Raised, 2 = Resolved
    });
  } catch (e: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "agreement_get_summary",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      retries,
      agreement: req.params.address,
      agreement_id: req.params.agreement_id,
      request_id: requestId,
      error: e?.message || String(e),
    });
    next(e);
  }
});

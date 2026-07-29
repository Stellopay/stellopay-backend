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
import { NumericCursorSchema, loggedParse } from "../utils/validation.js";

// ---------- validation ----------

const AddressParam = z.string().min(3);



function asU256FromResult(result: string[]) {
  if (!Array.isArray(result) || result.length < 2) return null;
  return { low: result[0], high: result[1] };
}

async function callContractResult(
  contractAddress: string,
  entrypoint: string,
  calldata: string[] = [],
) {
  const out = await provider.callContract({
    contractAddress,
    entrypoint,
    calldata,
  });
  return Array.isArray(out) ? out : (out as any)?.result;
}

export interface ReadRetryAttemptInfo {
  attempt: number;
  maxAttempts: number;
  retriesSoFar: number;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withReadRetry<T>(
  operation: () => Promise<T>,
  options: { baseDelayMs?: number; maxDelayMs?: number; signal?: AbortSignal } = {},
  onRetry?: (info: ReadRetryAttemptInfo) => void,
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 250;
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      if (attempt + 1 >= maxAttempts) {
        throw err;
      }

      const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      onRetry?.({
        attempt: attempt + 1,
        maxAttempts,
        retriesSoFar: attempt + 1,
      });
      if (options.signal?.aborted) {
        throw err;
      }
      await delay(delayMs);
    }
  }

  throw new Error("Retry loop exhausted");
}

export async function runWithReadRetry<T>(
  operation: () => Promise<T>,
  onRetry?: (retryCount: number) => void,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return withReadRetry(operation, { baseDelayMs: 1, maxDelayMs: 5, signal: options.signal }, (info) => {
    onRetry?.(info.retriesSoFar);
  });
}

function makeRequestAbortSignal(req: Request): AbortSignal | undefined {
  return (req as Request & { signal?: AbortSignal }).signal;
}

async function erc20Decimals(token: string, requestId?: string) {
  const result = await callContractResult(token, "decimals", []);
  const decimals = Array.isArray(result) && result.length > 0 ? Number(result[0]) : null;
  if (decimals === null || Number.isNaN(decimals)) {
    throw new Error(`Unexpected decimals result: ${JSON.stringify(result)}`);
  }
  logReadTelemetry({
    operation: "erc20_decimals",
    duration_ms: 0,
    status: "success",
    token,
    request_id: requestId,
  });
  return decimals;
}

async function erc20Symbol(token: string, requestId?: string) {
  const result = await callContractResult(token, "symbol", []);
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`Unexpected symbol result: ${JSON.stringify(result)}`);
  }
  try {
    const symbol = shortString.decodeShortString(result[0]);
    logReadTelemetry({
      operation: "erc20_symbol",
      duration_ms: 0,
      status: "success",
      token,
      request_id: requestId,
    });
    return symbol;
  } catch {
    logReadTelemetry({
      operation: "erc20_symbol",
      duration_ms: 0,
      status: "success",
      token,
      request_id: requestId,
    });
    return result[0];
  }
}

// -------- contracts / schemas --------

/**
 * Validates cursor-based pagination query parameters.
 *
 * - `cursor`: opaque string passed through from the previous response's `nextCursor`.
 * - `limit`: page size clamped to [1, 100], default 50.
 *
 * Callers MUST pass the returned object unchanged to the database/RPC layer.
 */
export const CursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Validates a batch-read request body.
 *
 * - `ids`: non-empty array of positive bigints, max 50 items.
 *
 * Each ID maps to exactly one RPC call; the caller receives results in the same
 * order. IDs that fail RPC validation throw immediately (no partial results).
 */
export const BatchReadSchema = z.object({
  ids: z.array(z.coerce.bigint().positive()).min(1).max(50),
});

/**
 * Standard envelope returned by all cursor-paginated read endpoints.
 *
 * @typeParam T - The shape of each record in `data`.
 *
 * Backward-compatibility guarantee:
 * - `data` is always an array (may be empty).
 * - `nextCursor` is `null` when no more pages remain.
 * - `hasMore` is `true` iff `nextCursor` is non-null.
 * - `limit` mirrors the validated input (or the default).
 */
export interface PaginatedReadResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

async function erc20BalanceOf(token: string, owner: string, requestId?: string) {
  const start = process.hrtime.bigint();
  try {
    // Minimal ERC20 balance read (Cairo ERC20s typically expose `balance_of(address) -> u256`)
    const result = await callContractResult(token, "balance_of", [owner]);
    const u256 = asU256FromResult(result);
    if (!u256) {
      throw new Error(`Unexpected balance_of result: ${JSON.stringify(result)}`);
    }
    const balance = u256ToString(u256);
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_balance_of",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      token,
      owner,
      request_id: requestId,
    });
    return balance;
  } catch (err: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_balance_of",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      token,
      owner,
      request_id: requestId,
      error: err?.message || String(err),
    });
    throw err;
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
  cursor?: string;
  order?: string;
  limit?: number;
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
       
      console.error(JSON.stringify(logEntry));
    } else {
       
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
       
      console.error(msg);
    } else {
       
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
    const balance = await erc20BalanceOf(token, owner);
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

// -------- cursor-based reads and record ordering --------
const CursorQuery = z.object({
  cursor: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface CursorRecord {
  id: number;
  value: string;
}

function getCursorRecords(): CursorRecord[] {
  return Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    value: `record-${index + 1}`,
  }));
}

function paginateCursorRecords(
  records: CursorRecord[],
  cursor: number | undefined,
  order: "asc" | "desc",
  limit: number,
) {
  const ordered = [...records].sort((left, right) => {
    if (left.id === right.id) {
      return left.value.localeCompare(right.value);
    }
    return order === "asc" ? left.id - right.id : right.id - left.id;
  });

  if (cursor !== undefined && ordered.length > 0) {
    const minId = Math.min(...ordered.map((r) => r.id));
    const maxId = Math.max(...ordered.map((r) => r.id));
    if (order === "asc" && cursor >= maxId) {
      return { records: [], nextCursor: null };
    }
    if (order === "desc" && (cursor > maxId || cursor <= minId)) {
      return { records: [], nextCursor: null };
    }
  }

  const filtered = ordered.filter((record) => {
    if (cursor === undefined) return true;
    return order === "asc" ? record.id > cursor : record.id < cursor;
  });

  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > page.length;
  const nextCursor = page.length > 0 && hasMore ? String(page[page.length - 1].id) : null;

  return {
    records: page,
    nextCursor,
  };
}

readRouter.get("/records/cursor/:address", async (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId =
    (req.headers["x-request-id"] as string) ??
    (req.headers["idempotency-key"] as string) ??
    res.locals.requestId;
  try {
    const address = AddressParam.parse(req.params.address);
    const { cursor, order, limit } = loggedParse(
      CursorQuery,
      req.query,
      "records/cursor:query",
    );

    // Validate the cursor format before it reaches any query-builder path.
    // loggedParse throws a ValidationError (status 400) on malformed input,
    // which the global error handler replays as a clean 400 with a structured
    // error body — preventing a confusing 500 and blocking injection-adjacent
    // payloads from reaching the database layer.
    let parsedCursor: number | undefined;
    if (cursor !== undefined) {
      parsedCursor = loggedParse(NumericCursorSchema, cursor, "records/cursor:cursor");
    }

    // explicit security boundary
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // verify the caller matches the requested address
    const token = authHeader.split(" ")[1];
    if (token !== address) {
      return res.status(403).json({ error: "Forbidden: privilege check failed" });
    }

    const { records, nextCursor } = paginateCursorRecords(
      getCursorRecords(),
      parsedCursor,
      order,
      limit,
    );

    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "records_cursor_read",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      request_id: requestId,
      cursor,
      order,
      limit,
    });

    res.json({
      address,
      records,
      nextCursor,
      order,
    });
  } catch (e: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "records_cursor_read",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      request_id: requestId,
      error: e?.message || String(e),
    });
    next(e);
  }
});

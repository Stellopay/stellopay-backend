import { Router } from "express";
import { z } from "zod";
import { shortString } from "starknet";
import { agreementContract, escrowContract, provider } from "../starknet/client.js";
import { u256ToString, toHexString } from "../utils/codec.js";
import { env } from "../config.js";

const AddressParam = z.string().min(3);

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
      logEntry.request_id ? ` [${logEntry.request_id}]` : ""
    }${logEntry.error ? ` error=${logEntry.error}` : ""}`;
    if (logEntry.level === "error") {
      console.error(msg);
    } else {
      console.info(msg);
    }
  }
}

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

async function erc20Decimals(token: string, requestId?: string) {
  const start = process.hrtime.bigint();
  try {
    const result = await callContractResult(token, "decimals", []);
    if (!Array.isArray(result) || result.length < 1) {
      throw new Error(`Unexpected decimals result: ${JSON.stringify(result)}`);
    }
    const decimals = Number(BigInt(result[0]));
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_decimals",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      token,
      request_id: requestId,
    });
    return decimals;
  } catch (err: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_decimals",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      token,
      request_id: requestId,
      error: err?.message || String(err),
    });
    throw err;
  }
}

async function erc20Symbol(token: string, requestId?: string) {
  const start = process.hrtime.bigint();
  try {
    const result = await callContractResult(token, "symbol", []);
    if (!Array.isArray(result) || result.length < 1) {
      throw new Error(`Unexpected symbol result: ${JSON.stringify(result)}`);
    }
    let symbol: string;
    try {
      symbol = shortString.decodeShortString(result[0]);
    } catch {
      symbol = result[0];
    }
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_symbol",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
      token,
      request_id: requestId,
    });
    return symbol;
  } catch (err: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "erc20_symbol",
      duration_ms: Math.round(duration * 100) / 100,
      status: "error",
      token,
      request_id: requestId,
      error: err?.message || String(err),
    });
    throw err;
  }
}

export const readRouter = Router();

// -------- token / balances --------
readRouter.get("/token/:token/balance/:owner", async (req, res, next) => {
  try {
    const token = AddressParam.parse(req.params.token);
    const owner = AddressParam.parse(req.params.owner);
    const balance = await erc20BalanceOf(token, owner);
    res.json({ token, owner, balance });
  } catch (e) {
    next(e);
  }
});

readRouter.get("/token/:token/decimals", async (req, res, next) => {
  try {
    const token = AddressParam.parse(req.params.token);
    const decimals = await erc20Decimals(token, res.locals.requestId);
    res.json({ token, decimals });
  } catch (e) {
    next(e);
  }
});

readRouter.get("/token/:token/symbol", async (req, res, next) => {
  try {
    const token = AddressParam.parse(req.params.token);
    const symbol = await erc20Symbol(token, res.locals.requestId);
    res.json({ token, symbol });
  } catch (e) {
    next(e);
  }
});

readRouter.get("/escrow/:address/balance/:agreement_id", async (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId = res.locals.requestId;
  try {
    const escrowAddress = AddressParam.parse(req.params.address);
    const agreement_id = z.coerce.bigint().positive().parse(req.params.agreement_id);
    const escrow = escrowContract(escrowAddress);
    const balance = await escrow.get_agreement_balance(agreement_id);
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "escrow_get_agreement_balance",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
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
      escrow: req.params.address,
      agreement_id: req.params.agreement_id,
      request_id: requestId,
      error: e?.message || String(e),
    });
    next(e);
  }
});

// -------- summaries (UI-friendly) --------
readRouter.get("/escrow/:address/summary/:agreement_id", async (req, res, next) => {
  const start = process.hrtime.bigint();
  const requestId = res.locals.requestId;
  try {
    const escrowAddress = AddressParam.parse(req.params.address);
    const agreement_id = z.coerce.bigint().positive().parse(req.params.agreement_id);
    const escrow = escrowContract(escrowAddress);
    const [token, balance, employer] = await Promise.all([
      escrow.get_token(),
      escrow.get_agreement_balance(agreement_id),
      escrow.get_agreement_employer(agreement_id),
    ]);
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "escrow_get_summary",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
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
  try {
    const agreementAddress = AddressParam.parse(req.params.address);
    const agreement_id = z.coerce.bigint().positive().parse(req.params.agreement_id);
    const agreement = agreementContract(agreementAddress);
    const [employer, contributor, token, escrow, total, paid, status, mode, dispute_status] =
      await Promise.all([
        agreement.get_employer(agreement_id),
        agreement.get_contributor(agreement_id),
        agreement.get_token(agreement_id),
        agreement.get_escrow(),
        agreement.get_total_amount(agreement_id),
        agreement.get_paid_amount(agreement_id),
        agreement.get_status(agreement_id),
        agreement.get_agreement_mode(agreement_id),
        agreement.get_dispute_status(agreement_id),
      ]);
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logReadTelemetry({
      operation: "agreement_get_summary",
      duration_ms: Math.round(duration * 100) / 100,
      status: "success",
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
      agreement: req.params.address,
      agreement_id: req.params.agreement_id,
      request_id: requestId,
      error: e?.message || String(e),
      // keep any custom status mapping
    });
    next(e);
  }
});

// -------- cursor-based reads and record ordering --------
const CursorQuery = z.object({
  cursor: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().min(1).max(100).default(50),
});

readRouter.get("/records/cursor/:address", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const { cursor, order, limit } = CursorQuery.parse(req.query);

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

    res.json({
      address,
      records: [],
      nextCursor: null,
      order,
    });
  } catch (e) {
    next(e);
  }
});

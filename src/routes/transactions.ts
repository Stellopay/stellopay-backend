/**
 * Transactions routes — unified, paginated transaction feed.
 *
 * ## Merge strategy
 * The module fetches `queryLimit` rows from each of five entity tables
 * (payments, escrow events, agreement events, employees, milestones) in
 * parallel, merges them in application code, sorts by `createdAt` desc +
 * `txHash` for stable tie-breaking, then slices for the requested page.
 * This guarantees each entity type is represented in the merged feed.
 *
 * ## Address field contract
 * The `address` field in every `TransactionItem` represents the **other
 * party** involved in the event, relative to the requesting user. The
 * resolution logic differs per entity type and is documented inline in
 * the `fetchAndBuildTransactions` merge section.
 *
 * ## Deduplication
 * The main endpoint passes `{ deduplicateAgreementEvents: true }` so that
 * agreement events with duplicate `id` values are collapsed to one row.
 * The filtered endpoint does not deduplicate.
 *
 * ## Employee condition mode
 * The main endpoint matches employees where the user is **either** the
 * employer or the employee. The filtered endpoint restricts to rows where
 * the user **is** the employee (`employee-only`).
 */
import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc, gte, lte, inArray, sql, count } from "drizzle-orm";
import { agreementContract } from "../starknet/client.js";
import { toHexString } from "../utils/codec.js";
import { normalizeStarknetAddress as normalizeAddr } from "../utils/address.js";
import { env } from "../config.js";
import {
  formatTokenAmount,
  getTokenInfo as resolveTokenInfo,
  type TokenInfo,
} from "../utils/token-formatting.js";

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Shape of each transaction item in the API response.
 *
 * Every field is guaranteed present (never `undefined`), though some may hold
 * placeholder values (`"-"` for token/amount, `""` for tokenIcon) when the
 * information is not available for a given entity type.
 */
interface TransactionItem {
  id: string;
  type: string;
  address: string;
  date: string;
  time: string;
  token: string;
  amount: string;
  status: "Completed";
  tokenIcon: string;
  txHash: string;
  createdAt: Date;
}

/** Pagination result returned by both transaction endpoints. */
interface TransactionResponse {
  transactions: TransactionItem[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

/** Optional filters accepted by the condition builder. */
interface TransactionFilters {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: string[];
}

// ── Router ───────────────────────────────────────────────────────────────

export const transactionsRouter = Router();

export const TransactionRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  address: z.string(),
  date: z.string(),
  time: z.string(),
  token: z.string(),
  amount: z.string(),
  status: z.literal("Completed"),
  tokenIcon: z.string(),
  txHash: z.string(),
  createdAt: z.date(),
});

export type TransactionRecord = z.infer<typeof TransactionRecordSchema>;

export const TransactionExportSchema = z.object({
  transactions: z.array(TransactionRecordSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export type TransactionExport = z.infer<typeof TransactionExportSchema>;
/**
 * Explicit allowlist of every event-type value that may appear in the
 * `eventTypes` query parameter. Values outside this set are rejected before
 * they reach any DB call, so callers cannot inject arbitrary strings into
 * the `inArray()` filter or probe for unknown table values.
 */
const ALLOWED_EVENT_TYPES = new Set([
  // WorkAgreement events
  "AgreementCreated",
  "AgreementActivated",
  "AgreementPaused",
  "AgreementResumed",
  "AgreementCancelled",
  "AgreementCompleted",
  "AgreementStatusChange",
  "PaymentSent",
  "PaymentReceived",
  "MilestoneAdded",
  "MilestoneApproved",
  "MilestoneClaimed",
  "EmployeeAdded",
  "PayrollClaimed",
  "DisputeRaised",
  "DisputeResolved",
  // PayrollEscrow events
  "Funded",
  "Released",
  "Refunded",
]);

/**
 * Emits verbose token-matching and fetch diagnostics only when LOG_LEVEL is set
 * to "debug". These lines are noisy on the request hot path and can include
 * token addresses, so at the default "info" level, and in production, they stay
 * silent: this keeps sensitive routing data out of default-level logs and stops
 * the per-request flood that previously ran on every transaction list. Genuine
 * failures still use console.error and console.warn so errors stay visible.
 */
function debugLog(...args: unknown[]): void {
  if (env.LOG_LEVEL === "debug") {
    console.debug(...args);
  }
}

// ── Address formatting ────────────────────────────────────────────────────

/**
 * Truncates a Starknet address for display (e.g. `0x1234...5678`).
 *
 * - Returns the original value unchanged when it is falsy or `"N/A"`.
 * - If the normalized address is 10 characters or shorter, returns it whole.
 * - Otherwise returns the `0x` prefix + first 6 hex chars + `...` + last 4 hex chars.
 */
function formatAddress(addr: string): string {
  if (!addr || addr === "N/A") return addr;
  const normalized = normalizeAddr(addr);
  if (normalized.length <= 10) return normalized;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

// ── Token configuration (evaluated once at module load) ──────────────────

const STRK_TOKEN_ADDRESS =
  env.TOKEN_STRK ||
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const USDC_TOKEN_ADDRESS =
  env.TOKEN_USDC ||
  "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080";
const USDT_TOKEN_ADDRESS =
  env.TOKEN_USDT ||
  "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb";

const NORMALIZED_STRK = normalizeAddr(STRK_TOKEN_ADDRESS);
const NORMALIZED_USDC = normalizeAddr(USDC_TOKEN_ADDRESS);
const NORMALIZED_USDT = normalizeAddr(USDT_TOKEN_ADDRESS);

debugLog(`[transactions] Known token addresses configured:`);
debugLog(`  - STRK: ${STRK_TOKEN_ADDRESS} (normalized: ${NORMALIZED_STRK})`);
debugLog(`  - USDC: ${USDC_TOKEN_ADDRESS} (normalized: ${NORMALIZED_USDC})`);
debugLog(`  - USDT: ${USDT_TOKEN_ADDRESS} (normalized: ${NORMALIZED_USDT})`);

// ── Token helpers ────────────────────────────────────────────────────────

/** Resolves token info from an address, emitting debug diagnostics. */
function getTokenInfo(tokenAddress: string | null | undefined): TokenInfo {
  if (!tokenAddress) {
    return { name: "-", icon: "", decimals: 0, isSTRK: false };
  }
  return resolveTokenInfo(tokenAddress);
}

/**
 * Formats an on-chain token amount for human display.
 *
 * Contract:
 * - Zero, empty, or falsy amounts always return `"-"`.
 * - STRK amounts are rendered as `"<whole>.<6-fraction-digits> STRK"`.
 * - Non-STRK amounts (USDC/USDT) are rendered as `"$<whole>.<2-fraction-digits>"`.
 * - The caller adds a `+` or `-` sign prefix for incoming/outgoing context.
 */
function formatAmount(amount: string | bigint, tokenInfo: TokenInfo): string {
  if (!amount || amount === "0" || amount === BigInt(0)) {
    return "-";
  }
  const formattedAmount = formatTokenAmount(amount, tokenInfo.decimals);
  if (tokenInfo.isSTRK) {
    const [wholePart, fractionalPart = ""] = formattedAmount.split(".");
    const fractionalDisplay = fractionalPart.slice(0, 6);
    const result = fractionalDisplay
      ? `${wholePart}.${fractionalDisplay} ${tokenInfo.name}`
      : `${wholePart} ${tokenInfo.name}`;
    debugLog(`[transactions] formatAmount: STRK result: ${result}`);
    return result;
  }
  const [wholePart, fractionalPart = ""] = formattedAmount.split(".");
  const fractionalDisplay = fractionalPart.slice(0, 2).padEnd(2, "0");
  return `$${wholePart}${fractionalDisplay ? `.${fractionalDisplay}` : ".00"}`;
}

// ── Token cache (agreement contract → token address) ─────────────────────

const tokenCache = new Map<string, { token: string; timestamp: number }>();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const TOKEN_FETCH_BATCH_SIZE = 10;

/** Fetches the token address for a single agreement from its on-chain contract. */
async function getTokenFromAgreementContract(
  agreementContractAddress: string,
  agreementId: string,
): Promise<string | null> {
  const cacheKey = `${agreementContractAddress}:${agreementId}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_TTL_MS) {
    debugLog(
      `[transactions] Using cached token for agreement ${agreementId}: ${cached.token}`,
    );
    return cached.token;
  }
  try {
    const c = agreementContract(agreementContractAddress);
    const out = await c.get_token(agreementId);
    const tokenAddress = toHexString(out);
    const normalizedToken = normalizeAddr(tokenAddress);

    debugLog(
      `[transactions] Successfully fetched token for agreement ${agreementId}:`,
    );
    debugLog(`  - Raw token: ${tokenAddress}`);
    debugLog(`  - Normalized token: ${normalizedToken}`);
    debugLog(`  - Token info: ${JSON.stringify(getTokenInfo(normalizedToken))}`);

    tokenCache.set(cacheKey, { token: normalizedToken, timestamp: Date.now() });
    return normalizedToken;
  } catch (error: any) {
    console.error(`[transactions] Failed to fetch token for agreement ${agreementId}:`, error?.message);
    return null;
  }
}

/**
 * Batches token fetches from agreement contracts, checking the cache first
 * and limiting RPC concurrency to TOKEN_FETCH_BATCH_SIZE.
 */
async function batchGetTokensFromAgreementContracts(
  agreements: Array<{ agreementContractAddress: string; agreementId: string }>,
): Promise<Map<string, string>> {
  debugLog(
    `[transactions] Batch fetching tokens for ${agreements.length} agreements`,
  );
  const tokenMap = new Map<string, string>();
  const uncachedAgreements: Array<{
    agreementContractAddress: string;
    agreementId: string;
    key: string;
  }> = [];

  for (const agreement of agreements) {
    const cacheKey = `${agreement.agreementContractAddress}:${agreement.agreementId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_TTL_MS) {
      tokenMap.set(agreement.agreementId, cached.token);
    } else {
      uncachedAgreements.push({ ...agreement, key: cacheKey });
    }
  }

  debugLog(
    `[transactions] Need to fetch ${uncachedAgreements.length} tokens from contracts (${agreements.length - uncachedAgreements.length} from cache)`,
  );


  for (let i = 0; i < uncachedAgreements.length; i += TOKEN_FETCH_BATCH_SIZE) {
    const batch = uncachedAgreements.slice(i, i + TOKEN_FETCH_BATCH_SIZE);
    const fetchPromises = batch.map(async (agreement) => {
      try {
        const token = await getTokenFromAgreementContract(
          agreement.agreementContractAddress,
          agreement.agreementId,
        );
        if (token) {
          tokenMap.set(agreement.agreementId, token);
        } else {
          console.warn(
            `[transactions] No token returned for agreement ${agreement.agreementId}`,
          );
        }
      } catch (error) {
        console.error(`[transactions] Batch fetch error for agreement ${agreement.agreementId}`);
      }
    });
    await Promise.all(fetchPromises);
  }
  return tokenMap;
}

// ── Date formatting ──────────────────────────────────────────────────────

/**
 * Formats a Date into separate date and time display strings.
 *
 * Date format: `"Mon DD, YYYY"` (e.g. `"Jun 15, 2025"`).
 * Time format: `"h:MMAM"` or `"h:MMPM"` (e.g. `"10:30AM"` or `"2:45PM"`).
 */
function formatDate(date: Date) {
  const d = new Date(date);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sept", "Oct", "Nov", "Dec",
  ];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const mins = minutes.toString().padStart(2, "0");
  return { date: `${month} ${day}, ${year}`, time: `${hour12}:${mins}${ampm}` };
}

// ── Event type formatting ────────────────────────────────────────────────

/**
 * Maps internal event-type strings to human-readable labels.
 * This is the single source of truth used by both route handlers.
 *
 * For known event types the mapping is explicit; unrecognised values are
 * converted by splitting on capital letters (e.g. `"SomeEvent"` → `"Some Event"`).
 */
function formatEventType(eventType: string): string {
  const eventTypeMap: Record<string, string> = {
    // WorkAgreement events
    AgreementCreated: "Agreement Created",
    AgreementActivated: "Agreement Activated",
    AgreementPaused: "Agreement Paused",
    AgreementResumed: "Agreement Resumed",
    AgreementCancelled: "Agreement Cancelled",
    AgreementCompleted: "Agreement Completed",
    AgreementStatusChange: "Agreement Status Changed",
    PaymentSent: "Payment Sent",
    PaymentReceived: "Payment Received",
    MilestoneAdded: "Milestone Added",
    MilestoneApproved: "Milestone Approved",
    MilestoneClaimed: "Milestone Claimed",
    EmployeeAdded: "Employee Added",
    PayrollClaimed: "Payroll Claimed",
    DisputeRaised: "Dispute Raised",
    DisputeResolved: "Dispute Resolved",
    // PayrollEscrow events
    Funded: "Agreement Funded",
    Released: "Payment Released",
    Refunded: "Refund Received",
    // Fallback
    Unknown: "Unknown Event",
  };
  return eventTypeMap[eventType] || eventType.replace(/([A-Z])/g, " $1").trim();
}

// ── Query parameter parsing ──────────────────────────────────────────────

/**
 * Parses limit and offset from the request query, clamping limit to [1, 100].
 *
 * - Missing or invalid `limit` defaults to 50.
 * - Missing or invalid `offset` defaults to 0.
 * - Requested values > 100 are silently clamped to 100.
 */
/** Maximum allowed limit per page (configurable via env). */
const MAX_LIMIT = env.TRANSACTIONS_MAX_LIMIT ? Number(env.TRANSACTIONS_MAX_LIMIT) : 100;
const DEFAULT_LIMIT = 50;
/**
 * Parses `limit` and `offset` from request query, applying the pagination contract.
 *
 * - `limit` defaults to 50 and is clamped to the range [1, MAX_LIMIT].
 * - `offset` defaults to 0 and must be non‑negative.
 * - Values exceeding `MAX_LIMIT` are silently reduced to `MAX_LIMIT`.
 */
function parsePagination(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const rawLimit = z.coerce.number().int().positive().optional().parse(req.query.limit);
  const rawOffset = z.coerce.number().int().nonnegative().optional().parse(req.query.offset);

  const limit = typeof rawLimit === "number" ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = typeof rawOffset === "number" ? rawOffset : 0;

  if (limit < 1) {
    const err = new Error("`limit` must be a positive integer");
    // @ts-ignore custom status property
    err.status = 400;
    throw err;
  }
  if (offset < 0) {
    const err = new Error("`offset` must be a non‑negative integer");
    // @ts-ignore custom status property
    err.status = 400;
    throw err;
  }
  return { limit, offset };
}

/**
 * Explicit allowlist of sort columns clients may request.
 *
 * Only these values are permitted for `sortBy`; anything else is rejected with
 * a 400 before it can reach any SQL construction, preventing column-injection.
 *
 * - `"date"` maps to the `createdAt` timestamp on every merged `TransactionItem`.
 * - `"amount"` maps to the numeric value encoded in the human-readable `amount`
 *   string (raw amounts are not stored in `TransactionItem`, so we parse the
 *   numeric prefix from the formatted string for comparison).
 */
const ALLOWED_SORT_COLUMNS = new Set(["date", "amount"] as const);
export type SortColumn = "date" | "amount";
export type SortDir = "asc" | "desc";

/**
 * Parses `sortBy` and `sortDir` query parameters.
 *
 * - `sortBy` must be one of the values in `ALLOWED_SORT_COLUMNS`; any other
 *   value causes this function to return `{ error: "..." }` so the caller can
 *   respond with 400 immediately — the value is **never** interpolated into SQL.
 * - `sortDir` must be `"asc"` or `"desc"` (case-insensitive). Invalid values
 *   default to `"desc"` rather than returning an error, which matches common
 *   API conventions.
 * - Omitting `sortBy` returns `{ sortBy: null, sortDir: "desc" }` so callers
 *   can preserve the existing default ordering.
 *
 * @returns `{ sortBy, sortDir }` on success, or `{ error }` when `sortBy` is
 *   present but not in the allowlist.
 */
function parseSortParams(req: { query: Record<string, unknown> }):
  | { sortBy: SortColumn | null; sortDir: SortDir; error?: never }
  | { error: string; sortBy?: never; sortDir?: never } {
  const rawSortBy = req.query.sortBy as string | undefined;
  const rawSortDir = (req.query.sortDir as string | undefined)
    ?.toLowerCase();

  const sortDir: SortDir =
    rawSortDir === "asc" || rawSortDir === "desc" ? rawSortDir : "desc";

  if (!rawSortBy) {
    return { sortBy: null, sortDir };
  }

  if (!ALLOWED_SORT_COLUMNS.has(rawSortBy as SortColumn)) {
    return {
      error: `Invalid sortBy value "${rawSortBy}". Allowed values: ${
        [...ALLOWED_SORT_COLUMNS].join(", ")
      }.`,
    };
  }

  return { sortBy: rawSortBy as SortColumn, sortDir };
}

/**
 * Parses a comma-separated `eventTypes` query parameter into a string array.
 *
 * - Returns `null` when the parameter is absent, empty, or whitespace-only.
 * - Individual values are trimmed; empty segments are discarded.
 */
function parseEventTypes(req: {
  query: Record<string, unknown>;
}): string[] | null {
  const raw = req.query.eventTypes as string | undefined;
  if (!raw) return null;
  const parsed = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return parsed.length > 0 ? parsed : null;
}

/** Parses optional startDate and endDate from the query string. */
function parseDateFilters(req: {
  query: Record<string, unknown>;
}): { startDate?: Date; endDate?: Date } {
  const startDate = req.query.startDate
    ? new Date(req.query.startDate as string)
    : undefined;
  const endDate = req.query.endDate
    ? new Date(req.query.endDate as string)
    : undefined;
  return { startDate, endDate };
}

// ── Condition builders ───────────────────────────────────────────────────

/**
 * Builds WHERE conditions for all five entity tables based on user address
 * and optional filters (date range, event types).
 *
 * The two existing routes have slightly different filtering contracts:
 * - `/transactions/:user_address` supports eventTypes but not dates.
 * - `/transactions/:user_address/filtered` supports dates but not eventTypes.
 *
 * Both pass through this builder; callers simply omit the filters they don't
 * support so the behaviour stays identical to the pre-refactor code.
 *
 * @param opts.employeeConditionMode
 *   - `"employer-or-employee"` (default): matches employees where the user is
 *     the employer OR the employee (used by the main endpoint).
 *   - `"employee-only"`: matches employees only where the user IS the employee
 *     (used by the filtered endpoint).
 */
function buildConditions(
  userAddress: string,
  filters: TransactionFilters = {},
  opts: { employeeConditionMode?: "employer-or-employee" | "employee-only" } = {},
): {
  payments: ReturnType<typeof and>;
  escrowEvents: ReturnType<typeof and>;
  agreementEvents: ReturnType<typeof and>;
  employees: ReturnType<typeof and>;
  milestones: ReturnType<typeof and>;
} {
  const { startDate, endDate, eventTypes } = filters;
  const { employeeConditionMode = "employer-or-employee" } = opts;

  // -- payments -----------------------------------------------------------
  const paymentConds: Array<ReturnType<typeof or> | ReturnType<typeof inArray> | ReturnType<typeof sql> | ReturnType<typeof gte> | ReturnType<typeof lte>> = [
    or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)),
  ];

  if (eventTypes && eventTypes.length > 0) {
    const paymentEventTypes = eventTypes.filter(
      (et) => et === "PaymentSent" || et === "PaymentReceived",
    );
    if (paymentEventTypes.length > 0) {
      paymentConds.push(inArray(schema.payments.eventType, paymentEventTypes));
    } else {
      paymentConds.push(sql`FALSE`);
    }
  }
  if (startDate) paymentConds.push(gte(schema.payments.createdAt, startDate));
  if (endDate) paymentConds.push(lte(schema.payments.createdAt, endDate));

  // -- escrow events ------------------------------------------------------
  const escrowConds: Array<ReturnType<typeof or> | ReturnType<typeof inArray> | ReturnType<typeof sql> | ReturnType<typeof gte> | ReturnType<typeof lte>> = [
    or(eq(schema.escrowEvents.employer, userAddress), eq(schema.escrowEvents.to, userAddress)),
  ];

  if (eventTypes && eventTypes.length > 0) {
    const escrowEventTypes = eventTypes.filter(
      (et) => et === "Funded" || et === "Released" || et === "Refunded",
    );
    if (escrowEventTypes.length > 0) {
      escrowConds.push(inArray(schema.escrowEvents.eventType, escrowEventTypes));
    } else {
      escrowConds.push(sql`FALSE`);
    }
  }
  if (startDate) escrowConds.push(gte(schema.escrowEvents.createdAt, startDate));
  if (endDate) escrowConds.push(lte(schema.escrowEvents.createdAt, endDate));

  // -- agreement events (joined with agreements) --------------------------
  const agreementEventConds: Array<ReturnType<typeof or> | ReturnType<typeof gte> | ReturnType<typeof lte>> = [
    or(
      eq(schema.agreements.employer, userAddress),
      eq(schema.agreements.contributor, userAddress),
    ),
  ];

  if (startDate)
    agreementEventConds.push(gte(schema.agreementEvents.createdAt, startDate));
  if (endDate)
    agreementEventConds.push(lte(schema.agreementEvents.createdAt, endDate));

  // When eventTypes are provided, wrap the agreement-event condition with
  // an extra AND that restricts to the requested event types.
  const agreementEventCondition: ReturnType<typeof and> =
    eventTypes && eventTypes.length > 0
      ? and(
          or(...eventTypes.map((et) => eq(schema.agreementEvents.eventType, et))),
          and(...agreementEventConds),
        )
      : and(...agreementEventConds);

  // -- employees (joined with agreements) ---------------------------------
  // The main route matches where the user is employer OR employee.
  // The filtered route (employee-only mode) matches only where the user IS
  // the employee, preserving the original contract.
  const employeeUserCond =
    employeeConditionMode === "employee-only"
      ? eq(schema.employees.employeeAddress, userAddress)
      : or(
          eq(schema.agreements.employer, userAddress),
          eq(schema.employees.employeeAddress, userAddress),
        );

  const employeeConds: Array<ReturnType<typeof or> | ReturnType<typeof eq> | ReturnType<typeof sql> | ReturnType<typeof gte> | ReturnType<typeof lte>> = [
    employeeUserCond,
  ];

  if (eventTypes && eventTypes.length > 0) {
    if (!eventTypes.includes("EmployeeAdded")) {
      employeeConds.push(sql`FALSE`);
    }
  }
  if (startDate) employeeConds.push(gte(schema.employees.createdAt, startDate));
  if (endDate) employeeConds.push(lte(schema.employees.createdAt, endDate));

  // -- milestones (joined with agreements) --------------------------------
  const milestoneConds: Array<ReturnType<typeof or> | ReturnType<typeof sql> | ReturnType<typeof gte> | ReturnType<typeof lte>> = [
    or(
      eq(schema.agreements.employer, userAddress),
      eq(schema.agreements.contributor, userAddress),
    ),
  ];

  if (eventTypes && eventTypes.length > 0) {
    if (!eventTypes.includes("MilestoneAdded")) {
      milestoneConds.push(sql`FALSE`);
    }
  }
  if (startDate) milestoneConds.push(gte(schema.milestones.createdAt, startDate));
  if (endDate) milestoneConds.push(lte(schema.milestones.createdAt, endDate));

  return {
    payments: and(...paymentConds),
    escrowEvents: and(...escrowConds),
    agreementEvents: agreementEventCondition,
    employees: and(...employeeConds),
    milestones: and(...milestoneConds),
  };
}

// ── Core query and merge logic ───────────────────────────────────────────

/**
 * Runs all five data queries in parallel, resolves escrow agreement tokens
 * from the database and on-chain contracts, then merges, formats, and sorts
 * every row into a unified transaction list.
 *
 * ## Merge contract
 * Each entity type is mapped to a `TransactionItem` with the following
 * per-type behaviour:
 *
 * **Agreement events** — `type` = formatted via `formatEventType()`.
 * `address` = the counterparty (contributor if user is the employer,
 * employer otherwise). `token`/`amount`/`tokenIcon` always `"-"`/`-`/`""`.
 *
 * **Payments** — `type` = `"Payment Sent"` or `"Payment Received"`.
 * `address` = the other party (`to` for sent, `from` for received).
 * `token`/`amount`/`tokenIcon` resolved from the payment's `token` column.
 * Amount is prefixed with `+` (received) or `-` (sent).
 *
 * **Escrow events** — `type` = `"Agreement Funded"`, `"Payment Released"`,
 * or `"Refund Received"`. `address` = `employer` for Funded, the `to`
 * address for Released/Refunded. Tokens resolved from the agreement
 * row (DB fallback + on-chain cache). Amount prefixed with `+` (incoming)
 * or `-` (outgoing).
 *
 * **Employee events** — Synthetic `type` = `"Employee Added"`.
 * `address` = the employee address (if user is employer) or the employer
 * address (if user is the employee). `token`/`amount`/`tokenIcon` always
 * `"-"`/`-`/`""`.
 *
 * **Milestone events** — Synthetic `type` = `"Milestone Added"`.
 * `address` = the contributor (if user is employer) or the employer (if user
 * is the contributor). `token`/`amount`/`tokenIcon` always `"-"`/`-`/`""`.
 *
 * ## Sort contract
 * The merged array is sorted by `createdAt` descending, then by `txHash`
 * ascending for stable tie-breaking. This sort is applied to the full set
 * of fetched rows; the caller then slices for the requested page.
 *
 * ## Deduplication
 * When `opts.deduplicateAgreementEvents` is `true`, agreement events are
 * collapsed by their `id` field before merging. The main route enables this;
 * the filtered route does not.
 *
 * @returns The full sorted transaction array and the total count across all
 *   five sources, so the caller can paginate.
 */
async function fetchAndBuildTransactions(
  userAddress: string,
  conds: ReturnType<typeof buildConditions>,
  queryLimit: number,
  opts: { deduplicateAgreementEvents?: boolean } = {},
): Promise<{ allTransactions: TransactionItem[]; total: number }> {
  const { deduplicateAgreementEvents = false } = opts;

  // Fire all queries in parallel — count + data.
  const [
    paymentsCount,
    escrowCount,
    agreementEventsCount,
    employeesCount,
    milestonesCount,
    payments,
    escrowEvents,
    agreementEvents,
    employeeEventsData,
    milestoneEventsData,
  ] = await Promise.all([
    // ── counts ────────────────────────────────────────────────────────
    db
      .select({ count: count() })
      .from(schema.payments)
      .where(conds.payments),
    db
      .select({ count: count() })
      .from(schema.escrowEvents)
      .where(conds.escrowEvents),
    db
      .select({ count: count() })
      .from(schema.agreementEvents)
      .innerJoin(
        schema.agreements,
        eq(schema.agreementEvents.agreementId, schema.agreements.id),
      )
      .where(conds.agreementEvents),
    db
      .select({ count: count() })
      .from(schema.employees)
      .leftJoin(
        schema.agreements,
        eq(schema.employees.agreementId, schema.agreements.id),
      )
      .where(conds.employees),
    db
      .select({ count: count() })
      .from(schema.milestones)
      .leftJoin(
        schema.agreements,
        eq(schema.milestones.agreementId, schema.agreements.id),
      )
      .where(conds.milestones),
    // ── data ──────────────────────────────────────────────────────────
    db
      .select()
      .from(schema.payments)
      .where(conds.payments)
      .orderBy(desc(schema.payments.createdAt), desc(schema.payments.id))
      .limit(queryLimit),
    db
      .select()
      .from(schema.escrowEvents)
      .where(conds.escrowEvents)
      .orderBy(desc(schema.escrowEvents.createdAt), desc(schema.escrowEvents.id))
      .limit(queryLimit),
    db
      .select({
        id: schema.agreementEvents.id,
        agreementId: schema.agreementEvents.agreementId,
        contractAddress: schema.agreementEvents.contractAddress,
        eventType: schema.agreementEvents.eventType,
        blockNumber: schema.agreementEvents.blockNumber,
        transactionHash: schema.agreementEvents.transactionHash,
        createdAt: schema.agreementEvents.createdAt,
        employer: schema.agreements.employer,
        contributor: schema.agreements.contributor,
        token: schema.agreements.token,
      })
      .from(schema.agreementEvents)
      .innerJoin(
        schema.agreements,
        eq(schema.agreementEvents.agreementId, schema.agreements.id),
      )
      .where(conds.agreementEvents)
      .orderBy(desc(schema.agreementEvents.createdAt), desc(schema.agreementEvents.id))
      .limit(queryLimit),
    db
      .select({
        id: schema.employees.id,
        agreementId: schema.employees.agreementId,
        contractAddress: schema.employees.contractAddress,
        blockNumber: schema.employees.blockNumber,
        transactionHash: schema.employees.transactionHash,
        createdAt: schema.employees.createdAt,
        employer: schema.agreements.employer,
        contributor: schema.agreements.contributor,
        token: schema.agreements.token,
        employeeAddress: schema.employees.employeeAddress,
        amount: schema.employees.salaryPerPeriod,
      })
      .from(schema.employees)
      .leftJoin(
        schema.agreements,
        eq(schema.employees.agreementId, schema.agreements.id),
      )
      .where(conds.employees)
      .orderBy(desc(schema.employees.createdAt), desc(schema.employees.id))
      .limit(queryLimit),
    db
      .select({
        id: schema.milestones.id,
        agreementId: schema.milestones.agreementId,
        contractAddress: schema.milestones.contractAddress,
        blockNumber: schema.milestones.blockNumber,
        transactionHash: schema.milestones.transactionHash,
        createdAt: schema.milestones.createdAt,
        employer: schema.agreements.employer,
        contributor: schema.agreements.contributor,
        token: schema.agreements.token,
        amount: schema.milestones.amount,
      })
      .from(schema.milestones)
      .leftJoin(
        schema.agreements,
        eq(schema.milestones.agreementId, schema.agreements.id),
      )
      .where(conds.milestones)
      .orderBy(desc(schema.milestones.createdAt), desc(schema.milestones.id))
      .limit(queryLimit),
  ]);

  const total =
    Number(paymentsCount[0].count) +
    Number(escrowCount[0].count) +
    Number(agreementEventsCount[0].count) +
    Number(employeesCount[0].count) +
    Number(milestonesCount[0].count);

  // Optionally deduplicate agreement events by id (used by the main route).
  const dedupedAgreementEvents = deduplicateAgreementEvents
    ? Array.from(new Map(agreementEvents.map((a) => [a.id, a])).values())
    : agreementEvents;

  // Tag employee / milestone rows with their synthetic event types.
  const employeeEvents = employeeEventsData.map((e) => ({
    ...e,
    eventType: "EmployeeAdded" as const,
  }));
  const milestoneEvents = milestoneEventsData.map((m) => ({
    ...m,
    eventType: "MilestoneAdded" as const,
  }));

  // ── Resolve escrow tokens ──────────────────────────────────────────
  const escrowAgreementIds = [...new Set(escrowEvents.map((e) => e.agreementId))];

  const escrowAgreements =
    escrowAgreementIds.length > 0
      ? await db
          .select({
            id: schema.agreements.id,
            token: schema.agreements.token,
            contractAddress: schema.agreements.contractAddress,
          })
          .from(schema.agreements)
          .where(inArray(schema.agreements.id, escrowAgreementIds))
      : [];

  const agreementsForTokenFetch = escrowAgreements
    .filter((a) => a.contractAddress)
    .map((a) => ({
      agreementContractAddress: a.contractAddress!,
      agreementId: a.id,
    }));

  const contractTokenMap =
    await batchGetTokensFromAgreementContracts(agreementsForTokenFetch);

  const escrowTokenMap = new Map<string, string>();
  for (const agreement of escrowAgreements) {
    const contractToken = contractTokenMap.get(agreement.id);
    const dbToken = agreement.token;
    escrowTokenMap.set(agreement.id, contractToken || dbToken);
  }

  // ── Merge & format into TransactionItem[] ──────────────────────────
  const allTransactions: TransactionItem[] = [
    ...dedupedAgreementEvents.map((a) => {
      const dateTime = formatDate(a.createdAt);
      return {
        id: a.transactionHash.slice(0, 10),
        type: formatEventType(a.eventType),
        address: formatAddress(
          a.employer === userAddress ? a.contributor || "N/A" : a.employer,
        ),
        date: dateTime.date,
        time: dateTime.time,
        token: "-",
        amount: "-",
        status: "Completed" as const,
        tokenIcon: "",
        txHash: a.transactionHash,
        createdAt: a.createdAt,
      };
    }),
    ...payments.map((p) => {
      const dateTime = formatDate(p.createdAt);
      const tokenInfo = getTokenInfo(p.token);
      const amountStr = formatAmount(p.amount, tokenInfo);
      const isReceived = p.eventType === "PaymentReceived";
      const sign = isReceived ? "+" : "-";
      const finalAmount = amountStr !== "-" ? `${sign}${amountStr}` : amountStr;
      return {
        id: p.transactionHash.slice(0, 10),
        type: formatEventType(p.eventType),
        address: formatAddress(p.to || p.from || "N/A"),
        date: dateTime.date,
        time: dateTime.time,
        token: tokenInfo.name,
        amount: finalAmount,
        status: "Completed" as const,
        tokenIcon: tokenInfo.icon,
        txHash: p.transactionHash,
        createdAt: p.createdAt,
      };
    }),
    ...employeeEvents.map((e) => {
      const dateTime = formatDate(e.createdAt);
      const address =
        e.employer === userAddress
          ? e.employeeAddress || "N/A"
          : e.employer || e.employeeAddress || "N/A";
      return {
        id: e.transactionHash.slice(0, 10),
        type: "Employee Added",
        address: formatAddress(address),
        date: dateTime.date,
        time: dateTime.time,
        token: "-",
        amount: "-",
        status: "Completed" as const,
        tokenIcon: "",
        txHash: e.transactionHash,
        createdAt: e.createdAt,
      };
    }),
    ...milestoneEvents.map((m) => {
      const dateTime = formatDate(m.createdAt);
      const address =
        m.employer === userAddress
          ? m.contributor || "N/A"
          : m.employer || "N/A";
      return {
        id: m.transactionHash.slice(0, 10),
        type: "Milestone Added",
        address: formatAddress(address),
        date: dateTime.date,
        time: dateTime.time,
        token: "-",
        amount: "-",
        status: "Completed" as const,
        tokenIcon: "",
        txHash: m.transactionHash,
        createdAt: m.createdAt,
      };
    }),
  ].sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (timeB !== timeA) return timeB - timeA;
    return a.txHash.localeCompare(b.txHash);
  });

  return { allTransactions, total };
}

// ── Sort helper ──────────────────────────────────────────────────────────

/**
 * Extracts a raw numeric value from a formatted amount string for sorting.
 *
 * Handles the following formatted patterns produced by `formatAmount`:
 * - STRK amounts: `"+1.234567 STRK"`, `"-0.500000 STRK"`
 * - USD amounts:  `"+$1.23"`, `"-$0.00"`
 * - Placeholder:  `"-"` → returns `0`
 *
 * The sign (`+`/`-`) prefix and non-numeric characters (`$`, ` STRK`) are
 * stripped before parsing so that the raw magnitude is used for ordering;
 * the sign is preserved so that negative amounts sort below positives.
 */
function parseAmountForSort(amount: string): number {
  if (!amount || amount === "-") return 0;
  // Remove currency symbols, token names, and whitespace; keep sign, digits, dot.
  const stripped = amount.replace(/[^\d.+\-]/g, "").replace(/\s+/g, "");
  const parsed = parseFloat(stripped);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Applies client-requested sort to the merged transaction array.
 *
 * - `sortBy === "date"` sorts by `createdAt` (newest first for `desc`,
 *   oldest first for `asc`).
 * - `sortBy === "amount"` sorts by the numeric value parsed from the
 *   formatted `amount` field.
 * - `sortBy === null` preserves the existing default sort (date desc +
 *   txHash tiebreak) which is already applied inside
 *   `fetchAndBuildTransactions`.
 *
 * A secondary `txHash` tiebreak is always applied for stable ordering.
 */
function applySort(
  transactions: TransactionItem[],
  sortBy: SortColumn | null,
  sortDir: SortDir,
): TransactionItem[] {
  if (!sortBy) return transactions; // preserve default sort

  const dir = sortDir === "asc" ? 1 : -1;

  return [...transactions].sort((a, b) => {
    let cmp = 0;
    if (sortBy === "date") {
      const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      cmp = tA - tB;
    } else if (sortBy === "amount") {
      cmp = parseAmountForSort(a.amount) - parseAmountForSort(b.amount);
    }
    if (cmp !== 0) return cmp * dir;
    // Stable tiebreak by txHash (always ascending)
    return a.txHash.localeCompare(b.txHash);
  });
}

// ── Response helper ──────────────────────────────────────────────────────

/**
 * Sorts (if requested), slices, paginates, and sends the unified transaction list.
 *
 * The response body always contains:
 * - `transactions`: the page of items (`array`, may be empty)
 * - `total`: the sum of matching rows across all five source tables
 * - `hasMore`: `true` when `total > offset + limit`
 * - `limit` / `offset`: the requested parameters (clamped)
 */
function respondPaginated(
  res: import("express").Response,
  allTransactions: TransactionItem[],
  total: number,
  limit: number,
  offset: number,
  sortBy: SortColumn | null = null,
  sortDir: SortDir = "desc",
): void {
  const sorted = applySort(allTransactions, sortBy, sortDir);
  const paginated = sorted.slice(offset, offset + limit);
  const hasMore = total > offset + limit;
  const body: TransactionResponse = {
    transactions: paginated,
    total,
    hasMore,
    limit,
    offset,
  };
  res.json(body);
}

// ── Route: main transaction list (with optional event-type filtering) ────
//
// Contract:
// - Accepts `eventTypes` query filter (comma-separated).
// - Accepts `sortBy` ("date" | "amount") and `sortDir` ("asc" | "desc") params.
// - Deduplicates agreement events by id.
// - Employee condition mode: "employer-or-employee".
// - Does NOT support date-range filtering.

transactionsRouter.get(
  "/transactions/:user_address",
  async (req, res, next) => {
    try {
      const userAddress = normalizeAddr(req.params.user_address);
      const { limit, offset } = parsePagination(req);
      const eventTypes = parseEventTypes(req);

      // Validate and parse sort parameters against the allowlist.
      const sortResult = parseSortParams(req);
      if (sortResult.error) {
        res.status(400).json({ error: sortResult.error });
        return;
      }
      const { sortBy, sortDir } = sortResult;

      const conds = buildConditions(userAddress, { eventTypes: eventTypes ?? undefined });
      const { allTransactions, total } = await fetchAndBuildTransactions(
        userAddress,
        conds,
        offset + limit,
        { deduplicateAgreementEvents: true },
      );

      respondPaginated(res, allTransactions, total, limit, offset, sortBy, sortDir);
    } catch (e) {
      next(e);
    }
  },
);

// ── Route: filtered transaction list (with optional date-range) ──────────
//
// Contract:
// - Accepts `startDate` / `endDate` query filters.
// - Accepts `sortBy` ("date" | "amount") and `sortDir` ("asc" | "desc") params.
// - Employee condition mode: "employee-only".
// - Does NOT deduplicate agreement events.
// - Does NOT support `eventTypes` filter.

transactionsRouter.get(
  "/transactions/:user_address/filtered",
  async (req, res, next) => {
    try {
      const userAddress = normalizeAddr(req.params.user_address);
      const { limit, offset } = parsePagination(req);
      const { startDate, endDate } = parseDateFilters(req);

      // Validate and parse sort parameters against the allowlist.
      const sortResult = parseSortParams(req);
      if (sortResult.error) {
        res.status(400).json({ error: sortResult.error });
        return;
      }
      const { sortBy, sortDir } = sortResult;

      const conds = buildConditions(
        userAddress,
        { startDate, endDate },
        { employeeConditionMode: "employee-only" },
      );
      const { allTransactions, total } = await fetchAndBuildTransactions(
        userAddress,
        conds,
        offset + limit,
      );

      respondPaginated(res, allTransactions, total, limit, offset, sortBy, sortDir);
    } catch (e) {
      next(e);
    }

  },
);

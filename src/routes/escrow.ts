/**
 * Escrow routes — balance resolution and fund-release preparation.
 *
 * This module owns the API surface for escrow operations on Starknet.  It
 * exposes read-paths (balance, token, employer, initialization status) and
 * write-paths (initialize, fund, release, refund) that prepare unsigned
 * Starknet transaction payloads for client-side signing.
 *
 * ## Balance resolution contract
 *
 * The balance for an agreement is resolved through a two-tier strategy
 * implemented by {@link getAgreementBalanceInternal}:
 *
 * 1. **Indexed-first** — Replays deduplicated escrow events from the local
 *    database.  `Funded` events add to the balance; `Released` and
 *    `Refunded` events subtract.  If the computed balance is negative (e.g.
 *    due to out-of-order indexing) it is clamped to `0`.
 * 2. **Contract fallback** — When indexed data is unavailable or the
 *    database query fails, the route calls `get_agreement_balance` on the
 *    Starknet escrow contract directly.
 *
 * The response always includes a `source` field (`"indexed"` or
 * `"contract"`) so callers can distinguish the data origin.
 *
 * ## Release idempotency
 *
 * The release preparation route (`POST /prepare/escrow/:address/release`)
 * supports optional idempotency via the `Idempotency-Key` header (see
 * {@link withEscrowIdempotency}).  The same key + same body replays the
 * cached response for 24 h; a different body with the same key is rejected
 * with `409 Conflict`.
 *
 * ## Compatibility
 *
 * Existing callers depend on the shape of every response envelope
 * (including `call`, `wallet_address`, `nonce`, `chain_id`, `balance`,
 * and `source`).  Changes to these shapes must be backward-compatible or
 * coordinated with all consumers.
 *
 * @module escrow
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { defaults } from "../config.js";
import { escrowContract, provider } from "../starknet/client.js";
import { parseU256 } from "../utils/codec.js";
import { requireSession } from "../auth/session.js";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";

import { normalizeStarknetAddress } from "../utils/address.js";

/**
 * Zod schema that normalises a Starknet address from a route parameter.
 *
 * Accepts any string of at least 3 characters and canonicalises it via
 * {@link normalizeStarknetAddress}.  Used for `:address` route params
 * throughout the escrow router.
 */
const AddressParam = z
  .string()
  .min(3)
  .transform((val, ctx) => {
    try {
      return normalizeStarknetAddress(val);
    } catch (e: any) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: e.message });
      return z.NEVER;
    }
  });

/**
 * Starknet address schema for request body fields.
 *
 * Shares the same validation and normalisation logic as {@link AddressParam}
 * so body addresses and route-param addresses are always canonical.  The
 * separate binding keeps body-validation error paths distinct from param
 * parsing errors in production telemetry.
 */
const EscrowAddress = AddressParam;

/**
 * Coerces a route parameter to a positive bigint for agreement IDs.
 */
const AgreementIdParam = z.coerce.bigint().positive();

/**
 * Base session schema shared by all write-path request bodies.
 *
 * Requires a canonical wallet address and a session token of at least
 * 10 characters.
 */
const WalletSession = z.object({
  wallet_address: EscrowAddress,
  session_token: z.string().trim().min(10),
});

/**
 * Coerces a body field (string or number) to a positive bigint for
 * agreement IDs sent in request payloads.
 */
const AgreementIdBody = z
  .union([z.string().trim().regex(/^\d+$/), z.number().int().positive()])
  .transform((value) => BigInt(value));

/**
 * Coerces a body field (string or number) to a non-negative decimal string
 * for token amounts sent in request payloads.
 */
const AmountBody = z
  .union([z.string().trim().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((value) => String(value));

/**
 * Request body for `POST /prepare/escrow/:address/fund_agreement`.
 */
const FundAgreementBody = WalletSession.extend({
  agreement_id: AgreementIdBody,
  employer: EscrowAddress,
  amount: AmountBody,
});

/**
 * Request body for `POST /prepare/escrow/:address/release`.
 */
const ReleaseBody = WalletSession.extend({
  agreement_id: AgreementIdBody,
  to: EscrowAddress,
  amount: AmountBody,
});

/**
 * Request body for `POST /prepare/escrow/:address/initialize`.
 */
const InitBody = WalletSession.extend({
  token: EscrowAddress,
  manager: EscrowAddress,
});

/**
 * Request body for `POST /prepare/escrow/:address/refund_remaining`.
 */
const RefundBody = WalletSession.extend({
  agreement_id: AgreementIdBody,
});

// -------- Idempotency Store & Helpers --------

/**
 * Time-to-live for cached idempotency entries (24 hours in milliseconds).
 */
const ESCROW_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Number of escrow events fetched per batch when replaying indexed events
 * to compute an agreement balance.  Kept small enough to avoid unbounded
 * memory growth on long-lived agreements while large enough to minimise
 * round-trips.
 *
 * @see getAgreementBalanceInternal
 */
const ESCROW_BALANCE_BATCH_SIZE = 100;

/**
 * An entry in the in-memory idempotency store.
 *
 * Stores the response body and status code for a previously completed
 * write operation, keyed by `escrow:<address>:<idempotency-key>`.
 */
type EscrowIdempotencyEntry = {
  createdAt: number;
  expiresAt: number;
  bodyFingerprint: string;
  statusCode: number;
  responseBody: unknown;
};

/**
 * In-memory cache of idempotent responses.
 *
 * **Node-local only.**  Horizontal scaling requires a shared store (e.g.
 * Redis); that is intentionally out of scope for the current contract.
 */
const escrowIdempotencyStore = new Map<string, EscrowIdempotencyEntry>();

/**
 * Produces a deterministic JSON-like string for a value, sorting object
 * keys alphabetically so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce
 * the same fingerprint.
 */
function stableSerialize(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return String(value);
}

/**
 * Safely reads a request header, returning `undefined` when missing or empty.
 */
function getHeader(req: Request, name: string): string | undefined {
  const value = req.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Removes all expired entries from the idempotency store.
 */
function pruneExpiredEntries(now = Date.now()): void {
  for (const [cacheKey, entry] of escrowIdempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      escrowIdempotencyStore.delete(cacheKey);
    }
  }
}

/**
 * Clears the entire idempotency store.  Primarily intended for test
 * teardown so tests start with a clean state.
 */
export function clearEscrowIdempotencyStore(): void {
  escrowIdempotencyStore.clear();
}

/**
 * Wraps a route handler with idempotency-key replay protection.
 *
 * ## Contract
 *
 * - Reads the `Idempotency-Key` (case-insensitive) header from the request.
 * - Bypasses idempotency for `GET`, `HEAD`, and `OPTIONS` requests.
 * - When a key is present on a mutating request:
 *   - **Cache hit (same key + same body):** The cached response (status
 *     code and JSON body) from the first successful execution is replayed.
 *     The handler is never called again; no new nonce is fetched.
 *   - **Cache conflict (same key + different body):** Returns
 *     `409 Conflict` immediately.
 *   - **Cache miss:** Executes the handler, intercepts `res.json` /
 *     `res.send`, and caches the response under the key.
 * - Cache entries expire after {@link ESCROW_IDEMPOTENCY_TTL_MS} (24 h).
 *
 * ## Limitations (intentionally out of scope)
 *
 * - **Node-local.**  The store lives in process memory.  Under horizontal
 *   scaling, idempotency is not shared across instances.
 * - **Pre-auth caching.**  Responses with `4xx` status codes (including
 *   auth failures and validation errors) are cached alongside successful
 *   ones.  A subsequent replay of a previously-failed request returns the
 *   same error.
 *
 * @param handler - The route handler to wrap.
 * @returns A new handler that enforces idempotency before delegating.
 */
export function withEscrowIdempotency(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = getHeader(req, "Idempotency-Key") ?? getHeader(req, "idempotency-key");
    const method = req.method.toUpperCase();

    if (!idempotencyKey || ["GET", "HEAD", "OPTIONS"].includes(method)) {
      await handler(req, res, next);
      return;
    }

    const now = Date.now();
    pruneExpiredEntries(now);

    const address = req.params.address || "default";
    const cacheKey = `escrow:${address}:${idempotencyKey}`;
    const existingEntry = escrowIdempotencyStore.get(cacheKey);

    if (existingEntry && existingEntry.expiresAt > now) {
      if (existingEntry.bodyFingerprint !== stableSerialize(req.body)) {
        console.warn({
          event: "escrow_idempotency_conflict",
          address,
          idempotency_key: idempotencyKey,
        });
        res
          .status(409)
          .json({ error: "Idempotency key already used with a different request body" });
        return;
      }

      console.log({
        event: "escrow_idempotency_cache_hit",
        address,
        idempotency_key: idempotencyKey,
      });
      res.status(existingEntry.statusCode).json(existingEntry.responseBody);
      return;
    }

    if (existingEntry && existingEntry.expiresAt <= now) {
      escrowIdempotencyStore.delete(cacheKey);
    }

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let cachedResponse: EscrowIdempotencyEntry | undefined;

    const persistResponse = (body: unknown): void => {
      if (cachedResponse) {
        return;
      }
      cachedResponse = {
        createdAt: Date.now(),
        expiresAt: Date.now() + ESCROW_IDEMPOTENCY_TTL_MS,
        bodyFingerprint: stableSerialize(req.body),
        statusCode: res.statusCode,
        responseBody: body,
      };
      escrowIdempotencyStore.set(cacheKey, cachedResponse);
    };

    res.json = ((body: unknown) => {
      persistResponse(body);
      return originalJson(body);
    }) as typeof res.json;

    res.send = ((body: unknown) => {
      if (!cachedResponse) {
        persistResponse(body);
      }
      return originalSend(body);
    }) as typeof res.send;

    await handler(req, res, next);
  };
}

/**
 * Resolves the current balance for a specific agreement on an escrow
 * contract using a two-tier strategy: indexed data first, on-chain
 * contract call as fallback.
 *
 * ## Indexed path (preferred)
 *
 * 1. Queries `escrow_events` from the local database in **batches of
 *    {@link ESCROW_BALANCE_BATCH_SIZE}** rows, filtered by
 *    `contractAddress` and `agreementId`, ordered by `(blockNumber, id)`
 *    to guarantee stable pagination across batches.
 * 2. **Deduplicates** events by their unique `id` (computed as
 *    `transaction_hash + event_index` on insert).  The same Starknet event
 *    may appear multiple times in the indexer output; deduplication guards
 *    against double-counting.  The dedup set persists across batches.
 * 3. Replays the deduplicated stream:
 *    - `Funded` → **adds** the amount.
 *    - `Released` or `Refunded` → **subtracts** the amount.
 * 4. If the computed balance is **negative** (possible when releases are
 *    indexed before their corresponding fund events), the balance is
 *    **clamped to `0`** and a structured warning is logged.
 * 5. Returns `{ balance, source: "indexed" }`.
 *
 * **Batching contract:** Each iteration fetches at most
 * {@link ESCROW_BALANCE_BATCH_SIZE} rows via offset-based pagination.
 * The loop continues until a page returns fewer rows than the batch size
 * (indicating the last page).  Offset pagination is safe because new
 * events are always appended (they won't shift earlier pages).
 *
 * ## Contract fallback path
 *
 * When indexed data is unavailable (empty result set on the **first**
 * page) or the database query throws, the function falls through to a
 * direct Starknet contract call (`get_agreement_balance`).  The returned
 * value is coerced from whatever type Starknet.js provides (bigint,
 * number, string, or `{ low, high }` U256 object) into a `bigint`.
 *
 * Return value is always `{ balance: bigint, source: "indexed" | "contract" }`.
 *
 * @param address      - Normalised Starknet address of the escrow contract.
 * @param agreement_id - The agreement identifier.
 * @returns The balance as a non-negative bigint and the resolution source.
 */
async function getAgreementBalanceInternal(
  address: string,
  agreement_id: bigint,
): Promise<{ balance: bigint; source: "indexed" | "contract" }> {
  try {
    let offset = 0;
    let balance = BigInt(0);
    const seenEventIds = new Set<string>();
    let totalEventCount = 0;

    // Batched pagination: fetch events in pages of BATCH_SIZE to avoid
    // unbounded memory growth on long-lived agreements.
    while (true) {
      const page = await db
        .select()
        .from(schema.escrowEvents)
        .where(
          and(
            eq(schema.escrowEvents.contractAddress, address),
            eq(schema.escrowEvents.agreementId, agreement_id.toString()),
          ),
        )
        .orderBy(schema.escrowEvents.blockNumber, schema.escrowEvents.id)
        .limit(ESCROW_BALANCE_BATCH_SIZE)
        .offset(offset);

      if (!Array.isArray(page) || page.length === 0) {
        break;
      }

      totalEventCount += page.length;

      for (const event of page) {
        if (event && event.id) {
          if (seenEventIds.has(event.id)) {
            continue;
          }
          seenEventIds.add(event.id);
        }
        if (event.eventType === "Funded") {
          balance += BigInt(event.amount);
        } else if (event.eventType === "Released" || event.eventType === "Refunded") {
          balance -= BigInt(event.amount);
        }
      }

      // Last page: fewer rows than the batch size means no more data.
      if (page.length < ESCROW_BALANCE_BATCH_SIZE) {
        break;
      }

      offset += ESCROW_BALANCE_BATCH_SIZE;
    }

    if (totalEventCount > 0) {
      if (balance < 0n) {
        console.warn({
          event: "escrow_balance_clamped",
          address,
          agreement_id: agreement_id.toString(),
          raw_balance: balance.toString(),
        });
        balance = 0n;
      }
      console.log({
        event: "escrow_balance_resolved",
        source: "indexed",
        address,
        agreement_id: agreement_id.toString(),
        balance: balance.toString(),
        event_count: totalEventCount,
      });
      return { balance, source: "indexed" };
    }

    // No indexed events found — log and fall through to contract
    console.log({
      event: "escrow_balance_fallback",
      source: "contract",
      address,
      agreement_id: agreement_id.toString(),
      reason: "no_indexed_data",
    });
  } catch (err: any) {
    // DB error — log and fall through to contract
    console.warn({
      event: "escrow_balance_fallback",
      source: "contract",
      address,
      agreement_id: agreement_id.toString(),
      reason: "db_error",
      error: err?.message ?? String(err),
    });
  }

  // Fallback to contract call
  const c = escrowContract(address);
  const out = await c.get_agreement_balance(agreement_id);
  let balance = 0n;
  if (typeof out === "bigint") {
    balance = out;
  } else if (typeof out === "number") {
    balance = BigInt(out);
  } else if (typeof out === "string") {
    balance = BigInt(out);
  } else if (out && typeof out === "object" && "low" in out && "high" in out) {
    const low = BigInt((out as any).low);
    const high = BigInt((out as any).high);
    balance = low + (high << 128n);
  }
  console.log({
    event: "escrow_balance_resolved",
    source: "contract",
    address,
    agreement_id: agreement_id.toString(),
    balance: balance.toString(),
  });
  return { balance, source: "contract" };
}

/**
 * Fetches the nonce and chain ID for a wallet address.
 *
 * Used by POST /prepare/* routes to build the transaction context that the
 * client will sign. The nonce is fetched with "pending" block tag so the
 * returned value reflects any in-flight mempool transactions.
 */
async function prepareTransactionContext(
  walletAddress: string,
): Promise<{ nonce: string; chain_id: string }> {
  const nonce = await provider.getNonceForAddress(walletAddress, "pending");
  const chainId = await provider.getChainId();
  return { nonce: String(nonce), chain_id: String(chainId) };
}

/**
 * Checks whether `walletAddress` is the employer of the given agreement on
 * the escrow contract at `address`.
 *
 * Returns `false` on any contract call failure rather than throwing, so
 * the caller always gets a safe boolean decision.
 */
async function checkAgreementEmployerAuth(
  address: string,
  agreementId: bigint,
  walletAddress: string,
): Promise<boolean> {
  try {
    const c = escrowContract(address);
    const employer = await c.get_agreement_employer(agreementId);
    return normalizeStarknetAddress(String(employer)) === normalizeStarknetAddress(walletAddress);
  } catch {
    return false;
  }
}

/**
 * Express router for escrow operations.
 *
 * ## Read endpoints (no auth)
 *
 * | Method | Path | Description |
 * | :--- | :--- | :--- |
 * | GET | `/escrow/defaults` | Returns the configured default escrow contract address. |
 * | GET | `/escrow/:address/get_token` | Returns the token address the escrow was initialised with. |
 * | GET | `/escrow/:address/is_initialized` | Checks whether the escrow has been initialised (token ≠ zero). |
 * | GET | `/escrow/:address/get_agreement_balance/:agreement_id` | Resolves the current agreement balance via {@link getAgreementBalanceInternal}. |
 * | GET | `/escrow/:address/get_agreement_employer/:agreement_id` | Returns the employer address stored for the agreement. |
 *
 * ## Write endpoints (require session)
 *
 * | Method | Path | Description |
 * | :--- | :--- | :--- |
 * | POST | `/prepare/escrow/:address/initialize` | Prepares an unsigned `initialize` transaction. |
 * | POST | `/prepare/escrow/:address/fund_agreement` | Prepares an unsigned `fund_agreement` transaction. |
 * | POST | `/prepare/escrow/:address/release` | Prepares an unsigned `release` transaction (with idempotency). |
 * | POST | `/prepare/escrow/:address/refund_remaining` | Prepares an unsigned `refund_remaining` transaction (employer-only). |
 *
 * All write endpoints require a valid session (`wallet_address` +
 * `session_token`) and return `401` on auth failure.  The release route
 * additionally enforces idempotency (see {@link withEscrowIdempotency}) and
 * a pre-execution balance check that returns `400` when the agreement
 * balance is insufficient.
 */
export const escrowRouter = Router();

escrowRouter.get("/escrow/defaults", (_req, res) => {
  res.json({ address: defaults.payrollEscrowAddress });
});

// -------- getters (view) --------

/**
 * GET /escrow/:address/get_token
 *
 * Returns the ERC-20 token address the escrow contract was initialised
 * with.  Calls `get_token()` on the Starknet contract directly.
 */
escrowRouter.get("/escrow/:address/get_token", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const c = escrowContract(address);
    const out = await c.get_token();
    res.json({ token: out });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /escrow/:address/is_initialized
 *
 * Checks whether the escrow contract has been initialised by calling
 * `get_token()` and testing whether the result is a non-zero address.
 *
 * Returns `{ initialized: boolean, token: string | null }`.  When the
 * contract call itself fails (e.g. network error or uninitialised
 * contract), the response includes `initialized: false` and an `error`
 * field rather than throwing.
 */
escrowRouter.get("/escrow/:address/is_initialized", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const c = escrowContract(address);
    // Try to get token - if it returns zero address, it's not initialized
    try {
      const token = await c.get_token();
      // Normalize the token address for comparison
      const tokenStr =
        typeof token === "string" ? token.toLowerCase() : String(token).toLowerCase();
      // Check for various zero address representations
      const zeroAddresses = [
        "0x0",
        "0x00",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0",
        "",
      ];
      const isZero = zeroAddresses.includes(tokenStr) || tokenStr === "0x" || !tokenStr;
      const isInitialized = !isZero && tokenStr.length > 2; // Valid address should be at least "0x" + some hex
      res.json({ initialized: isInitialized, token: isInitialized ? tokenStr : null });
    } catch (err: any) {
      // If the call fails, it might be uninitialized or there's a network issue.
      console.warn({
        event: "escrow_initialization_check_failed",
        address,
        error: err?.message ?? String(err),
      });
      res.json({ initialized: false, token: null, error: err?.message || "Failed to check" });
    }
  } catch (e) {
    next(e);
  }
});

/**
 * GET /escrow/:address/get_agreement_balance/:agreement_id
 *
 * Resolves the current balance for an agreement.  Delegates to
 * {@link getAgreementBalanceInternal} which uses indexed data when
 * available and falls back to a direct contract call.
 *
 * Response: `{ agreement_id, balance, source }` where `source` is
 * `"indexed"` or `"contract"`.
 */
escrowRouter.get("/escrow/:address/get_agreement_balance/:agreement_id", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const agreement_id = AgreementIdParam.parse(req.params.agreement_id);

    const result = await getAgreementBalanceInternal(address, agreement_id);
    res.json({
      agreement_id: agreement_id.toString(),
      balance: result.balance.toString(),
      source: result.source,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /escrow/:address/get_agreement_employer/:agreement_id
 *
 * Returns the employer address stored on the escrow contract for the
 * given agreement.  Calls `get_agreement_employer()` on the Starknet
 * contract directly.
 */
escrowRouter.get(
  "/escrow/:address/get_agreement_employer/:agreement_id",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const agreement_id = AgreementIdParam.parse(req.params.agreement_id);
      const c = escrowContract(address);
      const out = await c.get_agreement_employer(agreement_id);
      res.json({ agreement_id: agreement_id.toString(), employer: out });
    } catch (e) {
      next(e);
    }
  },
);

// -------- setters (prepare to sign client-side) --------

/**
 * POST /prepare/escrow/:address/initialize
 *
 * Prepares an unsigned `initialize` transaction for client-side signing.
 * Requires a valid session.  The caller provides a token address and
 * manager address.
 */
escrowRouter.post("/prepare/escrow/:address/initialize", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = InitBody.parse(req.body);
    if (!(await requireSession(body.wallet_address, body.session_token))) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const c = escrowContract(address);
    const call = c.populate("initialize", [body.token, body.manager]);
    const { nonce, chain_id } = await prepareTransactionContext(body.wallet_address);
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /prepare/escrow/:address/fund_agreement
 *
 * Prepares an unsigned `fund_agreement` transaction for client-side
 * signing.  Requires a valid session.  The caller provides the agreement
 * ID, employer address, and funding amount (as a decimal string).
 */
escrowRouter.post("/prepare/escrow/:address/fund_agreement", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = FundAgreementBody.parse(req.body);
    if (!(await requireSession(body.wallet_address, body.session_token))) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const c = escrowContract(address);
    const call = c.populate("fund_agreement", [
      body.agreement_id.toString(),
      body.employer,
      parseU256(body.amount),
    ]);
    const { nonce, chain_id } = await prepareTransactionContext(body.wallet_address);
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /prepare/escrow/:address/release
 *
 * Prepares an unsigned `release` transaction for client-side signing.
 *
 * This is the most heavily guarded write path:
 * 1. **Session validation** — returns `401` on invalid session.
 * 2. **Idempotency** — wrapped by {@link withEscrowIdempotency} so retries
 *    with the same `Idempotency-Key` replay the cached response.
 * 3. **Pre-execution balance check** — calls
 *    {@link getAgreementBalanceInternal} and returns `400` with
 *    `"Insufficient agreement balance"` if the available balance is less
 *    than the requested amount.
 * 4. **Transaction preparation** — populates the `release` call with the
 *    agreement ID, recipient, and parsed U256 amount, then fetches a
 *    nonce and chain ID for the caller's wallet.
 *
 * Response: `{ call, wallet_address, nonce, chain_id }`.
 */
escrowRouter.post(
  "/prepare/escrow/:address/release",
  withEscrowIdempotency(async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const body = ReleaseBody.parse(req.body);
      if (!(await requireSession(body.wallet_address, body.session_token))) {
        console.warn({
          event: "escrow_auth_failed",
          route: "release",
          address,
          wallet_address: body.wallet_address,
        });
        res.status(401).json({ error: "Invalid session" });
        return;
      }

      // Pre-execution balance check
      const result = await getAgreementBalanceInternal(address, body.agreement_id);
      const reqAmount = BigInt(body.amount);
      if (result.balance < reqAmount) {
        console.warn({
          event: "escrow_release_insufficient_balance",
          address,
          agreement_id: body.agreement_id.toString(),
          requested: body.amount,
          available: result.balance.toString(),
          source: result.source,
        });
        res.status(400).json({ error: "Insufficient agreement balance" });
        return;
      }

      const c = escrowContract(address);
      const call = c.populate("release", [
        body.agreement_id.toString(),
        body.to,
        parseU256(body.amount),
      ]);
      const { nonce, chain_id } = await prepareTransactionContext(body.wallet_address);
      console.log({
        event: "escrow_release_prepared",
        address,
        agreement_id: body.agreement_id.toString(),
        amount: body.amount,
        balance: result.balance.toString(),
        source: result.source,
      });
      res.json({ call, wallet_address: body.wallet_address, nonce, chain_id });
    } catch (e) {
      next(e);
    }
  }),
);

/**
 * POST /prepare/escrow/:address/refund_remaining
 *
 * Prepares an unsigned `refund_remaining` transaction for client-side
 * signing.  Requires a valid session **and** that the caller is the
 * employer of the agreement (verified on-chain via
 * {@link checkAgreementEmployerAuth}); otherwise returns `403`.
 */
escrowRouter.post("/prepare/escrow/:address/refund_remaining", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = RefundBody.parse(req.body);
    if (!(await requireSession(body.wallet_address, body.session_token))) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const isAuth = await checkAgreementEmployerAuth(
      address,
      body.agreement_id,
      body.wallet_address,
    );
    if (!isAuth) {
      res.status(403).json({ error: "Unauthorized" });
      return;
    }

    const c = escrowContract(address);
    const call = c.populate("refund_remaining", [body.agreement_id.toString()]);
    const { nonce, chain_id } = await prepareTransactionContext(body.wallet_address);
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id });
  } catch (e) {
    next(e);
  }
});

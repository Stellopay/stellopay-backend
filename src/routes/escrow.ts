import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { defaults } from "../config.js";
import { escrowContract, provider } from "../starknet/client.js";
import { parseU256 } from "../utils/codec.js";
import { requireSession } from "../auth/session.js";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";

import { normalizeStarknetAddress } from "../utils/address.js";

const AddressParam = z.string().min(3).transform((val, ctx) => {
  try {
    return normalizeStarknetAddress(val);
  } catch (e: any) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: e.message });
    return z.NEVER;
  }
});
const AgreementIdParam = z.coerce.bigint().positive();

const WalletSession = z.object({
  wallet_address: z.string().min(3),
  session_token: z.string().min(10),
});
const FundAgreementBody = WalletSession.extend({
  agreement_id: z.coerce.bigint().positive(),
  employer: z.string().min(3),
  amount: z.string().min(1),
});
const ReleaseBody = WalletSession.extend({
  agreement_id: z.coerce.bigint().positive(),
  to: z.string().min(3),
  amount: z.string().min(1),
});
const InitBody = WalletSession.extend({
  token: z.string().min(3),
  manager: z.string().min(3),
});
const RefundBody = WalletSession.extend({
  agreement_id: z.coerce.bigint().positive(),
});

// -------- Idempotency Store & Helpers --------
const ESCROW_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type EscrowIdempotencyEntry = {
  createdAt: number;
  expiresAt: number;
  bodyFingerprint: string;
  statusCode: number;
  responseBody: unknown;
};

const escrowIdempotencyStore = new Map<string, EscrowIdempotencyEntry>();

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

function getHeader(req: Request, name: string): string | undefined {
  const value = req.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pruneExpiredEntries(now = Date.now()): void {
  for (const [cacheKey, entry] of escrowIdempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      escrowIdempotencyStore.delete(cacheKey);
    }
  }
}

export function clearEscrowIdempotencyStore(): void {
  escrowIdempotencyStore.clear();
}

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
        res.status(409).json({ error: "Idempotency key already used with a different request body" });
        return;
      }

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

async function getAgreementBalanceInternal(
  address: string,
  agreement_id: bigint,
): Promise<{ balance: bigint; source: "indexed" | "contract" }> {
  try {
    const escrowEvents = await db
      .select()
      .from(schema.escrowEvents)
      .where(
        and(
          eq(schema.escrowEvents.contractAddress, address),
          eq(schema.escrowEvents.agreementId, agreement_id.toString()),
        ),
      )
      .orderBy(schema.escrowEvents.blockNumber);

    if (Array.isArray(escrowEvents) && escrowEvents.length > 0) {
      let balance = BigInt(0);
      const seenEventIds = new Set<string>();
      for (const event of escrowEvents) {
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
      if (balance < 0n) {
        balance = 0n;
      }
      return { balance, source: "indexed" };
    }
  } catch {
    // Fall through to contract call
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
  return { balance, source: "contract" };
}

export const escrowRouter = Router();

escrowRouter.get("/escrow/defaults", (_req, res) => {
  res.json({ address: defaults.payrollEscrowAddress });
});

// -------- getters (view) --------
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
      // If the call fails, it might be uninitialized or there's a network issue
      // Log the error but return false to be safe
      console.error("Error checking escrow initialization:", err?.message || err);
      res.json({ initialized: false, token: null, error: err?.message || "Failed to check" });
    }
  } catch (e) {
    next(e);
  }
});

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

escrowRouter.post("/prepare/escrow/:address/release", withEscrowIdempotency(async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = ReleaseBody.parse(req.body);
    if (!(await requireSession(body.wallet_address, body.session_token))) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    // Pre-execution balance check
    const result = await getAgreementBalanceInternal(address, body.agreement_id);
    const reqAmount = BigInt(body.amount);
    if (result.balance < reqAmount) {
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
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id });
  } catch (e) {
    next(e);
  }
}));

escrowRouter.post("/prepare/escrow/:address/refund_remaining", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = RefundBody.parse(req.body);
    if (!(await requireSession(body.wallet_address, body.session_token))) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const isAuth = await checkAgreementEmployerAuth(address, body.agreement_id, body.wallet_address);
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

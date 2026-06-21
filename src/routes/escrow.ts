import { Router } from "express";
import { z } from "zod";
import { defaults } from "../config.js";
import { escrowContract, provider } from "../starknet/client.js";
import { parseU256, u256ToString } from "../utils/codec.js";
import { requireSession } from "../auth/session.js";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";

const AddressParam = z.string().min(3);
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

    // Try indexed data first - calculate balance from escrow events
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

      if (escrowEvents.length > 0) {
        let balance = BigInt(0);
        for (const event of escrowEvents) {
          if (event.eventType === "Funded") {
            balance += BigInt(event.amount);
          } else if (event.eventType === "Released" || event.eventType === "Refunded") {
            balance -= BigInt(event.amount);
          }
        }
        return res.json({
          agreement_id: agreement_id.toString(),
          balance: balance.toString(),
          source: "indexed",
        });
      }
    } catch (dbError) {
      // Fall through to contract call
    }

    // Fallback to contract call
    const c = escrowContract(address);
    const out = await c.get_agreement_balance(agreement_id);
    res.json({
      agreement_id: agreement_id.toString(),
      balance: u256ToString(out),
      source: "contract",
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
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const c = escrowContract(address);
    const call = c.populate("initialize", [body.token, body.manager]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

escrowRouter.post("/prepare/escrow/:address/fund_agreement", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = FundAgreementBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const c = escrowContract(address);
    const call = c.populate("fund_agreement", [
      body.agreement_id.toString(),
      body.employer,
      parseU256(body.amount),
    ]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

escrowRouter.post("/prepare/escrow/:address/release", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = ReleaseBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const c = escrowContract(address);
    const call = c.populate("release", [
      body.agreement_id.toString(),
      body.to,
      parseU256(body.amount),
    ]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

escrowRouter.post("/prepare/escrow/:address/refund_remaining", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = RefundBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const c = escrowContract(address);
    const call = c.populate("refund_remaining", [body.agreement_id.toString()]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

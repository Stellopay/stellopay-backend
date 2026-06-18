import { Router } from "express";
import { z } from "zod";
import { provider } from "../starknet/client.js";
import { buildTypedChallenge } from "../auth/challenge.js";
import {
  clearChallenge,
  createChallenge,
  createSession,
  getChallenge,
  requireSession,
} from "../auth/session.js";

const AddressBody = z.object({ address: z.string().min(3) });
const VerifyBody = z.object({
  address: z.string().min(3),
  // Some Starknet accounts/wallets produce variable-length signatures (not always 2 felts)
  signature: z.array(z.string().min(1)).min(2),
});
const SessionBody = z.object({
  address: z.string().min(3),
  session_token: z.string().min(10),
});

export const authRouter = Router();

// Debug logger for auth routes (helps track nonce/signature/RPC issues)
authRouter.use((req, _res, next) => {
  // eslint-disable-next-line no-console
  console.log(`[auth] ${req.method} ${req.originalUrl}`, { body: req.body });
  next();
});

// Step 1: backend issues a nonce for wallet ownership proof
authRouter.post("/auth/challenge", async (req, res, next) => {
  try {
    const { address } = AddressBody.parse(req.body);
    const { nonce, expires_in_ms } = createChallenge(address);
    const chainId: unknown = await provider.getChainId();

    if (!chainId) {
      throw new Error("Failed to get chain ID from RPC provider");
    }

    // Ensure chainId is a string (it might be a BigInt or number)
    const chainIdStr = typeof chainId === 'bigint' ? chainId.toString() : typeof chainId === 'number' ? String(chainId) : String(chainId);
    const typedData = buildTypedChallenge(address, chainIdStr, nonce);
    res.json({ address, nonce, expires_in_ms, chain_id: chainIdStr, typed_data: typedData });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[auth] /auth/challenge error", e);
    next(e);
  }
});

// Step 2: backend verifies signature using account's isValidSignature (RPC verify)
authRouter.post("/auth/verify", async (req, res, next) => {
  try {
    const { address, signature } = VerifyBody.parse(req.body);
    const ch = getChallenge(address);
    if (!ch) {
      res.status(400).json({ error: "No active challenge (or expired). Call /auth/challenge again." });
      return;
    }
    const chainId: unknown = await provider.getChainId();

    if (!chainId) {
      res.status(500).json({ error: "Failed to get chain ID from RPC provider" });
      return;
    }

    // Ensure chainId is a string (it might be a BigInt or number)
    const chainIdStr = typeof chainId === 'bigint' ? chainId.toString() : typeof chainId === 'number' ? String(chainId) : String(chainId);
    const typedData = buildTypedChallenge(address, chainIdStr, ch.nonce);

    const ok = await provider.verifyMessageInStarknet(typedData, signature as any, address);
    if (!ok) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
    clearChallenge(address);
    const session = createSession(address);
    res.json({ ok: true, address, session_token: session.token, expires_in_ms: session.expires_in_ms });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[auth] /auth/verify error", e);
    next(e);
  }
});

// Step 3 (optional): validate an existing session token (helps frontend detect backend restarts)
authRouter.post("/auth/session/validate", async (req, res, next) => {
  try {
    const { address, session_token } = SessionBody.parse(req.body);
    const ok = requireSession(address, session_token);
    if (!ok) {
      res.status(401).json({ ok: false, error: "Invalid session" });
      return;
    }
    res.json({ ok: true, address });
  } catch (e) {
    next(e);
  }
});

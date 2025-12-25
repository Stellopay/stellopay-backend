import { Router } from "express";
import { z } from "zod";
import { provider } from "../starknet/client.js";

export const systemRouter = Router();

systemRouter.get("/network/chain_id", async (_req, res, next) => {
  try {
    const chainId = await provider.getChainId();
    const specVersion = await provider.getSpecVersion();
    res.json({ chain_id: chainId, spec_version: specVersion });
  } catch (e) {
    next(e);
  }
});

systemRouter.get("/account/:address/nonce", async (req, res, next) => {
  try {
    const address = z.string().min(3).parse(req.params.address);
    const nonce = await provider.getNonceForAddress(address, "pending");
    res.json({ address, nonce });
  } catch (e) {
    next(e);
  }
});



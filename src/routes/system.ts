import { Router } from "express";
import { z } from "zod";
import { provider, getCachedNetworkInfo } from "../starknet/client.js";

export const systemRouter = Router();

systemRouter.get("/network/chain_id", async (_req, res, next) => {
  try {
    const { chainId, specVersion } = await getCachedNetworkInfo();
    res.setHeader("Cache-Control", "public, max-age=300");
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

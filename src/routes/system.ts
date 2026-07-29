import { Router } from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { provider, getCachedNetworkInfo } from "../starknet/client.js";
import { checkDbHealth } from "../db/index.js";

export const systemRouter = Router();

let cachedVersionPayload: { version: string } | null = null;

systemRouter.get("/system/version", async (_req, res, next) => {
  try {
    if (!cachedVersionPayload) {
      const pkgPath = path.resolve(process.cwd(), "package.json");
      const pkgRaw = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(pkgRaw);
      cachedVersionPayload = { version: pkg.version };
    }
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(cachedVersionPayload);
  } catch (e) {
    next(e);
  }
});

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

systemRouter.get("/system/live", (_req, res) => {
  res.json({ status: "ok" });
});

systemRouter.get("/system/ready", async (_req, res, next) => {
  try {
    const [dbHealthy, rpcHealthy] = await Promise.all([
      checkDbHealth(),
      provider.getBlockNumber().then(
        () => true,
        () => false,
      ),
    ]);

    const checks: Record<string, string> = {};
    if (dbHealthy) checks.database = "reachable";
    else checks.database = "unreachable";

    if (rpcHealthy) checks["starknet-rpc"] = "reachable";
    else checks["starknet-rpc"] = "unreachable";

    const allHealthy = dbHealthy && rpcHealthy;
    res.status(allHealthy ? 200 : 503).json({ status: allHealthy ? "ok" : "degraded", checks });
  } catch (e) {
    next(e);
  }
});

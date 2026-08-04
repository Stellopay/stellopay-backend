import { Router } from "express";
import fs from "fs";
import path from "path";
import { provider, getCachedNetworkInfo } from "../starknet/client.js";
import { checkDbHealth } from "../db/index.js";
import { StarknetAddress } from "../utils/validation.js";

export const systemRouter = Router();

let cachedVersionPayload: { version: string } | null = null;

// ===========================================================================
// /system/version
// ===========================================================================

const versionHandler = async (_req: any, res: any, next: any) => {
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
};

systemRouter.get("/system/version", versionHandler);

/**
 * HEAD /system/version
 *
 * Mirrors GET /system/version without a response body. Useful for monitoring
 * probes and CDN cache-validation requests.
 */
systemRouter.head("/system/version", async (req: any, res: any, next: any) => {
  const origJson = res.json.bind(res);
  res.json = (body: any) => {
    res.setHeader("Content-Length", String(Buffer.byteLength(JSON.stringify(body))));
    res.end();
    return res;
  };
  try {
    await versionHandler(req, res, next);
  } finally {
    res.json = origJson;
  }
});

// ===========================================================================
// /network/chain_id
// ===========================================================================

const chainIdHandler = async (_req: any, res: any, next: any) => {
  try {
    const { chainId, specVersion } = await getCachedNetworkInfo();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ chain_id: chainId, spec_version: specVersion });
  } catch (e) {
    next(e);
  }
};

systemRouter.get("/network/chain_id", chainIdHandler);

/**
 * HEAD /network/chain_id
 *
 * Mirrors GET /network/chain_id without a response body.
 */
systemRouter.head("/network/chain_id", async (req: any, res: any, next: any) => {
  const origJson = res.json.bind(res);
  res.json = (body: any) => {
    res.setHeader("Content-Length", String(Buffer.byteLength(JSON.stringify(body))));
    res.end();
    return res;
  };
  try {
    await chainIdHandler(req, res, next);
  } finally {
    res.json = origJson;
  }
});

// ===========================================================================
// /account/:address/nonce
// ===========================================================================

systemRouter.get("/account/:address/nonce", async (req, res, next) => {
  try {
    const address = StarknetAddress.parse(req.params.address);
    const nonce = await provider.getNonceForAddress(address, "pending");
    res.json({ address, nonce });
  } catch (e) {
    next(e);
  }
});

// ===========================================================================
// /system/live
// ===========================================================================

systemRouter.get("/system/live", (_req, res) => {
  res.json({ status: "ok" });
});

// ===========================================================================
// /system/ready
// ===========================================================================

systemRouter.get("/system/ready", async (_req, res, next) => {
  try {
    const [dbResult, rpcHealthy] = await Promise.all([
      checkDbHealth(),
      provider.getBlockNumber().then(
        () => true,
        () => false,
      ),
    ]);

    const checks: Record<string, string> = {};
    if (dbResult.healthy) checks.database = dbResult.degraded ? "degraded" : "reachable";
    else checks.database = "unreachable";

    if (rpcHealthy) checks["starknet-rpc"] = "reachable";
    else checks["starknet-rpc"] = "unreachable";

    const allHealthy = dbResult.healthy && rpcHealthy;
    res.status(allHealthy ? 200 : 503).json({ status: allHealthy ? "ok" : "degraded", checks });
  } catch (e) {
    next(e);
  }
});

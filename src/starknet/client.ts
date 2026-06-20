import { Contract, RpcProvider } from "starknet";
import { env, abiPaths } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "./abi.js";

export const provider = new RpcProvider({ nodeUrl: env.STARKNET_RPC_URL });

export function getEscrowAbi(): unknown[] {
  if (!abiPaths.escrow) {
    throw new Error("ESCROW_CONTRACT_CLASS_JSON path is not configured");
  }
  return loadAbiFromContractClassJsonPath(abiPaths.escrow);
}

export function getAgreementAbi(): unknown[] {
  if (!abiPaths.agreement) {
    throw new Error("AGREEMENT_CONTRACT_CLASS_JSON path is not configured");
  }
  return loadAbiFromContractClassJsonPath(abiPaths.agreement);
}

export function escrowContract(address: string) {
  const contract = new Contract(getEscrowAbi(), address, provider);
  return contract;
}

export function agreementContract(address: string) {
  const contract = new Contract(getAgreementAbi(), address, provider);
  return contract;
}

let cachedChainId: string | undefined;
let cachedSpecVersion: string | undefined;
let cacheExpiryTime = 0;

/**
 * Gets the chain ID and spec version from the Starknet RPC,
 * caching the result in memory for the specified TTL.
 *
 * @param ttlMs - Time-to-live in milliseconds (default: 5 minutes)
 * @returns An object containing the stringified chainId and specVersion
 */
export async function getCachedNetworkInfo(ttlMs = 300000): Promise<{ chainId: string; specVersion: string }> {
  const now = Date.now();
  if (cachedChainId && cachedSpecVersion && now < cacheExpiryTime) {
    return { chainId: cachedChainId, specVersion: cachedSpecVersion };
  }

  const [rawChainId, rawSpecVersion] = await Promise.all([
    provider.getChainId(),
    provider.getSpecVersion(),
  ]);

  cachedChainId = typeof rawChainId === "bigint" ? rawChainId.toString() : String(rawChainId);
  cachedSpecVersion = typeof rawSpecVersion === "bigint" ? rawSpecVersion.toString() : String(rawSpecVersion);
  cacheExpiryTime = now + ttlMs;

  return { chainId: cachedChainId, specVersion: cachedSpecVersion };
}

/**
 * Clears the network info cache. Primarily used for testing.
 */
export function clearNetworkCache(): void {
  cachedChainId = undefined;
  cachedSpecVersion = undefined;
  cacheExpiryTime = 0;
}

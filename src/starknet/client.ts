import { Contract, RpcProvider } from "starknet";
import { env, abiPaths } from "../config.js";
import { loadAbiFromContractClassJsonPath } from "./abi.js";

export const provider = new RpcProvider({ nodeUrl: env.STARKNET_RPC_URL });

// The contract-class JSON paths are fixed at startup, so each ABI is parsed
// from disk once and the result is memoized for every later call.
let escrowAbiCache: unknown[] | undefined;
let agreementAbiCache: unknown[] | undefined;

// Cached Contract instances keyed by "<kind>:<address>". The provider is a
// module-level singleton, so the kind and address fully identify an instance.
// The kind prefix keeps escrow and agreement ABIs from cross-contaminating, and
// the address in the key guarantees a cached instance is never reused for a
// different address.
const contractCache = new Map<string, Contract>();

/**
 * Returns the escrow contract ABI, parsing the contract-class JSON from disk on
 * the first call and serving the memoized array on every later call.
 *
 * @throws Error when ESCROW_CONTRACT_CLASS_JSON is not configured.
 */
export function getEscrowAbi(): unknown[] {
  if (!abiPaths.escrow) {
    throw new Error("ESCROW_CONTRACT_CLASS_JSON path is not configured");
  }
  if (!escrowAbiCache) {
    escrowAbiCache = loadAbiFromContractClassJsonPath(abiPaths.escrow);
  }
  return escrowAbiCache;
}

/**
 * Returns the agreement contract ABI, parsing the contract-class JSON from disk
 * on the first call and serving the memoized array on every later call.
 *
 * @throws Error when AGREEMENT_CONTRACT_CLASS_JSON is not configured.
 */
export function getAgreementAbi(): unknown[] {
  if (!abiPaths.agreement) {
    throw new Error("AGREEMENT_CONTRACT_CLASS_JSON path is not configured");
  }
  if (!agreementAbiCache) {
    agreementAbiCache = loadAbiFromContractClassJsonPath(abiPaths.agreement);
  }
  return agreementAbiCache;
}

/**
 * Returns a cached escrow Contract for the given address, constructing it once
 * and reusing the same instance on later calls with the same address.
 */
export function escrowContract(address: string): Contract {
  const key = `escrow:${address}`;
  let contract = contractCache.get(key);
  if (!contract) {
    contract = new Contract(getEscrowAbi(), address, provider);
    contractCache.set(key, contract);
  }
  return contract;
}

/**
 * Returns a cached agreement Contract for the given address, constructing it
 * once and reusing the same instance on later calls with the same address.
 */
export function agreementContract(address: string): Contract {
  const key = `agreement:${address}`;
  let contract = contractCache.get(key);
  if (!contract) {
    contract = new Contract(getAgreementAbi(), address, provider);
    contractCache.set(key, contract);
  }
  return contract;
}

/**
 * Clears the memoized ABIs and cached Contract instances. Primarily used by
 * tests that swap ABI paths so the next call reloads from disk.
 */
export function clearContractCache(): void {
  escrowAbiCache = undefined;
  agreementAbiCache = undefined;
  contractCache.clear();
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
export async function getCachedNetworkInfo(
  ttlMs = 300000,
): Promise<{ chainId: string; specVersion: string }> {
  const now = Date.now();
  if (cachedChainId && cachedSpecVersion && now < cacheExpiryTime) {
    return { chainId: cachedChainId, specVersion: cachedSpecVersion };
  }

  const [rawChainId, rawSpecVersion] = await Promise.all([
    provider.getChainId(),
    provider.getSpecVersion(),
  ]);

  const chainId = String(rawChainId);
  const specVersion = String(rawSpecVersion);
  cachedChainId = chainId;
  cachedSpecVersion = specVersion;
  cacheExpiryTime = now + ttlMs;

  return { chainId, specVersion };
}

/**
 * Clears the network info cache. Primarily used for testing.
 */
export function clearNetworkCache(): void {
  cachedChainId = undefined;
  cachedSpecVersion = undefined;
  cacheExpiryTime = 0;
}

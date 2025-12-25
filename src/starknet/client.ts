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



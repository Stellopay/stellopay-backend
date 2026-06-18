import { shortString, type TypedData } from "starknet";

/**
 * Builds the SNIP-12 typed-data challenge a wallet signs to prove ownership.
 *
 * Extracted from the auth route so it can be unit-tested in isolation, without
 * pulling in the Express router or the Starknet RPC provider.
 */
export function buildTypedChallenge(
  address: string,
  chainId: string,
  nonce: string,
): TypedData {
  // Wallets (ArgentX/Braavos) validate typed data using a JSON schema.
  // They expect plain string values like:
  // - domain.chainId: "SN_SEPOLIA" / "SN_MAIN"
  // - domain.name/version: plain strings
  // - message.action: plain string
  // (starknet.js will encode these according to the declared `felt` types when hashing/verifying)
  const chainIdLabel = shortString.decodeShortString(chainId);
  return {
    types: {
      StarknetDomain: [
        { name: "name", type: "felt" },
        { name: "version", type: "felt" },
        { name: "chainId", type: "felt" },
        // SNIP-12 domain revision (some wallets, e.g. Ready, require it)
        { name: "revision", type: "felt" },
      ],
      Challenge: [
        { name: "action", type: "felt" },
        { name: "wallet", type: "felt" },
        { name: "nonce", type: "felt" },
      ],
    },
    primaryType: "Challenge",
    domain: {
      name: "StelloPay",
      version: "1",
      chainId: chainIdLabel,
      revision: "1",
    },
    message: {
      action: "LOGIN",
      wallet: address,
      nonce,
    },
  };
}

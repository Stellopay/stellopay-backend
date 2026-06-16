import { describe, it, expect } from "vitest";
import { shortString } from "starknet";
import { buildTypedChallenge } from "../routes/auth.js";

// buildTypedChallenge receives the raw hex-felt chain ID from provider.getChainId()
// and internally calls shortString.decodeShortString() to get the human-readable label.
const CHAIN_ID_FELT = shortString.encodeShortString("SN_SEPOLIA"); // "0x534e5f5345504f4c4941"
const ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000001";
const NONCE = "0xdeadbeef";

describe("buildTypedChallenge", () => {
  it("returns an object with the expected primary type", () => {
    const td = buildTypedChallenge(ADDRESS, CHAIN_ID_FELT, NONCE);
    expect(td.primaryType).toBe("Challenge");
  });

  it("includes Challenge and StarknetDomain in types", () => {
    const td = buildTypedChallenge(ADDRESS, CHAIN_ID_FELT, NONCE);
    expect(td.types).toHaveProperty("Challenge");
    expect(td.types).toHaveProperty("StarknetDomain");
  });

  it("sets message fields from inputs", () => {
    const td = buildTypedChallenge(ADDRESS, CHAIN_ID_FELT, NONCE);
    expect((td.message as any).wallet).toBe(ADDRESS);
    expect((td.message as any).nonce).toBe(NONCE);
    expect((td.message as any).action).toBe("LOGIN");
  });

  it("decodes chainId felt into a human-readable label in the domain", () => {
    const td = buildTypedChallenge(ADDRESS, CHAIN_ID_FELT, NONCE);
    expect((td.domain as any).chainId).toBe("SN_SEPOLIA");
  });

  it("includes revision in the domain", () => {
    const td = buildTypedChallenge(ADDRESS, CHAIN_ID_FELT, NONCE);
    expect((td.domain as any).revision).toBe("1");
  });

  it("produces different typed data when nonce differs", () => {
    const td1 = buildTypedChallenge(ADDRESS, CHAIN_ID_FELT, "0x1111");
    const td2 = buildTypedChallenge(ADDRESS, CHAIN_ID_FELT, "0x2222");
    expect((td1.message as any).nonce).not.toBe((td2.message as any).nonce);
  });
});

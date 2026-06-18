import { describe, it, expect } from "vitest";
import { shortString } from "starknet";
import { buildTypedChallenge } from "./challenge";

// SN_SEPOLIA encoded as a felt short string, as the RPC provider returns it.
const chainId = shortString.encodeShortString("SN_SEPOLIA");

describe("buildTypedChallenge", () => {
  it("decodes the chainId felt back into its label", () => {
    const td = buildTypedChallenge("0x123", chainId, "0xnonce");
    expect((td.domain as Record<string, unknown>).chainId).toBe("SN_SEPOLIA");
  });

  it("uses Challenge as the primaryType and embeds wallet, nonce and action", () => {
    const td = buildTypedChallenge("0xWALLET", chainId, "0xabc123");
    expect(td.primaryType).toBe("Challenge");
    const message = td.message as Record<string, unknown>;
    expect(message.wallet).toBe("0xWALLET");
    expect(message.nonce).toBe("0xabc123");
    expect(message.action).toBe("LOGIN");
  });

  it("declares the SNIP-12 domain with name, version and revision", () => {
    const td = buildTypedChallenge("0x1", chainId, "0x2");
    const domain = td.domain as Record<string, unknown>;
    expect(domain.name).toBe("StelloPay");
    expect(domain.version).toBe("1");
    expect(domain.revision).toBe("1");
  });
});

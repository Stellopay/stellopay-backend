import { getChecksumAddress } from "starknet";

const STARKNET_ADDRESS_HEX_LENGTH = 64;

/**
 * Normalize a Starknet address to the canonical database lookup key.
 *
 * Canonical form is lowercase `0x` + 64 hex characters. Inputs may include or
 * omit the `0x` prefix, may use mixed case, and may include redundant leading
 * zeros. Redundant leading zeros are stripped before padding so `0x1`,
 * `1`, and `0x0001` all resolve to the same address value.
 *
 * Checksum validation: if the input mixes upper- and lower-case hex letters
 * (e.g. `0xAb12...`), it is treated as an asserted SNIP-23 / EIP-55 style
 * checksum address and is verified against the expected checksum for that
 * address (via `starknet`'s `getChecksumAddress`). A mismatch — such as a
 * single bit-flipped character — is rejected instead of silently normalized,
 * since silently accepting it could resolve to the wrong on-chain account.
 * Addresses that are entirely lowercase or entirely uppercase carry no
 * checksum information and are accepted as before.
 *
 * Throws for empty, non-hex, wider-than-felt, or invalid-checksum values
 * instead of silently creating a lookup key that could never match (or could
 * mismatch) an on-chain Starknet address.
 */
export function normalizeStarknetAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new Error("Starknet address is required");
  }
  const normalized = trimmed.toLowerCase();
  const prefixed = normalized.startsWith("0x") ? normalized : `0x${normalized}`;
  const hex = prefixed.replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error("Starknet address must be a hex string");
  }
  const canonicalHex = hex.replace(/^0+/, "") || "0";
  if (canonicalHex.length > STARKNET_ADDRESS_HEX_LENGTH) {
    throw new Error("Starknet address exceeds 64 hex characters");
  }
  const canonical = `0x${canonicalHex.padStart(STARKNET_ADDRESS_HEX_LENGTH, "0")}`;

  const rawHex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  const hasUpper = /[A-F]/.test(rawHex);
  const hasLower = /[a-f]/.test(rawHex);
  if (hasUpper && hasLower) {
    const rawCanonicalHex = rawHex.replace(/^0+/, "") || "0";
    const paddedOriginal = `0x${rawCanonicalHex.padStart(STARKNET_ADDRESS_HEX_LENGTH, "0")}`;
    if (paddedOriginal !== getChecksumAddress(canonical)) {
      throw new Error("Starknet address has an invalid checksum");
    }
  }

  return canonical;
}

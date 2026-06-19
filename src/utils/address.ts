const STARKNET_ADDRESS_HEX_LENGTH = 64;

/**
 * Normalize a Starknet address to the canonical database lookup key.
 *
 * Canonical form is lowercase `0x` + 64 hex characters. Inputs may include or
 * omit the `0x` prefix, may use mixed case, and may include redundant leading
 * zeros. Redundant leading zeros are stripped before padding so `0x1`,
 * `1`, and `0x0001` all resolve to the same address value.
 *
 * Throws for empty, non-hex, or wider-than-felt values instead of silently
 * creating a lookup key that could never match an on-chain Starknet address.
 */
export function normalizeStarknetAddress(address: string): string {
  const normalized = address.trim().toLowerCase();

  if (!normalized) {
    throw new Error("Starknet address is required");
  }

  const prefixed = normalized.startsWith("0x") ? normalized : `0x${normalized}`;
  const hex = prefixed.replace(/^0x/, "");

  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error("Starknet address must be a hex string");
  }

  const canonicalHex = hex.replace(/^0+/, "") || "0";

  if (canonicalHex.length > STARKNET_ADDRESS_HEX_LENGTH) {
    throw new Error("Starknet address exceeds 64 hex characters");
  }

  return `0x${canonicalHex.padStart(STARKNET_ADDRESS_HEX_LENGTH, "0")}`;
}

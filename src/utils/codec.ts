import { cairo } from "starknet";

export function parseU256(value: string) {
  const bn = BigInt(value);
  return cairo.uint256(bn);
}

export function u256ToString(v: unknown): string {
  // starknet.js returns uint256 as { low, high } sometimes (strings/bigints)
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return BigInt(v).toString();
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "low" in v && "high" in v) {
    const low = BigInt((v as any).low);
    const high = BigInt((v as any).high);
    return (low + (high << 128n)).toString();
  }
  // fallback
  return JSON.stringify(v);
}

export function toHexString(value: bigint | string | number): string {
  if (typeof value === "string") {
    return value.startsWith("0x") ? value : `0x${value}`;
  }
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }
  return `0x${BigInt(value).toString(16)}`;
}

/**
 * Canonical Starknet address normalisation: lowercase 0x-prefixed 66-char hex.
 * Rule: lowercase → ensure 0x prefix → pad hex part to 64 chars with leading zeros.
 * Preserves leading zeros (do NOT strip them before padding — indexer stores padded addresses).
 */
export function normalizeStarknetAddress(addr: string): string {
  if (!addr) return addr;
  let normalized = addr.toLowerCase().trim();
  if (!normalized.startsWith("0x")) {
    normalized = `0x${normalized}`;
  }
  const hex = normalized.slice(2); // strip 0x
  return `0x${hex.padStart(64, "0")}`;
}

/**
 * Canonical transaction hash normalisation: lowercase 0x-prefixed 66-char hex.
 * If the hash is already 66 chars (0x + 64 hex) it is returned unchanged to preserve
 * leading zeros. Otherwise the hex part is padded to 64 chars.
 */
export function normalizeTransactionHash(hash: string): string {
  if (!hash) return hash;
  let normalized = hash.toLowerCase().trim();
  if (!normalized.startsWith("0x")) {
    normalized = `0x${normalized}`;
  }
  if (normalized.length === 66) return normalized;
  const hex = normalized.slice(2);
  return `0x${hex.padStart(64, "0")}`;
}



import { cairo } from "starknet";

export function parseU256(value: string) {
  const bn = BigInt(value);
  return cairo.uint256(bn);
}

export function normalizeStarknetAddress(addr: string): string {
  if (!addr) return addr;
  let normalized = addr.toLowerCase().trim();
  if (!normalized.startsWith("0x")) normalized = `0x${normalized}`;
  const hex = normalized.slice(2);
  return `0x${hex.padStart(64, "0")}`;
}

export function normalizeTransactionHash(hash: string): string {
  if (!hash) return hash;
  let normalized = hash.toLowerCase().trim();
  if (!normalized.startsWith("0x")) normalized = `0x${normalized}`;
  if (normalized.length === 66) return normalized;
  return `0x${normalized.slice(2).padStart(64, "0")}`;
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
    // If already a hex string, ensure it starts with 0x
    return value.startsWith("0x") ? value : `0x${value}`;
  }
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }
  return `0x${BigInt(value).toString(16)}`;
}



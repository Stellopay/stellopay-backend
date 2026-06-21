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
    // If already a hex string, ensure it starts with 0x
    return value.startsWith("0x") ? value : `0x${value}`;
  }
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }
  return `0x${BigInt(value).toString(16)}`;
}

/**
 * Default token precision used across the API when a token-specific value is
 * not available. USDC and USDT both use 6 decimals, which is the convention the
 * payment routes assume.
 */
export const DEFAULT_TOKEN_DECIMALS = 6;

/**
 * Formats a raw integer token amount (u256 base units) into a precise
 * fixed-decimal string using BigInt math, never coercing through `number`.
 *
 * On-chain amounts are stored as u256 and routinely exceed
 * `Number.MAX_SAFE_INTEGER`, so the common `Number(raw) / 10 ** decimals`
 * conversion silently loses precision and overflows. This helper performs the
 * division entirely in BigInt space and renders the decimal string directly,
 * trimming trailing fractional zeros.
 *
 * @param raw - The raw amount in base units, as a decimal integer string or a
 *   bigint. Untrusted strings are validated as decimal integers before being
 *   passed to `BigInt()`, so malformed data fails with a descriptive error
 *   instead of an opaque `SyntaxError` and is never silently mis-formatted.
 * @param decimals - The token's decimal precision. Defaults to
 *   {@link DEFAULT_TOKEN_DECIMALS} (6, for USDC/USDT). Pass 18 for STRK, or any
 *   other token-specific precision, to override.
 * @returns The amount as a precise decimal string. Whole amounts return without
 *   a fractional part.
 * @throws {RangeError} If `decimals` is not a non-negative integer.
 * @throws {TypeError} If `raw` is a string that is not a decimal integer.
 *
 * @example
 * formatTokenAmount("1500000");                       // "1.5"
 * formatTokenAmount("1000000000000000000", 18);       // "1"
 * formatTokenAmount("12345678901234567890");          // "12345678901234.56789"
 * formatTokenAmount(0n);                              // "0"
 */
export function formatTokenAmount(
  raw: string | bigint,
  decimals: number = DEFAULT_TOKEN_DECIMALS
): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer, got ${decimals}`);
  }

  let amount: bigint;
  if (typeof raw === "bigint") {
    amount = raw;
  } else {
    // Untrusted u256 amounts must never reach BigInt() unchecked: validate the
    // decimal-integer shape first so malformed input throws a clear TypeError
    // rather than an opaque SyntaxError, and is never coerced through Number.
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new TypeError(`expected a decimal integer string, got "${raw}"`);
    }
    amount = BigInt(trimmed);
  }

  if (decimals === 0) {
    return amount.toString();
  }

  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const fraction = abs % divisor;
  const sign = negative ? "-" : "";

  if (fraction === 0n) {
    return `${sign}${whole.toString()}`;
  }

  // Left-pad the fractional part to full width, then drop trailing zeros.
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}.${fractionStr}`;
}


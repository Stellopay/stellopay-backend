import { env } from "../config.js";
import { normalizeStarknetAddress as normalizeAddress } from "./address.js";

export interface TokenInfo {
  name: string;
  icon: string;
  decimals: number;
  isSTRK: boolean;
}

const STRK_TOKEN_ADDRESS = env.TOKEN_STRK || "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const USDC_TOKEN_ADDRESS = env.TOKEN_USDC || "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080";
const USDT_TOKEN_ADDRESS = env.TOKEN_USDT || "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb";

const NORMALIZED_STRK = normalizeAddress(STRK_TOKEN_ADDRESS);
const NORMALIZED_USDC = normalizeAddress(USDC_TOKEN_ADDRESS);
const NORMALIZED_USDT = normalizeAddress(USDT_TOKEN_ADDRESS);

/**
 * Resolve token metadata from a token address using the configured known tokens.
 * Unknown addresses default to USDC-style 6-decimal formatting so existing flows remain predictable.
 */
export function getTokenInfo(tokenAddress: string | null | undefined): TokenInfo {
  if (!tokenAddress) {
    return { name: "-", icon: "", decimals: 0, isSTRK: false };
  }

  const normalized = normalizeAddress(tokenAddress);

  if (normalized === NORMALIZED_STRK) {
    return {
      name: "STRK",
      icon: "/strk-logo.png",
      decimals: 18,
      isSTRK: true,
    };
  }

  if (normalized === NORMALIZED_USDC) {
    return {
      name: "USDC",
      icon: "/usdc-logo.png",
      decimals: 6,
      isSTRK: false,
    };
  }

  if (normalized === NORMALIZED_USDT) {
    return {
      name: "USDT",
      icon: "/usdt-logo.png",
      decimals: 6,
      isSTRK: false,
    };
  }

  return {
    name: "USDC",
    icon: "/usdc-logo.png",
    decimals: 6,
    isSTRK: false,
  };
}

/**
 * Format an on-chain amount using BigInt arithmetic and the token's decimal precision.
 * This avoids lossy Number conversions for large u256 values while preserving the full decimal string.
 *
 * Rounding convention: the exact on-chain value is always preserved — no rounding or
 * truncation is applied at any `decimals` precision (including > 18); only trailing
 * zeros in the fraction are trimmed. Callers that want a shorter display precision
 * (e.g. STRK shown with 6 fraction digits in the transactions route) truncate the
 * returned string themselves.
 */
export function formatTokenAmount(amount: string | bigint | null | undefined, decimals: number): string {
  if (amount === null || amount === undefined || amount === "" || amount === "0" || amount === 0n) {
    return "0";
  }

  const amountBigInt = typeof amount === "string" ? BigInt(amount) : amount;
  // Format the absolute value and re-apply the sign, since BigInt `/` and `%`
  // both carry the sign and would otherwise yield output like "-1.-5" or drop
  // the sign entirely for values between -1 and 0.
  const sign = amountBigInt < 0n ? "-" : "";
  const absAmount = amountBigInt < 0n ? -amountBigInt : amountBigInt;
  const divisor = 10n ** BigInt(decimals);
  const wholePart = absAmount / divisor;
  const fractionalStr = (absAmount % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");

  return fractionalStr ? `${sign}${wholePart}.${fractionalStr}` : `${sign}${wholePart}`;
}

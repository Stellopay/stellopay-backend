import { env } from "../config.js";
import { normalizeStarknetAddress } from "./address.js";
import { DEFAULT_TOKEN_DECIMALS } from "./codec.js";

/**
 * STRK is the only supported token that does not use 6 decimals, so it is the
 * only address we need to distinguish. The fallback mirrors the value used by
 * the transactions route and is overridable via the TOKEN_STRK env var.
 */
const STRK_TOKEN_ADDRESS =
  env.TOKEN_STRK ||
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

const STRK_DECIMALS = 18;

// Resolve the STRK address once at module load. A malformed override should not
// take down the module, so fall back to "no STRK match" if it cannot normalize.
/* v8 ignore start -- defensive: only reachable via a malformed TOKEN_STRK override */
let normalizedStrk: string | null;
try {
  normalizedStrk = normalizeStarknetAddress(STRK_TOKEN_ADDRESS);
} catch {
  normalizedStrk = null;
}
/* v8 ignore stop */

/**
 * Resolves the decimal precision for a Starknet token address.
 *
 * STRK uses 18 decimals; USDC, USDT, and any unrecognized or malformed token
 * resolve to {@link DEFAULT_TOKEN_DECIMALS} (6). This mirrors the decimals
 * logic in the transactions route so amount formatting stays consistent across
 * the API.
 *
 * @param tokenAddress - The token contract address, or null/undefined.
 * @returns 18 for STRK, otherwise 6.
 *
 * @example
 * tokenDecimals(strkAddress); // 18
 * tokenDecimals(usdcAddress); // 6
 * tokenDecimals(null);        // 6
 */
export function tokenDecimals(tokenAddress: string | null | undefined): number {
  if (!tokenAddress) {
    return DEFAULT_TOKEN_DECIMALS;
  }
  try {
    return normalizeStarknetAddress(tokenAddress) === normalizedStrk
      ? STRK_DECIMALS
      : DEFAULT_TOKEN_DECIMALS;
  } catch {
    // A malformed token address never matches a known token; format with the
    // default precision rather than throwing on the display path.
    return DEFAULT_TOKEN_DECIMALS;
  }
}

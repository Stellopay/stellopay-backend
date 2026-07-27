import { env } from "../config.js";
import { normalizeStarknetAddress } from "./address.js";
import { DEFAULT_TOKEN_DECIMALS } from "./codec.js";
import { provider } from "../starknet/client.js";
import { shortString } from "starknet";

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

// ---------- LRU Cache for Token Metadata ----------

/**
 * Maximum number of token addresses to cache metadata for.
 * Bounds memory growth while covering typical active token usage.
 */
const TOKEN_CACHE_MAX_SIZE = 100;

/**
 * Simple LRU cache entry for token metadata.
 */
interface CacheEntry<K, V> {
  key: K;
  value: V;
  prev: CacheEntry<K, V> | null;
  next: CacheEntry<K, V> | null;
}

/**
 * Bounded LRU cache for token metadata resolution.
 * Uses normalized addresses as keys to prevent cache poisoning from case variants.
 */
class LRUCache<K, V> {
  private cache: Map<K, CacheEntry<K, V>>;
  private head: CacheEntry<K, V> | null;
  private tail: CacheEntry<K, V> | null;
  private maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.head = null;
    this.tail = null;
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Move to head (most recently used)
    this.moveToHead(entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    const existing = this.cache.get(key);
    if (existing) {
      existing.value = value;
      this.moveToHead(existing);
      return;
    }

    const entry: CacheEntry<K, V> = { key, value, prev: null, next: null };
    this.cache.set(key, entry);

    if (!this.head) {
      this.head = entry;
      this.tail = entry;
    } else {
      entry.next = this.head;
      this.head.prev = entry;
      this.head = entry;
    }

    // Evict least recently used if over capacity
    if (this.cache.size > this.maxSize && this.tail) {
      this.cache.delete(this.tail.key);
      if (this.tail.prev) {
        this.tail.prev.next = null;
        this.tail = this.tail.prev;
      } else {
        this.head = null;
        this.tail = null;
      }
    }
  }

  clear(): void {
    this.cache.clear();
    this.head = null;
    this.tail = null;
  }

  get size(): number {
    return this.cache.size;
  }

  private moveToHead(entry: CacheEntry<K, V>): void {
    if (entry === this.head) return;

    if (entry.prev) {
      entry.prev.next = entry.next;
    }
    if (entry.next) {
      entry.next.prev = entry.prev;
    }
    if (entry === this.tail) {
      this.tail = entry.prev;
    }

    entry.prev = null;
    entry.next = this.head;
    if (this.head) {
      this.head.prev = entry;
    }
    this.head = entry;
  }
}

// Separate caches for decimals and symbols to allow independent caching
const decimalsCache = new LRUCache<string, number>(TOKEN_CACHE_MAX_SIZE);
const symbolCache = new LRUCache<string, string>(TOKEN_CACHE_MAX_SIZE);

/**
 * Resolves token decimals via RPC call with memoization.
 *
 * Caches results by normalized address to avoid repeated RPC calls for the same token.
 * Cache is bounded (LRU, max 100 entries) to prevent unbounded memory growth.
 *
 * @param tokenAddress - The token contract address.
 * @returns The token's decimal precision.
 * @throws If the RPC call fails or returns invalid data.
 *
 * @example
 * const decimals = await erc20Decimals("0xabc..."); // First call: RPC
 * const decimals2 = await erc20Decimals("0xabc..."); // Second call: cached
 */
export async function erc20Decimals(tokenAddress: string): Promise<number> {
  const normalized = normalizeStarknetAddress(tokenAddress);
  const cached = decimalsCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }

  const result = await provider.callContract({
    contractAddress: normalized,
    entrypoint: "decimals",
    calldata: [],
  });

  const output = Array.isArray(result) ? result : (result as any)?.result;
  if (!Array.isArray(output) || output.length === 0) {
    throw new Error(`Unexpected decimals result: ${JSON.stringify(result)}`);
  }

  const decimals = Number(BigInt(output[0]));
  decimalsCache.set(normalized, decimals);
  return decimals;
}

/**
 * Resolves token symbol via RPC call with memoization.
 *
 * Caches results by normalized address to avoid repeated RPC calls for the same token.
 * Cache is bounded (LRU, max 100 entries) to prevent unbounded memory growth.
 *
 * @param tokenAddress - The token contract address.
 * @returns The token's symbol (decoded from short-string if possible).
 * @throws If the RPC call fails or returns invalid data.
 *
 * @example
 * const symbol = await erc20Symbol("0xabc..."); // First call: RPC
 * const symbol2 = await erc20Symbol("0xabc..."); // Second call: cached
 */
export async function erc20Symbol(tokenAddress: string): Promise<string> {
  const normalized = normalizeStarknetAddress(tokenAddress);
  const cached = symbolCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }

  const result = await provider.callContract({
    contractAddress: normalized,
    entrypoint: "symbol",
    calldata: [],
  });

  const output = Array.isArray(result) ? result : (result as any)?.result;
  if (!Array.isArray(output) || output.length === 0) {
    throw new Error(`Unexpected symbol result: ${JSON.stringify(result)}`);
  }

  let symbol = String(output[0]);
  try {
    symbol = shortString.decodeShortString(symbol);
  } catch {
    // If decoding fails, use the raw value
  }

  symbolCache.set(normalized, symbol);
  return symbol;
}

/**
 * Clears the token metadata caches.
 *
 * Intended for test isolation to ensure deterministic test behavior.
 * Should not be called in production code.
 */
export function clearTokenMetadataCaches(): void {
  decimalsCache.clear();
  symbolCache.clear();
}

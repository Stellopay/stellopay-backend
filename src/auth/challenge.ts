import crypto from "node:crypto";
import { shortString, type TypedData } from "starknet";
import { normalizeStarknetAddress } from "../utils/address.js";

/**
 * Nonce challenge generation and expiry contract.
 *
 * The contract is intentionally narrow so the wallet-login flow cannot drift
 * as new routes are added. The full contract — including the rationale for
 * in-memory retention and the list of intentionally out-of-scope concerns —
 * is documented in `docs/auth/challenge.md`; the body of this file is the
 * implementation side of that contract. If the two ever disagree, the
 * document is the source of truth and this file needs fixing.
 *
 * TL;DR:
 *   - Every entry is keyed by the CANONICAL Starknet address
 *     (`normalizeStarknetAddress`), so `0x1`, `0x0001` and `0x000…001` all
 *     address the same challenge slot.
 *   - `createChallenge` requires a parseable Starknet address. Within an
 *     active TTL window it re-issues the SAME nonce with the REMAINING TTL
 *     (idempotent retry); it refuses to store a new entry when the store is
 *     at `MAX_CHALLENGES` (DoS hardening).
 *   - `getChallenge` / `clearChallenge` / `consumeChallenge` tolerate
 *     malformed addresses by returning null / no-op; they never throw.
 *   - `consumeChallenge` is the ONLY safe way to read a challenge before
 *     signature verification: it deletes atomically to close the replay
 *     race (two concurrent verify calls seeing the same nonce).
 *   - `buildTypedChallenge` normalizes the wallet field to the canonical
 *     (lowercase, padded) form so the wallet's signature hash matches
 *     exactly what the backend stored when the challenge was issued.
 *   - All challenges are 16-byte cryptographic nonces with a fixed
 *     `CHALLENGE_TTL_MS` TTL; expired entries are evicted lazily on read and
 *     opportunistically swept on the write path.
 *
 * Every state transition emits one JSON `metric` line on `console.info` so
 * an operator can reconstruct a login attempt from logs alone. The logged
 * `address` is always the canonical key, never a raw caller-supplied string.
 */

// ---------------------------------------------------------------------------
// SNIP-12 type definitions — constant across all challenges.
// Declared once at module level so they are never re-created per-request.
// ---------------------------------------------------------------------------

const CHALLENGE_TYPES: TypedData["types"] = {
  StarknetDomain: [
    { name: "name", type: "felt" },
    { name: "version", type: "felt" },
    { name: "chainId", type: "felt" },
    // SNIP-12 domain revision (some wallets, e.g. Ready, require it)
    { name: "revision", type: "felt" },
  ],
  Challenge: [
    { name: "action", type: "felt" },
    { name: "wallet", type: "felt" },
    { name: "nonce", type: "felt" },
  ],
};

/** A stored challenge: the nonce a wallet must sign, and when it stops being valid. */
export type ChallengeRecord = {
  nonce: string;
  /** Absolute expiry, `Date.now()`-based. Strictly compared: `now > expiresAtMs`. */
  expiresAtMs: number;
};

/** How long an issued nonce stays valid. Never extended by a retry. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Hard cap on the in-memory challenge store. Prevents unbounded Map growth
 * under spam: an attacker who keeps calling `createChallenge` from fresh
 * addresses would otherwise OOM the server. At 100k entries of ~80 bytes
 * each the store tops out around ~8MB; beyond that `createChallenge` throws
 * and the route layer surfaces it as a 5xx rather than silently dropping a
 * security-relevant signal.
 */
export const MAX_CHALLENGES = 100_000;

/**
 * Challenges are short-lived cryptographic nonces used to prove wallet
 * ownership, keyed by canonical Starknet address.
 *
 * RATIONALE FOR IN-MEMORY RETENTION:
 * Challenges are highly transient. Storing them in-memory avoids unnecessary
 * DB read/write overhead for every unauthenticated challenge request. If the
 * server restarts, or a different instance handles the verification, the
 * wallet client simply requests a new nonce — no negative security
 * implications and minimal user friction.
 *
 * Exported so tests can assert on store contents and drive the size cap
 * directly. Production code outside this module must go through the
 * functions below.
 */
export const challenges = new Map<string, ChallengeRecord>();

/** Decodes a Starknet chain-ID felt into a human-readable label (e.g. "SN_SEPOLIA"). */
function getChainIdLabel(chainId: string): string {
  const cached = chainIdCache.get(chainId);
  if (cached) return cached;
  try {
    const label = shortString.decodeShortString(chainId);
    chainIdCache.set(chainId, label);
    return label;
  } catch {
    return chainId;
  }
}

/**
 * Number of `createChallenge` calls between opportunistic sweeps of expired
 * entries.
 *
 * `getChallenge`/`consumeChallenge` only evict an entry when it is *read*, so
 * an address that requests a challenge and never follows up with
 * `/auth/verify` (an abandoned login, or an attacker enumerating addresses)
 * would otherwise sit in `challenges` forever, growing the map without bound.
 * Sweeping periodically on the write path bounds that growth without needing
 * a background timer, which would complicate shutdown and test lifecycles.
 */
const SWEEP_INTERVAL = 50;
let creationsSinceSweep = 0;

/**
 * Memoised mapping from encoded chain-ID felt → human-readable label.
 *
 * `buildTypedChallenge` runs on both `/auth/challenge` and `/auth/verify`,
 * and the chain ID is effectively constant for the process lifetime, so the
 * short-string decode is cached rather than repeated per request. The key
 * space is bounded by the number of distinct chain IDs the RPC provider
 * reports — one, in practice.
 */
const chainIdCache = new Map<string, string>();

/** Removes all entries whose TTL has already elapsed as of `now`. */
function sweepExpiredChallenges(now: number): void {
  for (const [key, rec] of challenges) {
    if (now > rec.expiresAtMs) {
      challenges.delete(key);
    }
  }
}

/** Emits one structured metric line. `console.info` carries the request id. */
function logChallengeMetric(metric: string, fields: Record<string, unknown> = {}): void {
  console.info(
    JSON.stringify({
      metric,
      ...fields,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Issues (or re-issues) the challenge nonce a wallet must sign.
 *
 * IDEMPOTENT WITHIN THE ACTIVE WINDOW: if the address already has an
 * unexpired challenge, the existing nonce is returned with its REMAINING
 * TTL and a `challenge_replayed` metric. The TTL is never pushed forward, so
 * a client that retries `/auth/challenge` cannot extend the replay window,
 * and a retry cannot invalidate an in-flight `/auth/verify` for the same
 * address by overwriting the nonce underneath it.
 *
 * @param address - The user's Starknet wallet address
 * @returns The nonce and the milliseconds remaining before it expires
 * @throws if the address cannot be normalized to a Starknet address, or if a
 *   new entry would exceed `MAX_CHALLENGES`.
 */
export function createChallenge(address: string): { nonce: string; expires_in_ms: number } {
  const key = normalizeAddressKey(address);
  if (key === null) {
    throw new Error("createChallenge: address is not a parseable Starknet address");
  }

  const now = Date.now();

  creationsSinceSweep += 1;
  if (creationsSinceSweep >= SWEEP_INTERVAL) {
    creationsSinceSweep = 0;
    sweepExpiredChallenges(now);
  }

  const existing = challenges.get(key);
  if (existing && now <= existing.expiresAtMs) {
    const remainingMs = existing.expiresAtMs - now;
    logChallengeMetric("challenge_replayed", { address: key, expires_in_ms: remainingMs });
    return { nonce: existing.nonce, expires_in_ms: remainingMs };
  }

  if (existing) {
    // Expired: drop it here so the size check below sees an accurate count.
    challenges.delete(key);
  }

  if (challenges.size >= MAX_CHALLENGES) {
    // Last resort before refusing: reclaim whatever has already expired.
    sweepExpiredChallenges(now);
    if (challenges.size >= MAX_CHALLENGES) {
      logChallengeMetric("challenge_rejected", { reason: "store_full", size: challenges.size });
      throw new Error("createChallenge: challenge store is full");
    }
  }

  const nonce = `0x${crypto.randomBytes(16).toString("hex")}`;
  challenges.set(key, { nonce, expiresAtMs: now + CHALLENGE_TTL_MS });
  logChallengeMetric("challenge_created", { address: key, expires_in_ms: CHALLENGE_TTL_MS });

  return { nonce, expires_in_ms: CHALLENGE_TTL_MS };
}

/**
 * Retrieves the challenge record for verification. Expired entries are
 * evicted on access.
 *
 * Read-only: prefer {@link consumeChallenge} anywhere a challenge is about to
 * be verified.
 *
 * @param address - The user's Starknet wallet address
 * @returns The challenge record if found and still valid, otherwise null.
 *   Malformed addresses resolve to null without throwing.
 */
export function getChallenge(address: string): ChallengeRecord | null {
  const key = normalizeAddressKey(address);
  if (key === null) {
    logChallengeMetric("challenge_miss", { reason: "invalid_address" });
    return null;
  }

  const rec = challenges.get(key);
  if (!rec) {
    logChallengeMetric("challenge_miss", { reason: "not_found", address: key });
    return null;
  }

  if (Date.now() > rec.expiresAtMs) {
    challenges.delete(key);
    logChallengeMetric("challenge_expired", { address: key });
    return null;
  }

  return rec;
}

/**
 * Drops the challenge for an address, if there is one.
 *
 * A silent no-op when the address is malformed or has no stored challenge —
 * only an actual deletion emits `challenge_cleared`, so the metric counts
 * real state transitions rather than call volume.
 */
export function clearChallenge(address: string): void {
  const key = normalizeAddressKey(address);
  if (key === null) return;

  if (challenges.delete(key)) {
    logChallengeMetric("challenge_cleared", { address: key });
  }
}

/**
 * Atomically reads and deletes the challenge for an address in a single step.
 *
 * This must be used (instead of getChallenge + a later clearChallenge)
 * anywhere a challenge is about to be verified. getChallenge is read-only, so
 * if it is read at the start of an async verification and only cleared
 * afterwards, two concurrent requests can both read the same still-valid
 * nonce before either one clears it — letting the same challenge be consumed
 * twice (a replay bypass). Deleting it at read time closes that gap: the
 * second concurrent caller sees it already gone.
 *
 * @param address - The user's Starknet wallet address
 * @returns The challenge record if it existed and was still valid, else null
 */
export function consumeChallenge(address: string): ChallengeRecord | null {
  const rec = getChallenge(address);
  if (!rec) return null;

  const key = normalizeAddressKey(address);
  if (key !== null) challenges.delete(key);

  logChallengeMetric("challenge_consumed", { address: key });
  return rec;
}

/**
 * Builds the SNIP-12 typed-data challenge a wallet signs to prove ownership.
 *
 * Extracted from the auth route so it can be unit-tested in isolation,
 * without pulling in the Express router or the Starknet RPC provider.
 *
 * The wallet field is normalized to the canonical (lowercase, padded) form
 * before being placed in the typed-data message. This keeps the signature the
 * wallet produces stable regardless of how the caller cased or padded the
 * input address, and matches the canonical key the `challenges` Map stores
 * the nonce under.
 *
 * @throws if `address` is not a parseable Starknet address. The route
 *   layer's Zod schema already validates the request body, so reaching this
 *   is a caller bug rather than something to silently paper over.
 */
export function buildTypedChallenge(address: string, chainId: string, nonce: string): TypedData {
  const canonicalAddress = canonicalWalletAddress(address);
  // Wallets (ArgentX/Braavos) validate typed data using a JSON schema.
  // They expect plain string values like:
  // - domain.chainId: "SN_SEPOLIA" / "SN_MAIN"
  // - domain.name/version: plain string
  // - message.action: plain string
  // (starknet.js encodes these according to the declared `felt` types when
  // hashing/verifying)
  return {
    types: CHALLENGE_TYPES,
    primaryType: "Challenge",
    domain: {
      name: "StelloPay",
      version: "1",
      chainId: getChainIdLabel(chainId),
      revision: "1",
    },
    message: {
      action: "LOGIN",
      wallet: canonicalAddress,
      nonce,
    },
  };
}

/**
 * Decodes an encoded chain-ID felt into its human-readable label
 * ("SN_SEPOLIA", "SN_MAIN"), memoising the result — see {@link chainIdCache}.
 */
function getChainIdLabel(chainId: string): string {
  const cached = chainIdCache.get(chainId);
  if (cached !== undefined) return cached;

  const label = shortString.decodeShortString(chainId);
  chainIdCache.set(chainId, label);
  return label;
}

/**
 * Returns the canonical Starknet address (lowercase, `0x` + 64 hex) for use
 * as a `challenges` Map key, or null if the input is not a usable Starknet
 * address. Returns null rather than throwing so `getChallenge` /
 * `clearChallenge` / `consumeChallenge` degrade gracefully on malformed input
 * instead of 500'ing the auth route.
 */
function normalizeAddressKey(address: string): string | null {
  if (typeof address !== "string" || address.length === 0) return null;
  try {
    return normalizeStarknetAddress(address);
  } catch {
    return null;
  }
}

/**
 * Returns the canonical wallet field for `buildTypedChallenge`. Throws on
 * malformed input — see that function's `@throws`.
 */
function canonicalWalletAddress(address: string): string {
  const canonical = normalizeAddressKey(address);
  if (canonical === null) {
    throw new Error("buildTypedChallenge: address is not a parseable Starknet address");
  }
  return canonical;
}

/**
 * Resets the challenge store and the sweep counter.
 *
 * Only intended for tests that need a clean slate between cases. Production
 * code must not call this — it would invalidate every in-flight login.
 */
export function clearChallengesForTesting(): void {
  challenges.clear();
  creationsSinceSweep = 0;
}

/**
 * Clears the chain-ID decode cache.
 *
 * Only intended for tests that verify the caching behaviour or construct
 * unusual chainId values. Production code must not call this.
 */
export function clearChainIdCacheForTesting(): void {
  chainIdCache.clear();
}

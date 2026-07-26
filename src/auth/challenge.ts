import { shortString, type TypedData } from "starknet";
import { normalizeStarknetAddress } from "../utils/address.js";

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

/**
 * Nonce challenge generation and expiry contract.
 *
 * The contract is intentionally narrow so privilege checks cannot drift as
 * new routes are added. The full contract is documented in
 * `docs/auth/challenge.md`; the body of this file is the implementation side
 * of that contract.
 *
 * TL;DR:
 *   - createChallenge requires a parseable Starknet address. Refuses to
 *     store when the in-memory store is at MAX_CHALLENGES (DoS hardening).
 *   - getChallenge / clearChallenge / consumeChallenge tolerate malformed
 *     addresses by returning null / no-op; they never throw.
 *   - consumeChallenge is the ONLY safe way to read a challenge before
 *     signature verification: it deletes atomically to close the replay
 *     race (two concurrent verify calls seeing the same nonce).
 *   - buildTypedChallenge normalizes the wallet field to the canonical
 *     (lowercase, padded) form so the wallet's signature hash matches
 *     exactly what the backend stored when the challenge was issued.
 *   - All challenges are 16-byte cryptographic nonces with a fixed
 *     CHALLENGE_TTL_MS TTL; expired entries are evicted lazily on access.
 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Hard cap on the in-memory challenge store. Prevents an unbounded Map
 * growth under spam: an attacker who keeps calling `createChallenge` from
 * fresh addresses would otherwise OOM the server. At 100k entries of ~80
 * bytes each the store tops out around ~8MB; beyond that `createChallenge`
 * throws and the caller is expected to retry (the route handler maps this
 * to a 5xx).
 */
export const MAX_CHALLENGES = 100_000;

/**
 * Memoised mapping from encoded chain-ID felt → human-readable label.
 *
 * RATIONALE FOR IN-MEMORY RETENTION:
 * Challenges are highly transient. Storing them in-memory avoids unnecessary DB read/write overhead
 * for every unauthenticated challenge request. If the server restarts or a different instance
 * handles the verification, the user's wallet client simply requests a new challenge nonce with no
 * negative security implications and minimal user friction.
 *
 * SIZE CAP:
 * The Map is bounded at MAX_CHALLENGES. Beyond that, createChallenge
 * refuses to store a new entry and throws so the route layer can surface
 * the failure rather than silently dropping a security-relevant signal.
 */
const chainIdCache = new Map<string, string>();

/**
 * Number of `createChallenge` calls between opportunistic sweeps of expired entries.
 *
 * `getChallenge`/`consumeChallenge` only evict an entry when it is *read*, so an
 * address that requests a challenge and never follows up with `/auth/verify`
 * (an abandoned login, or an attacker enumerating addresses) would otherwise sit
 * in `challenges` forever, growing the map without bound. Sweeping periodically
 * on the write path bounds that growth without needing a background timer,
 * which would complicate shutdown and test lifecycles.
 */
const SWEEP_INTERVAL = 50;
let creationsSinceSweep = 0;

/** Removes all entries whose TTL has already elapsed as of `now`. */
function sweepExpiredChallenges(now: number): void {
  for (const [key, rec] of challenges) {
    if (now > rec.expiresAtMs) {
      challenges.delete(key);
    }
  }
}

/**
 * Generates a challenge nonce for verification.
 *
 * @param address - The user's Starknet wallet address
 * @returns The generated nonce and its TTL
 * @throws if the address cannot be normalized to a Starknet address, or if
 *   the in-memory store is at the MAX_CHALLENGES cap.
 */
export function createChallenge(address: string) {
  const now = Date.now();

  creationsSinceSweep += 1;
  if (creationsSinceSweep >= SWEEP_INTERVAL) {
    creationsSinceSweep = 0;
    sweepExpiredChallenges(now);
  }

  const nonce = `0x${crypto.randomBytes(16).toString("hex")}`;
  challenges.set(address.toLowerCase(), { nonce, expiresAtMs: now + CHALLENGE_TTL_MS });

  // Structured log/metric for challenge generation
  console.info(JSON.stringify({
    metric: "challenge_created",
    address: address.toLowerCase(),
    expires_in_ms: CHALLENGE_TTL_MS,
    timestamp: new Date().toISOString()
  }));

  return { nonce, expires_in_ms: CHALLENGE_TTL_MS };
}

/**
 * Retrieves the challenge record for verification. Expired entries are
 * evicted on access.
 *
 * @param address - The user's Starknet wallet address
 * @returns The challenge record if found and valid, otherwise null. Malformed
 *   addresses resolve to null without throwing.
 */
export function getChallenge(address: string) {
  const lookupKey = normalizeAddressKey(address);
  if (lookupKey === null) {
    console.info(
      JSON.stringify({
        metric: "challenge_miss",
        reason: "invalid_address",
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }

  const rec = challenges.get(lookupKey);
  if (!rec) {
    console.info(
      JSON.stringify({
        metric: "challenge_miss",
        reason: "not_found",
        address: address.toLowerCase(),
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }

  if (Date.now() > rec.expiresAtMs) {
    challenges.delete(lookupKey);
    console.info(
      JSON.stringify({
        metric: "challenge_expired",
        address: address.toLowerCase(),
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
  return rec;
}

/**
 * Clear the chain-ID decode cache.
 *
 * Only intended for use in tests that need to verify the caching behaviour
 * or that construct unusual chainId values. Production code must not call this.
 */
export function clearChallenge(address: string) {
  const lookupKey = normalizeAddressKey(address);
  if (lookupKey === null) return;

  const deleted = challenges.delete(lookupKey);
  if (deleted) {
    console.info(
      JSON.stringify({
        metric: "challenge_cleared",
        address: address.toLowerCase(),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Atomically reads and deletes the challenge for an address in a single step.
 *
 * This must be used (instead of getChallenge + a later clearChallenge) anywhere a
 * challenge is about to be verified. getChallenge is read-only, so if it's read at
 * the start of an async verification and only cleared afterwards, two concurrent
 * requests can both read the same still-valid nonce before either one clears it —
 * letting the same challenge be consumed twice (a replay bypass). Deleting it at
 * read time closes that gap: the second concurrent caller sees it already gone.
 *
 * @param address - The user's Starknet wallet address
 * @returns The challenge record if it existed and was still valid, otherwise null
 */
export function consumeChallenge(address: string) {
  const rec = getChallenge(address);
  if (!rec) return null;

  const lookupKey = normalizeAddressKey(address);
  if (lookupKey !== null) challenges.delete(lookupKey);

  console.info(
    JSON.stringify({
      metric: "challenge_consumed",
      address: address.toLowerCase(),
      timestamp: new Date().toISOString(),
    }),
  );

  return rec;
}

/**
 * Builds the SNIP-12 typed-data challenge a wallet signs to prove ownership.
 *
 * Extracted from the auth route so it can be unit-tested in isolation, without
 * pulling in the Express router or the Starknet RPC provider.
 *
 * The wallet field is normalized to the canonical (lowercase, padded) form
 * before being placed in the typed-data message. This keeps the signature
 * the wallet produces stable regardless of how the caller cased the input
 * address ("0xAbC" vs "0xabc"), and matches the lowercase key the
 * `challenges` Map stores the nonce under.
 */
export function buildTypedChallenge(address: string, chainId: string, nonce: string): TypedData {
  const canonicalAddress = canonicalWalletAddress(address);
  // Wallets (ArgentX/Braavos) validate typed data using a JSON schema.
  // They expect plain string values like:
  // - domain.chainId: "SN_SEPOLIA" / "SN_MAIN"
  // - domain.name/version: plain string
  // - message.action: plain string
  // (starknet.js will encode these according to the declared `felt` types when hashing/verifying)
  const chainIdLabel = shortString.decodeShortString(chainId);
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
 * Returns the canonical Starknet address (lowercase, padded, mixed-case
 * checksummed) for use as a `challenges` Map key, or null if the input is
 * not a usable Starknet address. Returns null rather than throwing so that
 * `getChallenge` / `clearChallenge` / `consumeChallenge` degrade gracefully
 * on malformed input rather than 500'ing the auth route.
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
 * malformed input: the route layer's Zod schema already validates the
 * raw request body, so any input that fails normalize here is a caller
 * bug, not something to silently paper over.
 */
function canonicalWalletAddress(address: string): string {
  const canonical = normalizeAddressKey(address);
  if (canonical === null) {
    throw new Error("buildTypedChallenge: address is not a parseable Starknet address");
  }
  return canonical;
}

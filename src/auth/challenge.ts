import crypto from "node:crypto";
import { shortString, type TypedData } from "starknet";
import { normalizeStarknetAddress } from "../utils/address.js";

/**
 * Nonce Challenge Generation, Expiration, and Validation Contract.
 *
 * This module manages short-lived cryptographic nonces used by Starknet wallets
 * to prove address ownership during authentication.
 *
 * AUTHORIZATION & LIFECYCLE CONTRACT:
 * 1. Address Keying & Canonicalization:
 *    - All stored challenges are keyed by canonical Starknet address (0x + 64 hex).
 *    - Address casing and leading-zero variations collapse to the same canonical key.
 *
 * 2. Input Validation & Fail-Closed Guarding:
 *    - All functions strictly validate inputs before executing state modifications.
 *    - Write paths (`createChallenge`, `buildTypedChallenge`) throw descriptive, non-sensitive errors
 *      when supplied with missing, non-string, whitespace, or malformed input.
 *    - Read/eviction paths (`getChallenge`, `clearChallenge`, `consumeChallenge`, `verifyChallenge`)
 *      degrade fail-closed, returning `null` / no-op and logging structured metric events (`invalid_address`).
 *
 * 3. Secure Random Nonce Generation & Entropy:
 *    - Nonces are 16-byte (128-bit) CSPRNG values generated using `crypto.randomBytes(16)`.
 *    - Formatted as `0x`-prefixed 32-character hexadecimal strings.
 *
 * 4. Expiration & Replay Defense:
 *    - `CHALLENGE_TTL_MS` is fixed at 5 minutes (300,000 ms).
 *    - Re-issuing an active challenge returns the SAME nonce with the remaining TTL without extending expiration.
 *    - `consumeChallenge` performs atomic read-and-delete to ensure a nonce can be used for verification exactly once.
 *    - `verifyChallenge` provides an idempotent, early fail-fast nonce check: for the same valid input
 *      it always returns the same result, allowing safe retry of verification flows.
 *    - Expired nonces cannot be validated, consumed, or replayed.
 *    - `restoreChallenge` may put a consumed nonce back only after a verified signature whose session
 *      issuance failed — never after a signature failure (replay stays closed).
 *
 * 5. Telemetry & Non-Sensitivity:
 *    - Emits structured JSON metrics via `console.info`.
 *    - Canonical keys are logged; raw malformed inputs and sensitive raw tokens are never exposed.
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
 * addresses would otherwise OOM the server.
 */
export const MAX_CHALLENGES = 100_000;

/** In-memory store mapping canonical address → ChallengeRecord */
export const challenges = new Map<string, ChallengeRecord>();

/** Number of `createChallenge` calls between opportunistic sweeps of expired entries. */
const SWEEP_INTERVAL = 50;
let creationsSinceSweep = 0;

/**
 * Max entries inspected per opportunistic sweep. Keeps each sweep O(page)
 * even when the store approaches `MAX_CHALLENGES`.
 */
export const SWEEP_BATCH_SIZE = 500;

/**
 * Snapshot of keys taken when the current pagination cycle started.
 * Kept stable across sweeps so entries added or deleted between invocations
 * never shift the resume position. `null` when no cycle is in progress.
 */
let sweepKeysSnapshot: string[] | null = null;

/** Index into `sweepKeysSnapshot` for the next paginated sweep pass. */
let sweepOffset = 0;

/** Memoized mapping from encoded chain-ID felt → human-readable label. */
const chainIdCache = new Map<string, string>();

/** Helper to validate non-empty string arguments */
function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

/** Decodes a Starknet chain-ID felt into a human-readable label (e.g. "SN_SEPOLIA"). */
function getChainIdLabel(chainId: string): string {
  const cached = chainIdCache.get(chainId);
  if (cached !== undefined) return cached;
  try {
    const label = shortString.decodeShortString(chainId);
    chainIdCache.set(chainId, label);
    return label;
  } catch {
    chainIdCache.set(chainId, chainId);
    return chainId;
  }
}

/**
 * Removes expired challenge entries.
 *
 * Opportunistic sweeps (`full === false`) inspect at most `SWEEP_BATCH_SIZE`
 * entries from the stable `sweepKeysSnapshot`, then advance `sweepOffset`.
 * Because the snapshot is captured once per cycle, entries added or deleted
 * between sweeps never shift the resume position. Last-resort sweeps
 * (`full === true`) walk the entire store and reset the cycle.
 */
function sweepExpiredChallenges(now: number, full = false): void {
  if (challenges.size === 0) {
    sweepKeysSnapshot = null;
    sweepOffset = 0;
    return;
  }

  if (full) {
    for (const [key, rec] of challenges) {
      if (now > rec.expiresAtMs) challenges.delete(key);
    }
    sweepKeysSnapshot = null;
    sweepOffset = 0;
    return;
  }

  // Start a new pagination cycle when there is no active snapshot.
  if (sweepKeysSnapshot === null) {
    sweepKeysSnapshot = [...challenges.keys()];
    sweepOffset = 0;
  }

  // If the cycle is complete, start a fresh one next time.
  if (sweepOffset >= sweepKeysSnapshot.length) {
    sweepKeysSnapshot = null;
    sweepOffset = 0;
    return;
  }

  const end = Math.min(sweepOffset + SWEEP_BATCH_SIZE, sweepKeysSnapshot.length);
  for (let i = sweepOffset; i < end; i++) {
    const key = sweepKeysSnapshot[i]!;
    const rec = challenges.get(key);
    if (rec && now > rec.expiresAtMs) challenges.delete(key);
  }

  sweepOffset = end;
  if (sweepOffset >= sweepKeysSnapshot.length) {
    // This cycle is done — next sweep will start fresh.
    sweepKeysSnapshot = null;
    sweepOffset = 0;
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
 * Returns the canonical Starknet address (lowercase, `0x` + 64 hex) for use
 * as a `challenges` Map key, or null if the input is not a usable Starknet address.
 */
function normalizeAddressKey(address: unknown): string | null {
  if (!isNonEmptyString(address)) return null;
  try {
    return normalizeStarknetAddress(address);
  } catch {
    return null;
  }
}

/**
 * Issues (or re-issues) the challenge nonce a wallet must sign.
 *
 * IDEMPOTENT WITHIN THE ACTIVE WINDOW: if the address already has an
 * unexpired challenge, the existing nonce is returned with its REMAINING
 * TTL and a `challenge_replayed` metric.
 *
 * @param address - The user's Starknet wallet address
 * @returns The nonce and the milliseconds remaining before it expires
 * @throws if the address is invalid, or if a new entry would exceed `MAX_CHALLENGES`.
 */
export function createChallenge(address: unknown): { nonce: string; expires_in_ms: number } {
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
    sweepExpiredChallenges(now, true);
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
 * Retrieves the challenge record for verification. Expired entries are evicted on access.
 * Read-only: prefer {@link consumeChallenge} anywhere a challenge is about to be verified.
 *
 * @param address - The user's Starknet wallet address
 * @returns The challenge record if found and still valid, otherwise null.
 */
export function getChallenge(address: unknown): ChallengeRecord | null {
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
 * A silent no-op when the address is malformed or has no stored challenge.
 */
export function clearChallenge(address: unknown): void {
  const key = normalizeAddressKey(address);
  if (key === null) return;

  if (challenges.delete(key)) {
    logChallengeMetric("challenge_cleared", { address: key });
  }
}

/**
 * Atomically reads and deletes the challenge for an address in a single step.
 * Prevents replay attacks where concurrent verifications race on the same nonce.
 *
 * @param address - The user's Starknet wallet address
 * @returns The challenge record if it existed and was still valid, else null
 */
export function consumeChallenge(address: unknown): ChallengeRecord | null {
  const rec = getChallenge(address);
  if (!rec) return null;

  const key = normalizeAddressKey(address);
  if (key !== null) challenges.delete(key);

  logChallengeMetric("challenge_consumed", { address: key });
  return rec;
}

/**
 * Puts a previously consumed challenge back into the store so a caller can
 * retry verification without re-signing.
 *
 * Used by `/auth/verify` when signature verification succeeded but session
 * issuance failed — the caller already proved ownership of the nonce, so
 * consuming it permanently would strand a valid proof behind a transient
 * store error.
 *
 * Restores only when:
 * - `address` is a parseable Starknet address,
 * - the record is still within its TTL, and
 * - the address slot is empty (never overwrite a newer challenge).
 *
 * @returns `true` when the record was restored, otherwise `false`.
 */
export function restoreChallenge(address: unknown, record: ChallengeRecord): boolean {
  const key = normalizeAddressKey(address);
  if (key === null) return false;
  if (Date.now() > record.expiresAtMs) return false;
  if (challenges.has(key)) return false;

  challenges.set(key, { nonce: record.nonce, expiresAtMs: record.expiresAtMs });
  logChallengeMetric("challenge_restored", {
    address: key,
    expires_in_ms: record.expiresAtMs - Date.now(),
  });
  return true;
}

/**
 * Validates a nonce against the challenge store without consuming it.
 *
 * IDEMPOTENT: for the same valid input (`address`, `nonce`) the function
 * returns the same result until the challenge expires or is consumed.
 * Calling `verifyChallenge` repeatedly with the same arguments is safe
 * and does not mutate the store (except lazy eviction of expired entries).
 *
 * This provides an early fail-fast check before building typed data
 * or proceeding with signature verification. A caller can verify the
 * nonce is still valid, build the typed data, and only then move to
 * signature verification — without worrying that the nonce was stale.
 *
 * @param address - The user's Starknet wallet address
 * @param nonce   - The nonce string to verify
 * @returns The challenge record if the nonce is valid and unexpired, otherwise null.
 */
export function verifyChallenge(address: unknown, nonce: unknown): ChallengeRecord | null {
  const key = normalizeAddressKey(address);
  if (key === null) {
    logChallengeMetric("challenge_verify_miss", { reason: "invalid_address" });
    return null;
  }

  if (!isNonEmptyString(nonce)) {
    logChallengeMetric("challenge_verify_miss", { reason: "invalid_nonce" });
    return null;
  }

  const rec = challenges.get(key);
  if (!rec) {
    logChallengeMetric("challenge_verify_miss", { reason: "not_found", address: key });
    return null;
  }

  if (rec.nonce !== nonce.trim()) {
    logChallengeMetric("challenge_verify_miss", { reason: "nonce_mismatch", address: key });
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
 * Builds the SNIP-12 typed-data challenge a wallet signs to prove ownership.
 *
 * @throws if any input is missing, invalid type, empty, or unparseable address.
 */
export function buildTypedChallenge(address: unknown, chainId: unknown, nonce: unknown): TypedData {
  if (!isNonEmptyString(address) || normalizeAddressKey(address) === null) {
    throw new Error("buildTypedChallenge: address is not a parseable Starknet address");
  }
  if (!isNonEmptyString(chainId)) {
    throw new Error("buildTypedChallenge: chainId must be a non-empty string");
  }
  if (!isNonEmptyString(nonce)) {
    throw new Error("buildTypedChallenge: nonce must be a non-empty string");
  }

  const canonicalAddress = normalizeAddressKey(address)!;

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
      nonce: nonce.trim(),
    },
  };
}

/**
 * Resets the challenge store and the sweep counter.
 * Only intended for tests that need a clean slate between cases.
 */
export function clearChallengesForTesting(): void {
  challenges.clear();
  creationsSinceSweep = 0;
  sweepKeysSnapshot = null;
  sweepOffset = 0;
}

/**
 * Clears the chain-ID decode cache.
 * Only intended for tests that verify the caching behaviour.
 */
export function clearChainIdCacheForTesting(): void {
  chainIdCache.clear();
}

import crypto from "node:crypto";
import { env } from "../config.js";

type ChallengeRecord = {
  nonce: string;
  expiresAtMs: number;
};

type SessionRecord = {
  address: string;
  expiresAtMs: number;
};

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = env.SESSION_TTL_MS;
// How often the background sweeper purges expired, never-revisited sessions.
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const challenges = new Map<string, ChallengeRecord>();
const sessions = new Map<string, SessionRecord>();

export function createChallenge(address: string) {
  const nonce = `0x${crypto.randomBytes(16).toString("hex")}`;
  challenges.set(address.toLowerCase(), { nonce, expiresAtMs: Date.now() + CHALLENGE_TTL_MS });
  return { nonce, expires_in_ms: CHALLENGE_TTL_MS };
}

export function getChallenge(address: string) {
  const rec = challenges.get(address.toLowerCase());
  if (!rec) return null;
  if (Date.now() > rec.expiresAtMs) {
    challenges.delete(address.toLowerCase());
    return null;
  }
  return rec;
}

export function clearChallenge(address: string) {
  challenges.delete(address.toLowerCase());
}

export function createSession(address: string) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    address: address.toLowerCase(),
    expiresAtMs: Date.now() + SESSION_TTL_MS,
  });
  return { token, expires_in_ms: SESSION_TTL_MS };
}

export function requireSession(address: string, token: string) {
  const rec = sessions.get(token);
  if (!rec) return false;
  // Reject and lazily delete expired tokens so a leaked token stops working.
  if (Date.now() > rec.expiresAtMs) {
    sessions.delete(token);
    return false;
  }
  if (rec.address !== address.toLowerCase()) return false;
  // Sliding expiry: a token in active use is refreshed for another full TTL.
  rec.expiresAtMs = Date.now() + SESSION_TTL_MS;
  return true;
}

/**
 * Removes every session whose TTL has elapsed and returns the number purged.
 * Exposed so a host can run it periodically; expired tokens are also removed
 * lazily on access in `requireSession`.
 */
export function sweepExpiredSessions(now: number = Date.now()): number {
  let removed = 0;
  for (const [token, rec] of sessions) {
    if (now > rec.expiresAtMs) {
      sessions.delete(token);
      removed += 1;
    }
  }
  return removed;
}

// Periodically purge expired, never-revisited sessions so they cannot leak
// memory. Unref'd so it never keeps the process alive; skipped under test.
/* v8 ignore start */
if (env.NODE_ENV !== "test") {
  setInterval(() => sweepExpiredSessions(), SESSION_SWEEP_INTERVAL_MS).unref();
}
/* v8 ignore stop */

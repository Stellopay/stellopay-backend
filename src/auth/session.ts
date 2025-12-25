import crypto from "node:crypto";

type ChallengeRecord = {
  nonce: string;
  expiresAtMs: number;
};

type SessionRecord = {
  address: string;
};

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

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
  sessions.set(token, { address: address.toLowerCase() });
  return { token, expires_in_ms: null }; // null indicates no expiration
}

export function requireSession(address: string, token: string) {
  const rec = sessions.get(token);
  if (!rec) return false;
  // Sessions never expire - they persist until server restart or explicit deletion
  return rec.address === address.toLowerCase();
}



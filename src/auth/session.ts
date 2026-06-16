import crypto from "node:crypto";
import { db, schema } from "../db/index.js";
import { eq, and, gt, isNull } from "drizzle-orm";
import { env } from "../config.js";

type ChallengeRecord = {
  nonce: string;
  expiresAtMs: number;
};

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const challenges = new Map<string, ChallengeRecord>();

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

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(address: string) {
  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.SESSION_TTL_MS);
  await db.insert(schema.sessions).values({
    id: crypto.randomUUID(),
    tokenHash,
    address: address.toLowerCase(),
    expiresAt,
    lastSeen: now,
  });
  return { token, expires_in_ms: env.SESSION_TTL_MS };
}

export async function requireSession(address: string, token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const now = new Date();
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.tokenHash, tokenHash),
        eq(schema.sessions.address, address.toLowerCase()),
        gt(schema.sessions.expiresAt, now),
        isNull(schema.sessions.revokedAt),
      )
    )
    .limit(1);

  if (!rows[0]) return false;

  await db
    .update(schema.sessions)
    .set({ lastSeen: now })
    .where(eq(schema.sessions.tokenHash, tokenHash));

  return true;
}

export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.sessions.tokenHash, tokenHash));
}

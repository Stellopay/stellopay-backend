import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createChallenge,
  getChallenge,
  clearChallenge,
  createSession,
  requireSession,
  sweepExpiredSessions,
} from "./session";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

describe("challenges", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues an active challenge that is readable before the TTL", () => {
    const { nonce, expires_in_ms } = createChallenge("0xAbC");
    expect(nonce).toMatch(/^0x[0-9a-f]{32}$/);
    expect(expires_in_ms).toBe(CHALLENGE_TTL_MS);
    // lookup is case-insensitive
    expect(getChallenge("0xabc")?.nonce).toBe(nonce);
  });

  it("expires the challenge once the TTL elapses", () => {
    createChallenge("0xdead");
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    expect(getChallenge("0xdead")).toBeNull();
  });

  it("returns null after a challenge is cleared", () => {
    createChallenge("0xfeed");
    clearChallenge("0xfeed");
    expect(getChallenge("0xfeed")).toBeNull();
  });
});

describe("sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // clear any sessions left over from earlier tests (uses a far-future "now")
    sweepExpiredSessions(Number.MAX_SAFE_INTEGER);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates a token for its address (case-insensitive)", () => {
    const { token } = createSession("0xABCDEF");
    expect(requireSession("0xabcdef", token)).toBe(true);
  });

  it("rejects an unknown token", () => {
    expect(requireSession("0xabc", "not-a-real-token")).toBe(false);
  });

  it("rejects a valid token used with a different address", () => {
    const { token } = createSession("0xaaa");
    expect(requireSession("0xbbb", token)).toBe(false);
  });

  it("returns a real expires_in_ms instead of null", () => {
    const { expires_in_ms } = createSession("0x111");
    expect(expires_in_ms).toBeGreaterThan(0);
  });

  it("rejects and removes a session once its TTL elapses", () => {
    const { token, expires_in_ms } = createSession("0x222");
    vi.advanceTimersByTime(expires_in_ms + 1);
    expect(requireSession("0x222", token)).toBe(false);
    // the expired token was deleted, so it stays invalid
    expect(requireSession("0x222", token)).toBe(false);
  });

  it("keeps a token valid at the exact expiry boundary", () => {
    const { token, expires_in_ms } = createSession("0x444");
    // advance to exactly expiresAtMs: Date.now() equals expiry, so it is still valid
    vi.advanceTimersByTime(expires_in_ms);
    expect(requireSession("0x444", token)).toBe(true);
  });

  it("slides expiry forward each time a live session is used", () => {
    const { token, expires_in_ms } = createSession("0x333");
    vi.advanceTimersByTime(expires_in_ms - 1);
    expect(requireSession("0x333", token)).toBe(true); // refreshes for another TTL
    vi.advanceTimersByTime(expires_in_ms - 1);
    expect(requireSession("0x333", token)).toBe(true); // still alive past the original window
  });

  it("sweepExpiredSessions purges only expired entries and returns the count", () => {
    const a = createSession("0xa");
    createSession("0xb");
    vi.advanceTimersByTime(a.expires_in_ms + 1);
    const c = createSession("0xc");
    expect(sweepExpiredSessions()).toBe(2);
    expect(requireSession("0xc", c.token)).toBe(true);
  });
});

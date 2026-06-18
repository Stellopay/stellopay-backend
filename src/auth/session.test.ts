import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createChallenge,
  getChallenge,
  clearChallenge,
  createSession,
  requireSession,
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
});

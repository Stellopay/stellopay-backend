import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createChallenge,
  getChallenge,
  clearChallenge,
  createSession,
  requireSession,
} from "../auth/session.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createChallenge", () => {
  it("returns a hex nonce prefixed with 0x", () => {
    const { nonce } = createChallenge("0x1");
    expect(nonce).toMatch(/^0x[0-9a-f]+$/);
  });

  it("returns a non-zero expires_in_ms", () => {
    const { expires_in_ms } = createChallenge("0x1");
    expect(expires_in_ms).toBeGreaterThan(0);
  });
});

describe("getChallenge", () => {
  it("returns the challenge within TTL", () => {
    const { nonce } = createChallenge("0xABC");
    const rec = getChallenge("0xABC");
    expect(rec).not.toBeNull();
    expect(rec!.nonce).toBe(nonce);
  });

  it("is case-insensitive for address lookup", () => {
    createChallenge("0xABC");
    expect(getChallenge("0xabc")).not.toBeNull();
    expect(getChallenge("0xABC")).not.toBeNull();
  });

  it("returns null when challenge does not exist", () => {
    expect(getChallenge("0xnonexistent")).toBeNull();
  });

  it("returns null after TTL expires", () => {
    vi.useFakeTimers();
    createChallenge("0xexpired");
    vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes — past 5-minute TTL
    expect(getChallenge("0xexpired")).toBeNull();
  });
});

describe("clearChallenge", () => {
  it("removes an existing challenge", () => {
    createChallenge("0xclr");
    clearChallenge("0xclr");
    expect(getChallenge("0xclr")).toBeNull();
  });
});

describe("createSession / requireSession", () => {
  it("valid token with matching address returns true", () => {
    const { token } = createSession("0xWallet");
    expect(requireSession("0xWallet", token)).toBe(true);
  });

  it("address comparison is case-insensitive", () => {
    const { token } = createSession("0xUPPER");
    expect(requireSession("0xupper", token)).toBe(true);
  });

  it("unknown token returns false", () => {
    expect(requireSession("0xany", "deadbeefdeadbeef")).toBe(false);
  });

  it("wrong address for a valid token returns false", () => {
    const { token } = createSession("0xowner");
    expect(requireSession("0xattacker", token)).toBe(false);
  });
});

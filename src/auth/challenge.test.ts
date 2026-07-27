/**
 * @file challenge.test.ts
 * Tests for src/auth/challenge.ts — the nonce generation, expiry, and
 * typed-data contract documented in docs/auth/challenge.md.
 *
 * Every case here maps to a statement in that document. If a test needs
 * changing, the document needs changing in the same commit.
 *
 * `starknet` is mocked with a pass-through spread so the real
 * `decodeShortString` still runs but call counts can be asserted (the
 * chain-ID memoisation). Everything else in the module is real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  return {
    ...actual,
    shortString: {
      ...actual.shortString,
      decodeShortString: vi.fn(actual.shortString.decodeShortString),
    },
  };
});

import { shortString } from "starknet";
import {
  buildTypedChallenge,
  challenges,
  CHALLENGE_TTL_MS,
  clearChainIdCacheForTesting,
  clearChallenge,
  clearChallengesForTesting,
  consumeChallenge,
  createChallenge,
  getChallenge,
  MAX_CHALLENGES,
} from "./challenge.js";

// SN_SEPOLIA / SN_MAIN encoded as felt short strings, as the RPC returns them.
const CHAIN_ID_SEPOLIA = "0x534e5f5345504f4c4941";
const CHAIN_ID_MAIN = "0x534e5f4d41494e";

// A canonical (lowercase, 0x + 64 hex) Starknet address. Its canonical form
// is identical to the input, so assertions can compare exactly.
const ADDR_CANONICAL = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/** Canonical key for any address the helpers accept — 0x + 64 hex. */
function canonical(hexSuffix: string): string {
  return `0x${hexSuffix.replace(/^0x/, "").padStart(64, "0")}`;
}

let infoSpy: ReturnType<typeof vi.spyOn>;

/** Metric objects emitted during the current test, oldest first. */
function metrics(): Record<string, any>[] {
  return infoSpy.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line));
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, any> => entry !== null && "metric" in entry);
}

function metricNames(): string[] {
  return metrics().map((m) => m.metric);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  clearChallengesForTesting();
  clearChainIdCacheForTesting();
  vi.mocked(shortString.decodeShortString).mockClear();
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  infoSpy.mockRestore();
  clearChallengesForTesting();
  clearChainIdCacheForTesting();
});

// ---------------------------------------------------------------------------
// buildTypedChallenge — the payload the wallet actually signs
// ---------------------------------------------------------------------------

describe("buildTypedChallenge", () => {
  it("decodes the chainId felt back into its label", () => {
    const td = buildTypedChallenge("0x123", CHAIN_ID_SEPOLIA, "0xnonce");
    expect((td.domain as Record<string, unknown>).chainId).toBe("SN_SEPOLIA");
  });

  it("decodes the mainnet chainId felt back into its label", () => {
    const td = buildTypedChallenge("0x123", CHAIN_ID_MAIN, "0xnonce");
    expect((td.domain as Record<string, unknown>).chainId).toBe("SN_MAIN");
  });

  it("uses Challenge as the primaryType and embeds wallet, nonce and action", () => {
    const td = buildTypedChallenge(ADDR_CANONICAL, CHAIN_ID_SEPOLIA, "0xabc123");

    expect(td.primaryType).toBe("Challenge");
    const message = td.message as Record<string, unknown>;
    expect(message.wallet).toBe(ADDR_CANONICAL);
    expect(message.nonce).toBe("0xabc123");
    expect(message.action).toBe("LOGIN");
  });

  it("declares the SNIP-12 domain with name, version and revision", () => {
    const domain = buildTypedChallenge("0x1", CHAIN_ID_SEPOLIA, "0x2").domain as Record<
      string,
      unknown
    >;

    expect(domain.name).toBe("StelloPay");
    expect(domain.version).toBe("1");
    expect(domain.revision).toBe("1");
  });

  it("normalizes short and mixed-case input to the same canonical wallet field", () => {
    // The wallet must see the same bytes regardless of how the caller wrote
    // the address, otherwise its signature is computed over a different
    // payload than the one the backend recorded.
    const short = buildTypedChallenge("0xAABB", CHAIN_ID_SEPOLIA, "0xnonce");
    const padded = buildTypedChallenge(canonical("aabb"), CHAIN_ID_SEPOLIA, "0xnonce");

    expect((short.message as Record<string, unknown>).wallet).toBe(canonical("aabb"));
    expect((padded.message as Record<string, unknown>).wallet).toBe(canonical("aabb"));
  });

  it("memoises the chain-ID decode across calls", () => {
    buildTypedChallenge("0x1", CHAIN_ID_SEPOLIA, "0xnonce");
    buildTypedChallenge("0x2", CHAIN_ID_SEPOLIA, "0xnonce");
    buildTypedChallenge("0x3", CHAIN_ID_SEPOLIA, "0xnonce");

    expect(shortString.decodeShortString).toHaveBeenCalledTimes(1);
  });

  it("decodes each distinct chain ID exactly once", () => {
    buildTypedChallenge("0x1", CHAIN_ID_SEPOLIA, "0xnonce");
    buildTypedChallenge("0x1", CHAIN_ID_MAIN, "0xnonce");
    buildTypedChallenge("0x1", CHAIN_ID_SEPOLIA, "0xnonce");

    expect(shortString.decodeShortString).toHaveBeenCalledTimes(2);
  });

  it("throws on a malformed address rather than signing an unusable payload", () => {
    expect(() => buildTypedChallenge("not-a-real-address", CHAIN_ID_SEPOLIA, "0x1")).toThrow(
      /parseable Starknet address/,
    );
  });
});

// ---------------------------------------------------------------------------
// createChallenge — generation, idempotent re-issue, size cap
// ---------------------------------------------------------------------------

describe("createChallenge", () => {
  it("success path: issues a 16-byte nonce with the full TTL and logs it", () => {
    const { nonce, expires_in_ms } = createChallenge("0xabc");

    expect(nonce).toMatch(/^0x[0-9a-f]{32}$/);
    expect(expires_in_ms).toBe(CHALLENGE_TTL_MS);
    expect(getChallenge("0xabc")?.nonce).toBe(nonce);

    // The logged address is the canonical key, so log lines for `0xabc`,
    // `0xABC` and the padded form all correlate to one login attempt.
    expect(metrics()[0]).toMatchObject({
      metric: "challenge_created",
      address: canonical("abc"),
      expires_in_ms: CHALLENGE_TTL_MS,
    });
    expect(metrics()[0].timestamp).toEqual(expect.any(String));
  });

  it("keys the store by canonical address, collapsing casing and padding", () => {
    const first = createChallenge("0xaabb");
    const second = createChallenge("0xAABB");
    const third = createChallenge(canonical("aabb"));

    expect(second.nonce).toBe(first.nonce);
    expect(third.nonce).toBe(first.nonce);
    expect(challenges.size).toBe(1);
    expect(challenges.has(canonical("aabb"))).toBe(true);
  });

  it("returns the same nonce on a retry inside the active window", () => {
    const first = createChallenge("0xbaba");
    infoSpy.mockClear();

    const second = createChallenge("0xbaba");

    expect(second.nonce).toBe(first.nonce);
    expect(challenges.size).toBe(1);
    expect(metricNames()).toEqual(["challenge_replayed"]);
  });

  it("reports the REMAINING TTL on replay — a retry never extends the window", () => {
    const first = createChallenge("0xcafe");
    vi.advanceTimersByTime(30_000);
    infoSpy.mockClear();

    const second = createChallenge("0xcafe");

    expect(second.nonce).toBe(first.nonce);
    expect(second.expires_in_ms).toBe(CHALLENGE_TTL_MS - 30_000);
    expect(metrics()[0]).toMatchObject({
      metric: "challenge_replayed",
      expires_in_ms: CHALLENGE_TTL_MS - 30_000,
    });
  });

  it("boundary path: the exact expiry instant still replays, one ms later re-issues", () => {
    const first = createChallenge("0xbb00");

    vi.advanceTimersByTime(CHALLENGE_TTL_MS);
    const atBoundary = createChallenge("0xbb00");
    expect(atBoundary.nonce).toBe(first.nonce);
    expect(atBoundary.expires_in_ms).toBe(0);

    vi.advanceTimersByTime(1);
    const afterBoundary = createChallenge("0xbb00");
    expect(afterBoundary.nonce).not.toBe(first.nonce);
    expect(afterBoundary.expires_in_ms).toBe(CHALLENGE_TTL_MS);
  });

  it("issues a fresh nonce once the previous challenge has expired", () => {
    const first = createChallenge("0xdec0de");
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    infoSpy.mockClear();

    const second = createChallenge("0xdec0de");

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.expires_in_ms).toBe(CHALLENGE_TTL_MS);
    expect(metricNames()).toEqual(["challenge_created"]);
  });

  it("frees the slot after a consume, so the next create issues a fresh nonce", () => {
    const first = createChallenge("0xc0ffee");
    consumeChallenge("0xc0ffee");
    infoSpy.mockClear();

    const second = createChallenge("0xc0ffee");

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.expires_in_ms).toBe(CHALLENGE_TTL_MS);
    expect(metricNames()).toEqual(["challenge_created"]);
  });

  it("treats different addresses as independent challenges", () => {
    const alice = createChallenge("0xa11ce");
    const bob = createChallenge("0xb0b");

    expect(alice.nonce).not.toBe(bob.nonce);
    expect(challenges.size).toBe(2);

    clearChallenge("0xb0b");
    expect(getChallenge("0xa11ce")?.nonce).toBe(alice.nonce);
  });

  it("failure path: throws on a malformed address without storing anything", () => {
    expect(() => createChallenge("not-a-real-address")).toThrow(/parseable Starknet address/);
    expect(challenges.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Size cap (DoS hardening)
// ---------------------------------------------------------------------------

describe("challenge store size cap", () => {
  // Outside the key range fillStore() writes (0x0 … 0x1869f), so the fill
  // never overwrites the entry under test.
  const FRESH = "0xfffff";

  /** Fills the store to the cap with entries expiring at `now + ttlOffset`. */
  function fillStore(ttlOffset = CHALLENGE_TTL_MS): void {
    for (let i = 0; i < MAX_CHALLENGES; i++) {
      challenges.set(canonical(i.toString(16)), {
        nonce: `0x${i.toString(16).padStart(32, "0")}`,
        expiresAtMs: Date.now() + ttlOffset,
      });
    }
  }

  it("boundary path: refuses a new entry once the store holds MAX_CHALLENGES live entries", () => {
    fillStore();
    expect(challenges.size).toBe(MAX_CHALLENGES);
    infoSpy.mockClear();

    expect(() => createChallenge(FRESH)).toThrow(/store is full/);
    expect(metrics()[0]).toMatchObject({ metric: "challenge_rejected", reason: "store_full" });
  });

  it("still replays an existing challenge when the store is full", () => {
    // A full store must not lock out an address that already holds a slot —
    // that would break an in-flight login for an unrelated reason.
    const { nonce } = createChallenge(FRESH);
    fillStore();

    expect(createChallenge(FRESH).nonce).toBe(nonce);
  });

  it("reclaims expired entries before refusing, so a full-but-stale store still works", () => {
    fillStore();
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);

    expect(() => createChallenge(FRESH)).not.toThrow();
    expect(challenges.size).toBe(1);
  });

  it("resumes issuing once the store is drained", () => {
    fillStore();
    expect(() => createChallenge(FRESH)).toThrow(/store is full/);

    clearChallengesForTesting();

    expect(() => createChallenge(FRESH)).not.toThrow();
    expect(challenges.size).toBe(1);
  });

  it("keeps MAX_CHALLENGES large enough to bound memory without throttling real traffic", () => {
    expect(MAX_CHALLENGES).toBeGreaterThanOrEqual(10_000);
  });
});

// ---------------------------------------------------------------------------
// Expired-entry sweep on the write path
// ---------------------------------------------------------------------------

describe("expired-challenge sweep", () => {
  /** Crosses the sweep interval with traffic for unrelated addresses. */
  function generateUnrelatedTraffic(count = 50): void {
    for (let i = 0; i < count; i++) {
      createChallenge(canonical((0x100000 + i).toString(16)));
    }
  }

  it("success path: a valid entry survives a sweep triggered by unrelated traffic", () => {
    createChallenge("0xdddd");
    generateUnrelatedTraffic();

    expect(challenges.has(canonical("dddd"))).toBe(true);
    expect(getChallenge("0xdddd")).not.toBeNull();
  });

  it("boundary path: evicts an expired challenge that was never read", () => {
    createChallenge("0xabba");
    expect(challenges.has(canonical("abba"))).toBe(true);

    // Expire it without ever calling getChallenge/consumeChallenge, so
    // lazy eviction-on-read never fires for this entry.
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    generateUnrelatedTraffic();

    expect(challenges.has(canonical("abba"))).toBe(false);
  });

  it("boundary path: the sweep only removes entries past their TTL", () => {
    createChallenge("0xeeee");
    vi.advanceTimersByTime(CHALLENGE_TTL_MS - 1);
    generateUnrelatedTraffic();

    expect(challenges.has(canonical("eeee"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getChallenge / clearChallenge / consumeChallenge
// ---------------------------------------------------------------------------

describe("getChallenge", () => {
  it("success path: returns the stored record without emitting a metric", () => {
    const { nonce } = createChallenge("0xabcd");
    infoSpy.mockClear();

    expect(getChallenge("0xabcd")).toEqual({
      nonce,
      expiresAtMs: CHALLENGE_TTL_MS,
    });
    expect(metricNames()).toEqual([]);
  });

  it("boundary path: valid at the exact expiry instant, expired one ms later", () => {
    createChallenge("0xabcd");

    vi.advanceTimersByTime(CHALLENGE_TTL_MS);
    expect(getChallenge("0xabcd")).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(getChallenge("0xabcd")).toBeNull();
  });

  it("evicts and reports an expired challenge", () => {
    createChallenge("0xdead");
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    infoSpy.mockClear();

    expect(getChallenge("0xdead")).toBeNull();
    expect(metrics()[0]).toMatchObject({ metric: "challenge_expired", address: canonical("dead") });
    expect(challenges.has(canonical("dead"))).toBe(false);
  });

  it("reports a not_found miss for a valid address with no challenge", () => {
    expect(getChallenge("0xbeef")).toBeNull();
    expect(metrics()[0]).toMatchObject({ metric: "challenge_miss", reason: "not_found" });
  });

  it("reports an invalid_address miss without echoing the malformed input", () => {
    expect(getChallenge("not-a-real-address")).toBeNull();
    expect(metrics()[0]).toMatchObject({ metric: "challenge_miss", reason: "invalid_address" });
    expect(metrics()[0].address).toBeUndefined();
  });

  it("resolves an address written differently to the one it was created with", () => {
    const { nonce } = createChallenge("0xAABB");
    expect(getChallenge(canonical("aabb"))?.nonce).toBe(nonce);
    expect(getChallenge("0xaabb")?.nonce).toBe(nonce);
  });
});

describe("clearChallenge", () => {
  it("removes the challenge and reports it", () => {
    createChallenge("0xfeed");
    infoSpy.mockClear();

    clearChallenge("0xfeed");

    expect(metrics()[0]).toMatchObject({ metric: "challenge_cleared", address: canonical("feed") });
    expect(getChallenge("0xfeed")).toBeNull();
  });

  it("is a silent no-op for a malformed address", () => {
    expect(() => clearChallenge("not-a-real-address")).not.toThrow();
    expect(metricNames()).toEqual([]);
  });

  it("is a silent no-op when there is nothing stored", () => {
    clearChallenge("0xbeef");
    expect(metricNames()).toEqual([]);
  });
});

describe("consumeChallenge", () => {
  it("success path: returns the record exactly once, then null on reuse", () => {
    const { nonce } = createChallenge("0xc0ffee");
    infoSpy.mockClear();

    expect(consumeChallenge("0xc0ffee")?.nonce).toBe(nonce);
    expect(metricNames()).toEqual(["challenge_consumed"]);

    infoSpy.mockClear();
    expect(consumeChallenge("0xc0ffee")).toBeNull();
    expect(metrics()[0]).toMatchObject({ metric: "challenge_miss", reason: "not_found" });
  });

  it("boundary path: deletes before any caller can read it again (closes the replay race)", () => {
    createChallenge("0xface");

    // Simulates two concurrent /auth/verify requests racing on the same
    // nonce: only the first may ever see a non-null record.
    const first = consumeChallenge("0xface");
    const second = consumeChallenge("0xface");

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(getChallenge("0xface")).toBeNull();
  });

  it("boundary path: refuses an expired challenge instead of returning it", () => {
    createChallenge("0xdeadbeef");
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    infoSpy.mockClear();

    expect(consumeChallenge("0xdeadbeef")).toBeNull();
    expect(metricNames()).toEqual(["challenge_expired"]);
  });

  it("failure path: returns null for a malformed address without throwing", () => {
    // The route layer already validates request shape, but a direct caller
    // must get a clean "no challenge" answer rather than a TypeError.
    expect(consumeChallenge("not-a-real-address")).toBeNull();
    expect(metrics()[0]).toMatchObject({ metric: "challenge_miss", reason: "invalid_address" });
  });

  it("consumes the challenge regardless of how the address is written", () => {
    const { nonce } = createChallenge("0xAABB");
    expect(consumeChallenge(canonical("aabb"))?.nonce).toBe(nonce);
    expect(challenges.size).toBe(0);
  });
});

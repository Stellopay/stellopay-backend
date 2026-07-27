import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import {
  AUTHORIZATION_HEADER,
  BEARER_PREFIX,
  FORBIDDEN_BODY,
  FORBIDDEN_STATUS,
  getPrincipal,
  isAdminPrincipal,
  PRINCIPAL_HEADER,
  requireAdmin,
  requireAuth,
  requirePrincipal,
  UNAUTHORIZED_BODY,
  UNAUTHORIZED_STATUS,
} from "./middleware.js";
import { requireSession } from "./session.js";
import { env } from "../config.js";

// Mock the session module so the real DB is never touched.
vi.mock("./session.js", () => ({
  requireSession: vi.fn(),
}));

describe("Auth Middleware", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      headers: {},
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      locals: {},
    };

    mockNext = vi.fn();
  });

  describe("requireAuth", () => {
    it("is idempotent: second call skips session re-validation", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer valid_token",
      };
      vi.mocked(requireSession).mockResolvedValue(true);

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);

      mockNext = vi.fn();
      vi.mocked(requireSession).mockClear();

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);
      expect(requireSession).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it("is idempotent: second call preserves original req.auth even with different headers", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer valid_token",
      };
      vi.mocked(requireSession).mockResolvedValue(true);

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);
      expect(mockReq.auth).toEqual({ address: "0xuser", token: "valid_token" });

      mockNext = vi.fn();
      vi.mocked(requireSession).mockClear();
      mockReq.headers = {
        "x-user-address": "0xattacker",
        authorization: "Bearer stolen_token",
      };

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);
      expect(requireSession).not.toHaveBeenCalled();
      expect(mockReq.auth).toEqual({ address: "0xuser", token: "valid_token" });
    });

    it("returns 401 if the x-user-address header is missing", async () => {
      mockReq.headers = { authorization: "Bearer valid_token" };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(requireSession).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 if the authorization header is missing", async () => {
      mockReq.headers = { "x-user-address": "0xuser" };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(requireSession).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 if authorization is a multi-value array (boundary)", async () => {
      // Node http can deliver multi-value headers as an array. The Http
      // parser should never let .startsWith() execute on that array.
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: ["Bearer first", "Bearer second"] as unknown as string,
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(requireSession).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 if authorization is not Bearer", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Basic some_token",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(requireSession).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 if the trimmed token is empty (Bearer-plus-whitespace only)", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer    ",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(requireSession).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 if the trimmed address header is empty", async () => {
      mockReq.headers = {
        "x-user-address": "   ",
        authorization: "Bearer valid_token",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(requireSession).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 if the session is invalid", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer invalid_token",
      };
      vi.mocked(requireSession).mockResolvedValue(false);

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(requireSession).toHaveBeenCalledWith("0xuser", "invalid_token");
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 if the session lookup throws (treats throws as failed auth)", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer valid_token",
      };
      vi.mocked(requireSession).mockRejectedValue(new Error("db down"));

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("attaches the lowercased address and raw token to req.auth and calls next on success", async () => {
      mockReq.headers = {
        "x-user-address": "0xUSER", // Test case-insensitivity normalization
        authorization: "Bearer valid_token",
      };
      vi.mocked(requireSession).mockResolvedValue(true);

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      // requireSession sees the raw header value (existing behavior: the
      // DB lookup does its own lowercasing). The contract is that
      // req.auth.address stores the raw lowercased header, not the
      // canonical 0x+64-hex form.
      expect(requireSession).toHaveBeenCalledWith("0xUSER", "valid_token");
      expect(mockReq.auth).toEqual({ address: "0xuser", token: "valid_token" });
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe("requireAdmin", () => {
    const originalAdminAddresses = env.ADMIN_ADDRESSES;

    // Test addresses use valid hex characters only — normalizeStarknetAddress
    // (which both sides of the admin comparison now flow through) rejects
    // anything outside [0-9a-f]. The old substring-based compare silently
    // accepted "0xadmin1" even though `m` and `n` are not hex characters.
    beforeEach(() => {
      env.ADMIN_ADDRESSES = ["0xabc1", "0xabc2"];
    });

    afterEach(() => {
      env.ADMIN_ADDRESSES = originalAdminAddresses;
    });

    it("returns 401 if req.auth is missing (never authenticated)", () => {
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 if req.auth is present but the address is empty", () => {
      mockReq.auth = { address: "", token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 403 if the principal is authenticated but not in the admin allowlist", () => {
      // Note: this was 401 { error: "Unauthorized" } before. The 401/403
      // split is intentional — 401 here would tell the caller to log in,
      // which they already did.
      mockReq.auth = { address: "0xdef1", token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Forbidden" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 200 by calling next when the user is in the admin allowlist", () => {
      mockReq.auth = { address: "0xabc1", token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalledWith(403);
    });

    it("returns 200 when the user address differs from the allowlist only by casing", () => {
      // Allowlist is `["0xabc1", "0xabc2"]` (set in beforeEach).
      // `0xABC2` is all-uppercase hex so it has no checksum info — the
      // canonical compare accepts it as the same address as `0xabc2`.
      mockReq.auth = { address: "0xABC2", token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("matches admin entries that differ only by canonical padding", () => {
      // Admin allowlist uses the short form. req.auth.address uses the
      // full 64-hex form. Both numeric-equal versions must resolve to the
      // same canonical address.
      env.ADMIN_ADDRESSES = ["0x1"];
      mockReq.auth = {
        address: `0x${"0".repeat(63)}1`,
        token: "testtoken",
      };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("treats a malformed req.auth.address as 403 (not 500)", () => {
      mockReq.auth = { address: "not-a-real-address", token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Forbidden" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("ignores malformed entries in ADMIN_ADDRESSES (does not match and does not crash)", () => {
      // A typo in the env (e.g. an address pasted with a stray char) must
      // never accidentally grant access to a non-admin by skipping the
      // validator catastrophically.
      env.ADMIN_ADDRESSES = ["not-a-real-address"];
      mockReq.auth = {
        address: `0x${"0".repeat(63)}1`,
        token: "testtoken",
      };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Forbidden" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("skips a malformed admin entry but still matches when a valid entry is present", () => {
      // A *single* malformed entry must not poison the loop. The valid
      // entry on the right still matches.
      env.ADMIN_ADDRESSES = ["not-a-real-address", "0x1"];
      mockReq.auth = {
        address: `0x${"0".repeat(63)}1`,
        token: "testtoken",
      };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("is idempotent: second call skips re-authorization and does not re-check allowlist", () => {
      mockReq.auth = { address: "0xabc1", token: "testtoken" };

      requireAdmin(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);

      mockNext = vi.fn();
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockRes.status).not.toHaveBeenCalledWith(403);
    });

    it("is idempotent: second call skips even if allowlist changes between calls", () => {
      mockReq.auth = { address: "0xabc1", token: "testtoken" };

      requireAdmin(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);

      mockNext = vi.fn();
      env.ADMIN_ADDRESSES = ["0xdef1"];
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockRes.status).not.toHaveBeenCalledWith(403);
    });
  });

  // -------------------------------------------------------------------------
  // Exported constants
  //
  // These are the compatibility anchors: route handlers and API clients assert
  // against them instead of re-typing the literals, so a change to any of them
  // is a change to the module's public contract and must be deliberate.
  // -------------------------------------------------------------------------

  describe("exported contract constants", () => {
    it("pins the header names the middleware reads", () => {
      expect(PRINCIPAL_HEADER).toBe("x-user-address");
      expect(AUTHORIZATION_HEADER).toBe("authorization");
      expect(BEARER_PREFIX).toBe("Bearer ");
    });

    it("pins the two denial statuses and bodies", () => {
      expect(UNAUTHORIZED_STATUS).toBe(401);
      expect(FORBIDDEN_STATUS).toBe(403);
      expect(UNAUTHORIZED_BODY).toEqual({ error: "Unauthorized" });
      expect(FORBIDDEN_BODY).toEqual({ error: "Forbidden" });
    });

    it("freezes the denial bodies so a caller cannot mutate the shared literal", () => {
      expect(Object.isFrozen(UNAUTHORIZED_BODY)).toBe(true);
      expect(Object.isFrozen(FORBIDDEN_BODY)).toBe(true);
    });

    it("sends a fresh copy per response, not the frozen constant itself", async () => {
      // Express serialises whatever object it is handed; sending the frozen
      // constant would let any middleware that post-processes the body throw
      // on a frozen target.
      mockReq.headers = {};
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      const sent = vi.mocked(mockRes.json!).mock.calls[0][0];
      expect(sent).toEqual(UNAUTHORIZED_BODY);
      expect(sent).not.toBe(UNAUTHORIZED_BODY);
      expect(Object.isFrozen(sent)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Principal accessors
  // -------------------------------------------------------------------------

  describe("getPrincipal", () => {
    it("returns null when the request never went through requireAuth", () => {
      expect(getPrincipal(mockReq as Request)).toBeNull();
    });

    it("returns null when req.auth is present but the address is empty", () => {
      mockReq.auth = { address: "", token: "testtoken" };
      expect(getPrincipal(mockReq as Request)).toBeNull();
    });

    it("returns the principal object bound by requireAuth", async () => {
      mockReq.headers = {
        "x-user-address": "0xUSER",
        authorization: "Bearer valid_token",
      };
      vi.mocked(requireSession).mockResolvedValue(true);
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      // Same object as req.auth — the accessor is a read, not a copy, so a
      // caller cannot end up reasoning about a stale snapshot.
      expect(getPrincipal(mockReq as Request)).toBe(mockReq.auth);
      expect(getPrincipal(mockReq as Request)).toEqual({
        address: "0xuser",
        token: "valid_token",
      });
    });
  });

  describe("requirePrincipal", () => {
    it("returns the principal when one is present", () => {
      mockReq.auth = { address: "0xabc1", token: "testtoken" };
      expect(requirePrincipal(mockReq as Request)).toBe(mockReq.auth);
    });

    it("throws a wiring-mistake error when no principal is bound", () => {
      // A route reaching here without requireAuth is a server bug, so this
      // must surface as a 5xx rather than being papered over as a 401.
      expect(() => requirePrincipal(mockReq as Request)).toThrow(/requireAuth/);
    });
  });

  describe("isAdminPrincipal", () => {
    const originalAdminAddresses = env.ADMIN_ADDRESSES;

    beforeEach(() => {
      env.ADMIN_ADDRESSES = ["0xabc1", "0xabc2"];
    });

    afterEach(() => {
      env.ADMIN_ADDRESSES = originalAdminAddresses;
    });

    it("matches an allowlisted address", () => {
      expect(isAdminPrincipal("0xabc1")).toBe(true);
    });

    it("matches across casing and canonical padding", () => {
      expect(isAdminPrincipal("0xABC2")).toBe(true);
      expect(isAdminPrincipal(`0x${"0".repeat(60)}abc1`)).toBe(true);
    });

    it("does not match an authenticated non-admin", () => {
      expect(isAdminPrincipal("0xdef1")).toBe(false);
    });

    it("returns false for a malformed principal instead of throwing", () => {
      expect(isAdminPrincipal("not-a-real-address")).toBe(false);
    });

    it("returns false — never true — when every allowlist entry is malformed", () => {
      env.ADMIN_ADDRESSES = ["not-a-real-address"];
      expect(isAdminPrincipal("0xabc1")).toBe(false);
    });

    it("skips a malformed allowlist entry and still matches a valid one", () => {
      env.ADMIN_ADDRESSES = ["not-a-real-address", "0xabc1"];
      expect(isAdminPrincipal("0xabc1")).toBe(true);
    });

    it("returns false for an empty allowlist", () => {
      env.ADMIN_ADDRESSES = [];
      expect(isAdminPrincipal("0xabc1")).toBe(false);
    });

    it("agrees with requireAdmin for the same principal", () => {
      // The two must never disagree: requireAdmin delegates to this function,
      // and this test fails if that delegation is ever unwound.
      mockReq.auth = { address: "0xabc1", token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(isAdminPrincipal("0xabc1")).toBe(true);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Compatibility guarantees
  //
  // Each case pins a promise made in docs/auth/middleware.md that an existing
  // caller already depends on. Breaking one of these is a breaking change for
  // routes/auth.ts, routes/billing.ts, or the admin-gated routers.
  // -------------------------------------------------------------------------

  describe("compatibility guarantees", () => {
    const originalAdminAddresses = env.ADMIN_ADDRESSES;

    beforeEach(() => {
      vi.mocked(requireSession).mockResolvedValue(true);
    });

    afterEach(() => {
      env.ADMIN_ADDRESSES = originalAdminAddresses;
    });

    it("binds req.auth with exactly the address and token keys", async () => {
      mockReq.headers = {
        "x-user-address": "0xUSER",
        authorization: "Bearer valid_token",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      // An added key here would silently widen what routes can read, and a
      // removed one would break routes/auth.ts's logout/revoke handlers.
      expect(Object.keys(mockReq.auth!).sort()).toEqual(["address", "token"]);
    });

    it("stores the raw lowercased header, NOT the canonical 0x+64-hex form", async () => {
      // auth/session.ts does an exact 1:1 match against the lowercased value.
      // Canonicalising here would silently desync principal vs. session for
      // every already-issued session.
      mockReq.headers = {
        "x-user-address": "0x1",
        authorization: "Bearer valid_token",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.auth!.address).toBe("0x1");
      expect(mockReq.auth!.address).not.toBe(`0x${"0".repeat(63)}1`);
    });

    it("passes the trimmed-but-not-lowercased address to requireSession", async () => {
      // requireSession does its own normalization. Lowercasing before the
      // call would change which rows match for existing sessions.
      mockReq.headers = {
        "x-user-address": "  0xUSER  ",
        authorization: "Bearer  valid_token  ",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(requireSession).toHaveBeenCalledWith("0xUSER", "valid_token");
    });

    it("preserves the bearer token verbatim, without case folding", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer MiXeDcAsE-Token",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      // routes/auth.ts feeds this straight to revokeSession, which hashes it.
      // Any normalization here would make every logout miss.
      expect(mockReq.auth!.token).toBe("MiXeDcAsE-Token");
    });

    it("leaves req.auth unset on every requireAuth failure path", async () => {
      const failures = [
        {},
        { authorization: "Bearer valid_token" },
        { "x-user-address": "0xuser" },
        { "x-user-address": "0xuser", authorization: "Basic token" },
        { "x-user-address": "0xuser", authorization: "Bearer    " },
      ];

      for (const headers of failures) {
        mockReq = { headers } as Partial<Request>;
        await requireAuth(mockReq as Request, mockRes as Response, mockNext);
        expect(mockReq.auth).toBeUndefined();
      }
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("answers every requireAuth failure with an identical body", async () => {
      const failures = [
        {},
        { authorization: "Bearer valid_token" },
        { "x-user-address": "0xuser", authorization: "Basic token" },
      ];

      for (const headers of failures) {
        mockReq = { headers } as Partial<Request>;
        await requireAuth(mockReq as Request, mockRes as Response, mockNext);
      }

      // No reason code, no varying shape — the response must not be usable
      // to probe which header was wrong or whether a session exists.
      const bodies = vi.mocked(mockRes.json!).mock.calls.map(([body]) => body);
      expect(bodies).toHaveLength(3);
      for (const body of bodies) {
        expect(body).toEqual({ error: "Unauthorized" });
      }
    });

    it("keeps requireAdmin's 401/403 split: unauthenticated is never 403", () => {
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(UNAUTHORIZED_STATUS);
      expect(mockRes.status).not.toHaveBeenCalledWith(FORBIDDEN_STATUS);
    });

    it("keeps requireAdmin's 401/403 split: authenticated non-admin is never 401", () => {
      env.ADMIN_ADDRESSES = ["0xabc1"];
      mockReq.auth = { address: "0xdef1", token: "testtoken" };

      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      // 401 here would tell the caller to log in, which they already did —
      // a client could then retry credentials forever.
      expect(mockRes.status).toHaveBeenCalledWith(FORBIDDEN_STATUS);
      expect(mockRes.status).not.toHaveBeenCalledWith(UNAUTHORIZED_STATUS);
    });

    it("does not touch the response when requireAdmin allows the request", () => {
      env.ADMIN_ADDRESSES = ["0xabc1"];
      mockReq.auth = { address: "0xabc1", token: "testtoken" };

      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockRes.json).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it("leaves the principal untouched across requireAdmin", () => {
      env.ADMIN_ADDRESSES = ["0xabc1"];
      mockReq.auth = { address: "0xabc1", token: "testtoken" };

      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      // requireAdmin is a pure gate: it must not canonicalise, annotate, or
      // otherwise rewrite what requireAuth bound.
      expect(mockReq.auth).toEqual({ address: "0xabc1", token: "testtoken" });
    });

    it("calls next() exactly once on the requireAuth success path", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer valid_token",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(mockNext).toHaveBeenCalledWith();
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });
});

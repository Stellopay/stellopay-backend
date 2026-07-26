import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { requireAuth, requireAdmin } from "./middleware.js";
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
    };

    mockNext = vi.fn();
  });

  describe("requireAuth", () => {
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
  });
});

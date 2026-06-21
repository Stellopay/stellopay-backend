import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { requireAuth, requireAdmin } from "./middleware.js";
import { requireSession } from "./session.js";
import { env } from "../config.js";

// Mock the session module
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
    it("should return 401 if x-user-address header is missing", () => {
      mockReq.headers = { authorization: "Bearer valid_token" };
      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 if authorization header is missing", () => {
      mockReq.headers = { "x-user-address": "0xuser" };
      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 if authorization header is not Bearer", () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Basic some_token",
      };
      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 if session is invalid", () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer invalid_token",
      };
      vi.mocked(requireSession).mockReturnValue(false);

      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(requireSession).toHaveBeenCalledWith("0xuser", "invalid_token");
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should attach address to req.auth and call next if session is valid", () => {
      mockReq.headers = {
        "x-user-address": "0xUSER", // Test case insensitivity normalization
        authorization: "Bearer valid_token",
      };
      vi.mocked(requireSession).mockReturnValue(true);

      requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(requireSession).toHaveBeenCalledWith("0xUSER", "valid_token");
      expect(mockReq.auth).toEqual({ address: "0xuser" });
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe("requireAdmin", () => {
    // Save original env
    const originalAdminAddresses = env.ADMIN_ADDRESSES;

    beforeEach(() => {
      env.ADMIN_ADDRESSES = ["0xadmin1", "0xadmin2"];
    });

    afterEach(() => {
      env.ADMIN_ADDRESSES = originalAdminAddresses;
    });

    it("should return 401 if req.auth is missing", () => {
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 if user is not in admin allowlist", () => {
      mockReq.auth = { address: "0xuser" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should call next if user is in admin allowlist", () => {
      mockReq.auth = { address: "0xadmin1" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should call next if user is in admin allowlist regardless of casing", () => {
      mockReq.auth = { address: "0xADMIN2" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });
});

import { Request, Response, NextFunction } from "express";
import { requireSession } from "./session.js";
import { env } from "../config.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        address: string;
      };
    }
  }
}

/**
 * Middleware that enforces a valid session for the request.
 * Expects:
 * - \`x-user-address\` header containing the user's Starknet address.
 * - \`Authorization\` header containing a Bearer token (the session token).
 *
 * If valid, attaches \`req.auth = { address }\` and proceeds.
 * Otherwise, returns a 401 Unauthorized JSON response without leaking session state.
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const addressHeader = req.headers["x-user-address"];
    const authHeader = req.headers["authorization"];

    if (!addressHeader || typeof addressHeader !== "string") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = authHeader.substring(7).trim();
    const address = addressHeader.trim();

    const isValid = requireSession(address, token);
    if (!isValid) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    req.auth = { address: address.toLowerCase() };
    next();
  } catch (error) {
    res.status(401).json({ error: "Unauthorized" });
  }
};

/**
 * Middleware that enforces admin-level access for the request.
 * Must be used AFTER \`requireAuth\`.
 *
 * Checks if \`req.auth.address\` is present in the \`ADMIN_ADDRESSES\` env configuration.
 * If valid, proceeds.
 * Otherwise, returns a 401 Unauthorized JSON response without leaking admin list or status.
 */
export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.auth || !req.auth.address) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const userAddress = req.auth.address.toLowerCase();

  if (!env.ADMIN_ADDRESSES.includes(userAddress)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
};

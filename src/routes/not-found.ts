import { Request, Response } from "express";

/**
 * Return the standard API envelope for unmatched /api/v1 routes.
 *
 * Mount this after every /api/v1 router and before the central error handler.
 * Express serializes the requested method/path as JSON, so user-controlled
 * paths are never rendered as HTML.
 */
export function apiV1NotFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: "Route not found",
    data: {
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
    },
  });
}

import { Request, Response } from "express";

/**
 * Standard 404 JSON envelope shape used by every router in this service.
 *
 * Route-level (in-handler) 404s emit:
 *
 * ```json
 * { "success": false, "error": "<message>" }
 * ```
 *
 * The unmatched-route catch-all 404 handler additionally attaches a `data`
 * object carrying `{ method, path }` so clients hitting the wrong endpoint
 * can see what they actually requested.
 *
 * The envelope deliberately omits internal route/file paths, stack traces, or
 * the underlying object's keys — see issue #131 security note.
 */
export interface NotFoundEnvelope {
  success: false;
  error: string;
  data?: Record<string, unknown>;
}

/**
 * Send a 404 response in the standard envelope.
 *
 * Use this from any handler that needs to report "the resource you asked for
 * does not exist" — e.g. an unknown agreement ID, a transaction that has not
 * been mined yet, or a billing profile that is not in the database. Doing so
 * keeps the on-the-wire shape consistent across every router.
 *
 * @param res - The Express response.
 * @param message - Human-readable error message (no internal paths or stack info).
 * @param data - Optional contextual data (e.g. `{ txHash }`, `{ agreementId }`).
 *               Values are echoed verbatim, so the caller is responsible for
 *               making sure they do not leak sensitive information.
 */
export function notFoundResponse(
  res: Response,
  message: string,
  data?: Record<string, unknown>,
): void {
  const body: NotFoundEnvelope = { success: false, error: message };
  if (data) {
    body.data = data;
  }
  res.status(404).json(body);
}

/**
 * Catch-all handler for unmatched `/api/v1/*` routes. Emits the standard 404
 * envelope with the requested method + path echoed in `data` for debugging.
 *
 * Mount this *after* every `/api/v1` router and *before* the central error
 * handler. Because Express serializes the method/path as JSON, user-controlled
 * paths are never rendered as HTML.
 */
export function apiV1NotFoundHandler(req: Request, res: Response): void {
  notFoundResponse(res, "Route not found", {
    method: req.method,
    path: `${req.baseUrl}${req.path}`,
  });
}

import type { Response } from "express";
import { createHash } from "node:crypto";

/**
 * Options for {@link applyIndexedCacheHeaders}.
 */
export interface IndexedCacheOptions {
  /**
   * `Cache-Control: public, max-age` value in **seconds**.
   *
   * Set this from `env.INDEXED_CACHE_MAX_AGE_SECONDS` so it is configurable
   * per environment.  Defaults to 12 s (≈ one Starknet block).
   */
  maxAgeSeconds?: number;
}

/**
 * Attach `Cache-Control` and `ETag` headers to an indexed read response.
 *
 * Cache policy rationale
 * ──────────────────────
 * Indexed data changes at most once per block.  A short `public, max-age`
 * lets CDN edges and browser caches skip re-fetches for the duration of one
 * block, dramatically reducing redundant upstream requests while keeping
 * staleness to at most one block period.
 *
 * Security note
 * ─────────────
 * Only call this helper on **public, non-auth-varying** responses.
 * Do NOT apply it to any endpoint whose response content changes based on
 * the authenticated caller's identity.
 *
 * @param res          Express response object (headers are written before the body).
 * @param body         The serialisable response body used to derive the ETag.
 * @param options      Optional tuning – see {@link IndexedCacheOptions}.
 * @returns            The SHA-256 ETag string (including surrounding quotes).
 */
export function applyIndexedCacheHeaders(
  res: Response,
  body: unknown,
  { maxAgeSeconds = 12 }: IndexedCacheOptions = {},
): string {
  const etag = computeETag(body);

  res.setHeader("Cache-Control", `public, max-age=${maxAgeSeconds}`);
  res.setHeader("ETag", etag);

  return etag;
}

/**
 * Compute a weak ETag from the JSON-serialised form of `value`.
 *
 * Uses SHA-256 (first 40 hex chars) wrapped in double-quotes as required by
 * RFC 7232.  Choosing a deterministic serialisation means the same logical
 * response always produces the same ETag regardless of key insertion order.
 */
export function computeETag(value: unknown): string {
  const json = JSON.stringify(value);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 40);
  return `"${hash}"`;
}

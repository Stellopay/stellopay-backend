import { z } from "zod";
import { normalizeStarknetAddress } from "./address.js";

/**
 * Shared Zod schema for a Starknet address supplied as a path or query
 * parameter. Accepts a hex string of up to 64 hex characters (the felt width),
 * with or without a 0x prefix, and transforms it to the canonical lookup form
 * via {@link normalizeStarknetAddress}, so callers receive an address ready for
 * a database lookup. The 0x prefix is optional to match the canonical
 * normalizer; non-hex, oversized, or empty values are rejected before any
 * database or RPC call.
 *
 * @example
 * StarknetAddress.parse("0x4718F5a..."); // canonical normalized address
 * StarknetAddress.parse("abc");          // also accepted, normalized to 0x..0abc
 */
export const StarknetAddress = z
  .string()
  .trim()
  .regex(
    /^(0x)?[0-9a-fA-F]{1,64}$/,
    "must be a hex string of up to 64 hex characters, with an optional 0x prefix"
  )
  .transform((value) => normalizeStarknetAddress(value));

/**
 * Shared Zod schema for a numeric agreement identifier passed as a string. The
 * id is stored as text, so it stays a string but must contain only digits,
 * which keeps malformed identifiers out of the database query.
 */
export const AgreementId = z
  .string()
  .trim()
  .regex(/^\d+$/, "agreement_id must be a numeric string");

/** Largest page a list endpoint will return in a single response. */
export const MAX_PAGE_LIMIT = 100;

/** Page size used when the caller does not supply a usable limit. */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * Parses and clamps pagination query parameters. Clamping happens server-side
 * so a client cannot request an unbounded, zero, or negative page: the limit is
 * forced into the range 1 to {@link MAX_PAGE_LIMIT} and the offset to 0 or more.
 * Missing or non-numeric values fall back to safe defaults rather than failing
 * the request.
 *
 * @param query - The request query object (req.query).
 * @returns A clamped pair of limit and offset.
 *
 * @example
 * parsePagination({ limit: "5000" }); // { limit: 100, offset: 0 }
 * parsePagination({ offset: "-3" });  // { limit: 50, offset: 0 }
 */
export function parsePagination(query: unknown): {
  limit: number;
  offset: number;
} {
  const source = (query ?? {}) as Record<string, unknown>;
  const limitRaw = z.coerce
    .number()
    .int()
    .catch(DEFAULT_PAGE_LIMIT)
    .parse(source.limit);
  const offsetRaw = z.coerce.number().int().catch(0).parse(source.offset);
  return {
    limit: Math.min(Math.max(limitRaw, 1), MAX_PAGE_LIMIT),
    offset: Math.max(offsetRaw, 0),
  };
}

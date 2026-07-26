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

interface ValidationErrorMetric {
  validator: string;
  input: string;
  error: string;
  timestamp: string;
}

function logValidationError(metric: ValidationErrorMetric): void {
  console.warn(`[validation:error] ${JSON.stringify(metric)}`);
}

/**
 * Wraps a Zod schema with error logging. On parse failure, logs structured
 * diagnostics before re-throwing so production failures are traceable.
 */
export function loggedParse<T>(schema: z.ZodSchema<T>, value: unknown, validatorName: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    logValidationError({
      validator: validatorName,
      input: typeof value === "string" ? value.slice(0, 40) : String(value).slice(0, 40),
      error: result.error.issues.map((i) => i.message).join("; "),
      timestamp: new Date().toISOString(),
    });
    throw result.error;
  }
  return result.data;
}

/**
 * Categorised validation failure that callers can inspect programmatically.
 * The `code` mirrors the Zod issue code so downstream error handlers can
 * decide how to phrase the response without parsing the raw ZodError.
 */
export interface MappedValidationError {
  code: string;
  message: string;
  path: (string | number)[];
}

/**
 * Extracts the first issue from a {@link z.ZodError} into a plain object so
 * callers and error handlers don't need to traverse the issue list themselves.
 * Returns `undefined` when the error is not a ZodError or has no issues.
 *
 * @example
 * try { StarknetAddress.parse("nothex"); }
 * catch (e) {
 *   const mapped = mapZodError(e);
 *   // { code: "invalid_string", message: "must be a hex string of ...", path: [] }
 * }
 */
export function mapZodError(error: unknown): MappedValidationError | undefined {
  if (error instanceof z.ZodError && error.issues.length > 0) {
    const issue = error.issues[0];
    return { code: issue.code, message: issue.message, path: issue.path };
  }
  return undefined;
}

export const StarknetAddress = z
  .string()
  .trim()
  .regex(
    /^(0x)?[0-9a-fA-F]{1,64}$/,
    "must be a hex string of up to 64 hex characters, with an optional 0x prefix",
  )
  .transform((value, ctx) => {
    try {
      return normalizeStarknetAddress(value);
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: e instanceof Error ? e.message : String(e) });
      return z.NEVER;
    }
  });

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
/**
 * Normalizes "missing-like" values — an explicit `null` or empty string — to
 * `undefined` before delegating to Zod so the `.catch()` fallback engages.
 *
 * Without this normalization, Zod's `z.coerce.number()` would coerce both
 * `null` and `""` to the number `0`, which then passes `.int()` and is
 * silently clamped to a limit of `1`. That is a fail-open that bypasses
 * {@link DEFAULT_PAGE_LIMIT} and makes a pagination request return only a
 * single row — inconsistent with `undefined`, which falls back to the
 * documented default. Treating `null` / `""` and `undefined` uniformly
 * removes the inconsistency.
 */
function coerceNullOrEmptyToUndefined(value: unknown): unknown {
  if (value === null || value === "") return undefined;
  return value;
}

export function parsePagination(query: unknown): {
  limit: number;
  offset: number;
} {
  const source = (query ?? {}) as Record<string, unknown>;
  const limitRaw = z.coerce
    .number()
    .int()
    .catch(DEFAULT_PAGE_LIMIT)
    .parse(coerceNullOrEmptyToUndefined(source.limit));
  const offsetRaw = z.coerce
    .number()
    .int()
    .catch(0)
    .parse(coerceNullOrEmptyToUndefined(source.offset));
  return {
    limit: Math.min(Math.max(limitRaw, 1), MAX_PAGE_LIMIT),
    offset: Math.max(offsetRaw, 0),
  };
}

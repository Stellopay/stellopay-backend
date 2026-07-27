import { z } from "zod";
import { normalizeStarknetAddress } from "./address.js";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
// This module owns schema definitions and the error-mapping contract for
// request validation throughout the backend.  Every public export is a
// building block that a route handler, middleware, or test can use to:
//
//   1.  **Parse** an untrusted value against a Zod schema and get a typed
//       result or a thrown ZodError (StarknetAddress, AgreementId).
//   2.  **Clamp** pagination parameters to safe defaults (parsePagination).
//   3.  **Log + re-throw** parse failures with structured diagnostics so
//       production errors are traceable (loggedParse).
//   4.  **Map** a caught ZodError to the standard API JSON shape so the
//       response format is consistent across all routes
//       (formatValidationError).
//
// Schemas throw `ZodError` on invalid input.  Callers either catch it
// inline (see src/routes/backfill-events.ts) or let it propagate to the
// global error handler in src/index.ts which detects ZodError, responds
// with HTTP 400, and attaches `err.issues` as the `details` field.
// ---------------------------------------------------------------------------

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
 *
 * @param schema - Zod schema to validate against.
 * @param value - Untrusted input to validate.
 * @param validatorName - Short label that appears in the log entry so
 *   operators can identify which validator rejected the input.
 * @returns The validated and transformed value.
 * @throws z.ZodError when validation fails (after logging).
 *
 * @example
 * const address = loggedParse(StarknetAddress, raw, "createAgreement");
 *
 * // On failure logs:
 * // [validation:error] {"validator":"createAgreement","input":"0xbad...","error":"...","timestamp":"..."}
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

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Standard shape returned by the global error handler and every inline
 * catch-block when a ZodError is mapped to an HTTP 400 response.
 */
export interface ValidationErrorResponse {
  /** Human-readable summary ("Validation failed"). */
  error: string;
  /** Per-field Zod issues, omitted when the error is not a ZodError. */
  details?: z.ZodIssue[];
}

/**
 * Maps an unknown error to the standard {@link ValidationErrorResponse}
 * shape.  When the error is a ZodError the `details` array is populated
 * with the per-issue breakdown; otherwise only the top-level `error`
 * string is set so sensitive internals are never leaked.
 *
 * @example
 * try {
 *   StarknetAddress.parse(raw);
 * } catch (e) {
 *   const { error, details } = formatValidationError(e);
 *   res.status(400).json({ error, details });
 * }
 */
export function formatValidationError(error: unknown): ValidationErrorResponse {
  if (error instanceof z.ZodError) {
    return { error: "Validation failed", details: error.issues };
  }
  return { error: "Invalid request" };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Zod schema for a Starknet address supplied as a path or query parameter.
 * Accepts a hex string of up to 64 hex characters (the felt width), with or
 * without a 0x prefix, and transforms it to the canonical lookup form via
 * {@link normalizeStarknetAddress}, so callers receive an address ready for a
 * database lookup.  Non-hex, oversized, empty, whitespace-only, or
 * invalid-checksum values are rejected before any database or RPC call.
 *
 * The 0x prefix is optional.  Mixed-case addresses are validated against the
 * SNIP-23 / EIP-55 checksum and rejected on mismatch.
 *
 * @example
 * StarknetAddress.parse("0x4718F5a..."); // canonical normalized address
 * StarknetAddress.parse("abc");          // accepted, normalized to 0x..0abc
 * StarknetAddress.parse("");            // throws ZodError
 */
export const StarknetAddress = z
  .string()
  .trim()
  .regex(
    /^(0x)?[0-9a-fA-F]{1,64}$/,
    "must be a hex string of up to 64 hex characters, with an optional 0x prefix",
  )
  .transform((value) => normalizeStarknetAddress(value));


/**
 * Zod schema for a numeric agreement identifier passed as a string. The id is
 * stored as text in the database, so it stays a string but must contain only
 * digits, which keeps malformed identifiers out of the database query.
 *
 * Leading zeros are preserved.  Negative numbers, floats, hex, unicode digits,
 * and empty / whitespace-only strings are rejected.
 *
 * @example
 * AgreementId.parse("42");     // "42"
 * AgreementId.parse("00042");  // "00042"
 * AgreementId.parse("");       // throws ZodError
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
 * Parses and clamps pagination query parameters. The function NEVER throws;
 * every input is gracefully degraded to a safe value so that a malformed query
 * never causes a 5xx error.
 *
 * Clamping happens server-side so a client cannot request an unbounded, zero,
 * or negative page: the limit is forced into the range 1 to
 * {@link MAX_PAGE_LIMIT} and the offset to 0 or more.  Missing or non-numeric
 * values fall back to safe defaults.
 *
 * **null / "" normalization** – Without the explicit `null`/`""` → `undefined`
 * conversion, Zod's `z.coerce.number()` would coerce both `null` and `""` to
 * the number `0`, which then passes `.int()` and gets silently clamped to a
 * limit of `1`.  That is a fail-open that bypasses {@link DEFAULT_PAGE_LIMIT}
 * and makes a pagination request return only a single row — inconsistent with
 * `undefined`, which falls back to the documented default.  Treating `null` /
 * `""` and `undefined` uniformly removes the inconsistency.
 *
 * @param query - The request query object (req.query).  `undefined` / `null`
 *   are treated as an empty object.
 * @returns A clamped pair of { limit, offset } — both finite integers within
 *   documented bounds.
 *
 * @example
 * parsePagination({ limit: "5000" }); // { limit: 100, offset: 0 }
 * parsePagination({ offset: "-3" });  // { limit: 50, offset: 0 }
 * parsePagination(null);              // { limit: 50, offset: 0 }
 */
/** @see parsePagination — this exists solely to support its null/"" normalization */
function coerceNullOrEmptyToUndefined(value: unknown): unknown {
  if (value === null || value === "") return undefined;
  return value;
}

/**
 * Parses and clamps pagination query parameters. Clamping happens server-side
 * so a client cannot request an unbounded, zero, or negative page: `limit` is
 * forced into `[1, MAX_PAGE_LIMIT]` and `offset` to `>= 0`. Missing or
 * non-numeric values fall back to safe defaults rather than failing the
 * request.
 *
 * This function **never throws** — any input shape returns a valid, finite
 * pair. Non-object inputs (strings, numbers, arrays, `null`, `undefined`) are
 * treated as if no pagination params were supplied and fall back to defaults.
 *
 * @param query - The request query object (`req.query`), or any value.
 * @returns `{ limit, offset }` — both finite integers within the documented
 *   bounds.
 *
 * @example
 * parsePagination({ limit: "5000" }); // { limit: 100, offset: 0 }
 * parsePagination({ offset: "-3" });  // { limit: 50, offset: 0 }
 * parsePagination("not-an-object");   // { limit: 50, offset: 0 }
 */
export function parsePagination(query: unknown): {
  limit: number;
  offset: number;
} {
  // Non-object inputs (strings, numbers, arrays, null, undefined) carry no
  // limit/offset keys. Treat them as an empty object so the defaults engage
  // rather than relying on a silent `as Record<string, unknown>` cast.
  const source: Record<string, unknown> = isPlainObject(query) ? query : {};

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

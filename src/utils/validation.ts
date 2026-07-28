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
//   4.  **Map** a caught error to the standard API JSON shape so the response
//       format is consistent across all routes (formatValidationError).
//
// Security boundary — the invariants below must hold for every input, so that
// a validation failure can never be escalated into a success or into an
// unrelated status class:
//
//   *  A validation failure is ALWAYS a client error.  `ValidationError.status`
//      is clamped to the 4xx range (`400`–`499`) and defaults to `400`, so a
//      caller cannot mint a `ValidationError` that the global error handler in
//      `src/index.ts` would replay as `2xx` (fail-open) or `5xx`.
//   *  Diagnostics NEVER carry a raw payload.  The logged/attached `input` is a
//      bounded, sanitized preview (see `previewInput`): non-strings are
//      stringified to their type tag rather than their contents, control
//      characters are stripped so a crafted value cannot forge log lines, and
//      the result is truncated to `INPUT_PREVIEW_MAX_LENGTH`.
//   *  Diagnostics NEVER throw.  Building the preview for a hostile value
//      (a `null`-prototype object, a throwing `toString`) must not turn a
//      `400` into an unhandled `500`.
//   *  `formatValidationError` only ever emits the two documented shapes; any
//      value it does not recognize collapses to `{ error: "Invalid request" }`
//      so internals are never leaked to a client.
//
// Schemas throw `ZodError` on invalid input.  Callers either catch it
// inline (see src/routes/backfill-events.ts) or let it propagate to the
// global error handler in src/index.ts which detects ZodError, responds
// with HTTP 400, and attaches `err.issues` as the `details` field.
// ---------------------------------------------------------------------------

/**
 * Structured diagnostic emitted on every validation failure.  Written to the
 * log stream by {@link loggedParse} and attached to {@link ValidationError} so
 * a caught error and its log line always describe the same event.
 *
 * `input` is a sanitized preview (see {@link previewInput}), never the raw
 * value.
 */
export interface ValidationErrorMetric {
  validator: string;
  input: string;
  error: string;
  timestamp: string;
}

/** Maximum number of characters of an input echoed into diagnostics. */
export const INPUT_PREVIEW_MAX_LENGTH = 40;

/** Lowest status a validation failure may map to. */
const MIN_VALIDATION_STATUS = 400;

/** Highest status a validation failure may map to. */
const MAX_VALIDATION_STATUS = 499;

/**
 * A single validation issue.  Structurally compatible with `z.ZodIssue` while
 * staying permissive enough for hand-built issues (see
 * `src/routes/backfill-events.ts`), which keeps the error-mapping contract
 * typed without forcing every caller through Zod's discriminated union.
 */
export interface ValidationIssue {
  /** Zod issue code (`"invalid_type"`, `"custom"`, …) when available. */
  code?: string;
  /** Path to the offending field; empty for a top-level failure. */
  path?: PropertyKey[];
  /** Human-readable description of the failure. */
  message: string;
}

/**
 * Builds a bounded, sanitized preview of an untrusted value for diagnostics.
 *
 * Guarantees, in order:
 *   1.  **Never throws** — a `null`-prototype object or a throwing `toString`
 *       degrades to `"[unserializable]"` instead of escaping as a TypeError
 *       (which would turn a 400 into a 500).
 *   2.  **Never echoes structured payloads** — only strings are echoed
 *       verbatim; every other type is rendered by `String()`, so an object
 *       body becomes `"[object Object]"` rather than its contents.
 *   3.  **Never forges log lines** — control characters (including newlines)
 *       are replaced so a crafted input cannot inject a second log record into
 *       a downstream plain-text sink.
 *   4.  **Bounded** — truncated to {@link INPUT_PREVIEW_MAX_LENGTH} characters.
 *
 * @param value - The untrusted value that failed validation.
 * @returns A safe, single-line preview string.
 */
export function previewInput(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : String(value);
  } catch {
    text = "[unserializable]";
  }
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, INPUT_PREVIEW_MAX_LENGTH);
}

/**
 * Clamps a requested status into the client-error range.
 *
 * A validation failure is by definition a client error, so anything outside
 * `400`–`499` — including a non-finite or non-integer value — collapses to
 * `400`.  This is what stops the status of a rejected request from drifting
 * into a success (`2xx`) or a server fault (`5xx`) once the global error
 * handler replays `err.status`.
 */
function normalizeValidationStatus(status: unknown): number {
  if (typeof status !== "number" || !Number.isInteger(status)) return MIN_VALIDATION_STATUS;
  if (status < MIN_VALIDATION_STATUS || status > MAX_VALIDATION_STATUS) {
    return MIN_VALIDATION_STATUS;
  }
  return status;
}

function logValidationError(metric: ValidationErrorMetric): void {
  console.warn(`[validation:error] ${JSON.stringify(metric)}`);
}

/**
 * Narrow type guard for a plain (non-array, non-null) object.
 *
 * Used to decide whether an untrusted value may be indexed by key, so no code
 * path relies on a silent `as Record<string, unknown>` cast.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ValidationErrorOptions {
  validator: string;
  message: string;
  issues: ValidationIssue[];
  input: string;
  /** Clamped to `400`–`499`; anything else becomes `400`. */
  status?: number;
  cause?: unknown;
}

/**
 * The error thrown by {@link loggedParse} and the canonical carrier for a
 * failed validation.
 *
 * `status` is always a client-error status, `issues` is always an array, and
 * `input` is always a sanitized preview — the global error handler can
 * therefore replay `status`/`issues` directly without re-checking them.
 */
export class ValidationError extends Error {
  override name = "ValidationError";
  validator: string;
  input: string;
  issues: ValidationIssue[];
  status: number;
  timestamp: string;
  override cause?: unknown;
  metric: ValidationErrorMetric;

  constructor(
    opts: ValidationErrorOptions | string,
    validator?: string,
    input?: string,
    metric?: ValidationErrorMetric,
  ) {
    if (typeof opts === "object" && opts !== null) {
      super(opts.message);
      this.validator = opts.validator;
      this.input = previewInput(opts.input);
      this.issues = Array.isArray(opts.issues) ? opts.issues : [];
      this.status = normalizeValidationStatus(opts.status);
      this.cause = opts.cause;
      this.timestamp = new Date().toISOString();
      this.metric = {
        validator: this.validator,
        input: this.input,
        error: opts.message,
        timestamp: this.timestamp,
      };
    } else {
      // Legacy positional form, kept for callers predating the options object.
      super(opts);
      this.validator = validator || "";
      this.input = previewInput(input || "");
      this.issues = [];
      this.status = MIN_VALIDATION_STATUS;
      this.timestamp = metric?.timestamp || new Date().toISOString();
      this.metric = metric || {
        validator: this.validator,
        input: this.input,
        error: opts,
        timestamp: this.timestamp,
      };
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      validator: this.validator,
      issues: this.issues,
      input: this.input,
      status: this.status,
      timestamp: this.timestamp,
    };
  }

  static fromZodError(error: z.ZodError, validator: string, input: string): ValidationError {
    const message = error.issues.map((i) => i.message).join("; ");
    return new ValidationError({
      validator,
      message,
      issues: error.issues,
      input,
      cause: error,
      status: MIN_VALIDATION_STATUS,
    });
  }
}

/**
 * Type guard for {@link ValidationError}.
 *
 * Prefer this over `instanceof` at module boundaries: it also recognizes an
 * error that crossed a bundling or duplicate-dependency boundary, where the
 * class identity differs but the contract (4xx status + issue list) holds.
 */
export function isValidationError(error: unknown): error is ValidationError {
  if (error instanceof ValidationError) return true;
  return (
    error instanceof Error &&
    error.name === "ValidationError" &&
    Array.isArray((error as Partial<ValidationError>).issues)
  );
}

/**
 * Returns the first issue of a validation failure, or `undefined` when the
 * value is not one.
 *
 * Accepts both a raw `ZodError` and a {@link ValidationError} so callers do not
 * have to know which layer threw.
 */
export function mapZodError(error: unknown): ValidationIssue | undefined {
  if (error instanceof z.ZodError) return error.issues[0];
  if (isValidationError(error)) return error.issues[0];
  return undefined;
}

/**
 * Wraps a Zod schema with error logging. On parse failure, logs structured
 * diagnostics and throws a {@link ValidationError} carrying the original
 * `ZodError` as `cause`, so production failures are traceable while the
 * response contract stays a client error.
 *
 * @param schema - Zod schema to validate against.
 * @param value - Untrusted input to validate.
 * @param validatorName - Short label that appears in the log entry so
 *   operators can identify which validator rejected the input.
 * @returns The validated and transformed value.
 * @throws ValidationError when validation fails (after logging).
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
    const inputPreview = previewInput(value);
    logValidationError({
      validator: validatorName,
      input: inputPreview,
      error: result.error.issues.map((i) => i.message).join("; "),
      timestamp: new Date().toISOString(),
    });
    throw ValidationError.fromZodError(result.error, validatorName, inputPreview);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Standard shape returned by the global error handler and every inline
 * catch-block when a validation failure is mapped to an HTTP 4xx response.
 */
export interface ValidationErrorResponse {
  /** Human-readable summary ("Validation failed"). */
  error: string;
  /** Per-field issues, omitted when the error is not a validation failure. */
  details?: ValidationIssue[];
}

/**
 * Maps an unknown error to the standard {@link ValidationErrorResponse} shape.
 *
 * A `ZodError` and a {@link ValidationError} both yield
 * `{ error: "Validation failed", details }` — `loggedParse` throws the latter,
 * so recognizing only `ZodError` here would silently drop the issue list for
 * everything that goes through it.  Any other value yields
 * `{ error: "Invalid request" }` with no `details`, so an unexpected internal
 * error never leaks its message or stack to a client.
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
  if (isValidationError(error)) {
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
  .transform((value, ctx) => {
    try {
      return normalizeStarknetAddress(value);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof Error ? e.message : String(e),
      });
      return z.NEVER;
    }
  });

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

export const MAX_PAGE_LIMIT = 100;

export const DEFAULT_PAGE_LIMIT = 50;

/** @see parsePagination — this exists solely to support its null/"" normalization */
function coerceNullOrEmptyToUndefined(value: unknown): unknown {
  if (value === null || value === "") return undefined;
  return value;
}

/**
 * Coerces one pagination field to a safe integer inside `[min, max]`.
 *
 * Anything that is not a *safe* integer — a non-numeric string, a float,
 * `Infinity`/`NaN`, or a magnitude beyond `Number.MAX_SAFE_INTEGER` (e.g.
 * `"1e20"`, which passes Zod's `.int()` because it has no fractional part) —
 * falls back to `fallback` rather than being clamped.  Clamping an
 * unrepresentable magnitude would hand a lossy number to the query layer; the
 * documented default is the safer answer.
 */
function clampPaginationField(value: unknown, fallback: number, min: number, max: number): number {
  const coerced = z.coerce
    .number()
    .int()
    .catch(fallback)
    .parse(coerceNullOrEmptyToUndefined(value));
  const safe = Number.isSafeInteger(coerced) ? coerced : fallback;
  return Math.min(Math.max(safe, min), max);
}

/**
 * Parses and clamps pagination query parameters. Clamping happens server-side
 * so a client cannot request an unbounded, zero, or negative page: `limit` is
 * forced into `[1, MAX_PAGE_LIMIT]` and `offset` to
 * `[0, Number.MAX_SAFE_INTEGER]`. Missing or non-numeric values fall back to
 * safe defaults rather than failing the request.
 *
 * This function **never throws** — any input shape returns a valid, finite
 * pair. Non-object inputs (strings, numbers, arrays, `null`, `undefined`) are
 * treated as if no pagination params were supplied and fall back to defaults.
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
 * @returns `{ limit, offset }` — both safe integers within the documented
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

  return {
    limit: clampPaginationField(source.limit, DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT),
    offset: clampPaginationField(source.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

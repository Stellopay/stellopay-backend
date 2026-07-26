import { z } from "zod";
import { normalizeStarknetAddress } from "./address.js";

export class ValidationError extends Error {
  readonly validator: string;
  readonly issues: Array<{ path: (string | number)[]; message: string; code: string }>;
  readonly input: string;
  readonly timestamp: string;
  readonly status: number;

  constructor(opts: {
    validator: string;
    message: string;
    issues: Array<{ path: (string | number)[]; message: string; code: string }>;
    input: string;
    cause?: unknown;
    status?: number;
  }) {
    super(opts.message);
    this.name = "ValidationError";
    this.validator = opts.validator;
    this.issues = opts.issues;
    this.input = opts.input;
    this.timestamp = new Date().toISOString();
    this.status = opts.status ?? 400;
    if (opts.cause !== undefined) {
      this.cause = opts.cause instanceof Error ? opts.cause : new Error(String(opts.cause));
    }
  }

  static fromZodError(
    zodError: z.ZodError,
    validator: string,
    input: string,
  ): ValidationError {
    return new ValidationError({
      validator,
      message: zodError.issues.map((i) => i.message).join("; "),
      issues: zodError.issues.map((i) => ({
        path: i.path,
        message: i.message,
        code: i.code,
      })),
      input,
      cause: zodError,
      status: 400,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      validator: this.validator,
      issues: this.issues,
      input: this.input,
      timestamp: this.timestamp,
      status: this.status,
    };
  }
}

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
 * diagnostics before throwing a serializable {@link ValidationError} so
 * production failures are traceable and safe to serialize for retry/replay.
 *
 * The thrown {@link ValidationError} carries `status: 400` so Express-level
 * error handlers that respect `err.status` map it to a client error response.
 */
export function loggedParse<T>(schema: z.ZodSchema<T>, value: unknown, validatorName: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const inputPreview =
      typeof value === "string" ? value.slice(0, 40) : String(value).slice(0, 40);
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

export const StarknetAddress = z
  .string()
  .trim()
  .regex(
    /^(0x)?[0-9a-fA-F]{1,64}$/,
    "must be a hex string of up to 64 hex characters, with an optional 0x prefix",
  )
  .transform((value) => normalizeStarknetAddress(value));

export const AgreementId = z
  .string()
  .trim()
  .regex(/^\d+$/, "agreement_id must be a numeric string");

export const MAX_PAGE_LIMIT = 100;

export const DEFAULT_PAGE_LIMIT = 50;

function coerceNullOrEmptyToUndefined(value: unknown): unknown {
  if (value === null || value === "") return undefined;
  return value;
}

function guardFinite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function parsePagination(query: unknown): {
  limit: number;
  offset: number;
} {
  const source = (query ?? {}) as Record<string, unknown>;
  const limitRaw = guardFinite(
    z.coerce
      .number()
      .int()
      .catch(DEFAULT_PAGE_LIMIT)
      .parse(coerceNullOrEmptyToUndefined(source.limit)),
    DEFAULT_PAGE_LIMIT,
  );
  const offsetRaw = guardFinite(
    z.coerce
      .number()
      .int()
      .catch(0)
      .parse(coerceNullOrEmptyToUndefined(source.offset)),
    0,
  );
  return {
    limit: Math.min(Math.max(limitRaw, 1), MAX_PAGE_LIMIT),
    offset: Math.max(offsetRaw, 0),
  };
}

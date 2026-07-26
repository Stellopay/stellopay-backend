# Validation utilities

## Location

`src/utils/validation.ts`

## Overview

This module owns schema validation and error mapping for the entire backend.
It exports Zod-based schemas for common parameter types and two helper
functions that wrap validation with structured error handling.

Callers **must not** use `z.parse()` directly on raw user input. Instead they
should use one of the exported schemas (`StarknetAddress`, `AgreementId`) or
wrap their own Zod schema with `loggedParse()` when the failure path needs
structured observability. `parsePagination()` is the only pagination parser
and must be used instead of ad-hoc Zod coercion at the call site.

## Error contract

All validation failures flow through one of two paths:

| Path | Error type | Status | Serialization |
|------|-----------|--------|---------------|
| Direct `.parse()` on `StarknetAddress` / `AgreementId` | `z.ZodError` | 400 (via Express handler) | `err.issues` array |
| `loggedParse()` | `ValidationError` | `err.status` = 400 | `err.toJSON()` produces a stable shape |

### `ValidationError`

```typescript
class ValidationError extends Error {
  name: "ValidationError";
  validator: string;
  issues: Array<{ path: (string | number)[]; message: string; code: string }>;
  input: string;         // truncated to 40 chars
  timestamp: string;     // ISO 8601
  status: number;        // defaults to 400
  cause?: Error;         // original ZodError (if available)

  toJSON(): Record<string, unknown>;

  static fromZodError(zodError: z.ZodError, validator: string, input: string): ValidationError;
}
```

The `toJSON()` method guarantees a stable, serializable shape that survives
`JSON.parse(JSON.stringify(err))`. This is essential for retry/replay
pipelines where error diagnostics are persisted across process boundaries.

### `loggedParse()`

```typescript
function loggedParse<T>(schema: z.ZodSchema<T>, value: unknown, validatorName: string): T;
```

- On success: returns the parsed value.
- On failure: logs a structured JSON line via `console.warn` with prefix
  `[validation:error]`, then throws a `ValidationError`.
- The log shape is `{ validator, input, error, timestamp }` where `input` is
  truncated to 40 characters.
- The thrown `ValidationError` carries `status: 400` so Express-level error
  handlers that check `err.status` map it to a client error response.

### `parsePagination()`

```typescript
function parsePagination(query: unknown): { limit: number; offset: number };
```

- Never throws. All pathological inputs degrade gracefully to safe defaults.
- `limit` is clamped to `[1, MAX_PAGE_LIMIT]` (default 50, max 100).
- `offset` is clamped to `[0, ∞)`.
- `Infinity`, `-Infinity`, and `NaN` in either value are treated as missing
  (fall back to the corresponding default).
- `null` and `""` are normalized to `undefined` before Zod coercion so they
  fall back to the default rather than being coerced to `0`.

## Retry and replay semantics

When validation fails during a background job or event handler, the caller
should:

1. Catch the error.
2. Check `error instanceof ValidationError` (for `loggedParse` calls) or
   `error instanceof ZodError` (for direct `.parse()` calls).
3. Persist the error diagnostics via `JSON.stringify(error)` (safe for
   `ValidationError` via `toJSON()`; for `ZodError`, use `error.issues`
   which is serializable).
4. Decide whether to retry based on the `validator` and `issues` rather than
   parsing an unstructured error message.

## Schemas

### `StarknetAddress`

- Accepts a hex string of up to 64 hex characters, with or without `0x` prefix.
- Transforms to canonical form (zero-padded, lowercase) via `normalizeStarknetAddress`.
- Rejects non-hex, empty, whitespace-only, or `null`/`undefined`/non-string inputs.
- Mixed-case addresses are checksum-validated; a mismatch is rejected.

### `AgreementId`

- Accepts a numeric-only string (digits only, no decimal, no sign).
- Rejects hex (`0x...`), floats, negatives, and non-string types.
- Trims whitespace before validation.

## Out of scope

- This module does **not** define HTTP response format for validation errors.
  The Express error handler in `src/index.ts` owns the mapping from error type
  to HTTP status and response body.
- `normalizeStarknetAddress()` is defined in `src/utils/address.ts`, not here.

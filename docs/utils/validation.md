# Validation — Schema Definitions & Error Mapping

Source of truth: [`src/utils/validation.ts`](../../src/utils/validation.ts)

## Contract

This module provides the shared schemas and error-mapping helpers used by every
route handler that validates request parameters.  All of the following are
exported:

| Export | Kind | Purpose |
|---|---|---|
| `StarknetAddress` | `z.ZodString` → transform | Parse + normalize a Starknet hex address |
| `AgreementId` | `z.ZodString` | Parse a numeric-string agreement identifier |
| `parsePagination` | function | Clamp `limit`/`offset` query params to safe defaults |
| `loggedParse` | function | Parse + log structured diagnostics on failure |
| `formatValidationError` | function | Map a caught error to the standard API JSON shape |
| `ValidationErrorResponse` | interface | Return type of `formatValidationError` |
| `MAX_PAGE_LIMIT` | `number` (= 100) | Upper bound for pagination limit |
| `DEFAULT_PAGE_LIMIT` | `number` (= 50) | Fallback pagination limit |

## Schemas

### `StarknetAddress`

- Accepts a hex string with or without `0x` prefix
- Up to 64 hex characters (Starknet felt width)
- Trims surrounding whitespace before validation
- On success, returns the canonical lowercase `0x`-padded 64-char form
- Mixed-case inputs are validated against SNIP-23/EIP-55 checksum
- **Rejects**: non-hex, oversized, empty, whitespace-only, null, undefined,
  non-string types, invalid checksum

```typescript
StarknetAddress.parse("0x4718F5a...") // "0x0..." (canonical)
StarknetAddress.parse("abc")           // "0x0...0abc" (padded)
StarknetAddress.parse("")              // throws ZodError
```

### `AgreementId`

- Accepts a string containing only ASCII digits (`0`–`9`)
- Leading zeros are preserved
- Trims surrounding whitespace
- **Rejects**: negative signs, floats, hex (`0x...`), unicode digits, empty
  string, whitespace-only, null, undefined, non-string types

```typescript
AgreementId.parse("42")     // "42"
AgreementId.parse("00042")  // "00042"
AgreementId.parse("12ab")   // throws ZodError
```

## Pagination

### `parsePagination(query)` → `{ limit, offset }`

This function **never throws**.  Every input is gracefully degraded:

| Input | Behaviour |
|---|---|
| Missing / `undefined` / `null` query | Defaults: `{ limit: 50, offset: 0 }` |
| `limit` or `offset` is `null` / `""` | Treated as `undefined` → falls back to default |
| `limit` > `MAX_PAGE_LIMIT` | Clamped down to `MAX_PAGE_LIMIT` (100) |
| `limit` < 1 | Clamped up to `1` |
| `offset` < 0 | Clamped up to `0` |
| Non-numeric strings (`"abc"`, `"1.5"`) | Fall back to default via `.catch()` |
| Array values | Single-element arrays coerce; multi-element fall back to default |
| Object / boolean values | Fall back to default |

```typescript
parsePagination({ limit: "5000" })   // { limit: 100, offset: 0 }
parsePagination({ offset: "-3" })    // { limit: 50, offset: 0 }
parsePagination(null)                // { limit: 50, offset: 0 }
```

## Logged Parse

### `loggedParse(schema, value, validatorName)` → `T`

Wraps any Zod schema with structured error logging.  On failure:
1. Logs a JSON entry via `console.warn` with `[validation:error]` prefix
2. Log payload includes: `validator`, `input` (truncated to 40 chars),
   `error` (semi-colon joined issues), `timestamp`
3. Re-throws the original `ZodError`

```typescript
const address = loggedParse(StarknetAddress, raw, "createAgreement");
```

## Error Mapping

### `formatValidationError(error)` → `ValidationErrorResponse`

Maps a caught value to the standard API error shape used across all routes.
When the error is a `ZodError`, the response includes the full issue list:

```typescript
try {
  StarknetAddress.parse(raw);
} catch (e) {
  const { error, details } = formatValidationError(e);
  res.status(400).json({ error, details });
}
```

**Response shapes:**

```json
// ZodError
{ "error": "Validation failed", "details": [{ "code": "invalid_type", ... }] }

// Non-ZodError
{ "error": "Invalid request" }
```

## Error Handling Architecture

1. **Zod schemas throw `ZodError`** on invalid input
2. **Route handlers** either:
   - Catch `ZodError` inline and return 400 (e.g. `backfill-events.ts`)
   - Let the error propagate to the global error handler
3. **Global error handler** (`src/index.ts`) detects `instanceof ZodError`,
   responds with HTTP 400, and attaches `err.issues` as the `details` field

## Edge Cases (Intentionally Out of Scope)

- Custom `ZodIssue` formatting for specific API versions
- Automatic i18n of error messages
- Async validation schemas
- Integration testing of the global error handler with every schema

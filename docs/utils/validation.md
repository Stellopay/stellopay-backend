# Validation Utilities

Source: [`src/utils/validation.ts`](../../src/utils/validation.ts)

Shared Zod schemas and helpers for validating request parameters consistently
across all routes. Every route handler in `src/routes/` that needs to parse a
Starknet address, an agreement id, or pagination query params passes them
through this module so validation rules live in one place.

## Exports

| Export | Kind | Description |
|---|---|---|
| `StarknetAddress` | Zod schema | Hex string (with or without `0x` prefix), 1–64 hex chars, normalised to canonical 0x-padded-64-lowercase form. Rejects whitespace, non-hex, oversized, empty, and null/undefined inputs. Validates SNIP-23 checksum on mixed-case inputs. |
| `AgreementId` | Zod schema | Numeric-only string (digits `0-9`), trimmed. Rejects non-digit, hex-prefixed, negative, float, and empty strings. |
| `parsePagination` | Function | Extracts and clamps `limit` (1–100) and `offset` (≥0) from a query object. Falls back to defaults on missing, null, empty, or non-numeric input without throwing. |
| `loggedParse` | Function | Wraps any Zod schema with structured error logging before re-throwing the error. |
| `MAX_PAGE_LIMIT` | Constant | Hard upper bound for pagination limit (100). |
| `DEFAULT_PAGE_LIMIT` | Constant | Default page size when caller does not supply a limit (50). |

## Contract

### `StarknetAddress`

- Input is trimmed before validation.
- Regex `/^(0x)?[0-9a-fA-F]{1,64}$/` rejects non-hex, mixed-unicode, empty,
  whitespace-only, and >64-char hex strings.
- Transform calls `normalizeStarknetAddress`, which strips leading zeros, pads
  to 64 hex characters, and validates SNIP-23 checksums on mixed-case inputs.
- Errors from the transform surface as `ZodError` with the underlying message.

### `AgreementId`

- Input is trimmed before validation.
- Regex `/^\d+$/` accepts only ASCII digits. Leading zeros, long strings, and
  single-digit values are valid. Hex (`0x...`), negative (`-`), float (`.`),
  scientific (`e`), unicode digits, and empty strings are rejected.

### `parsePagination`

- Coerces `null` and `""` to `undefined` before Zod coercion so `.catch()`
  fallbacks engage instead of coercing to `0`.
- `limit` is clamped to `[1, MAX_PAGE_LIMIT]` after parsing.
- `offset` is floored to `≥ 0` after parsing.
- Never throws: every input shape returns a `{ limit: number, offset: number }`
  with finite values within bounds.

### `loggedParse`

- Calls `schema.safeParse(value)`. On success, returns parsed data.
- On failure, logs a JSON diagnostic via `console.warn` with keys
  `validator`, `input`, `error`, `timestamp` and re-throws the `ZodError`.
- Input is truncated to 40 characters in the log payload. Non-string inputs
  are stringified via `String()`.
- Multiple Zod issues are joined with `"; "`.

## Out of scope

- **Cursor-based pagination** — this module only supports offset/limit
  pagination. See `docs/routes/read.md` for the cursor pattern.
- **Body/payload validation** — this module is focused on path, query, and
  param validation. Request body schemas live in route files or dedicated
  contract files under `contracts/`.
- **Starknet address checksum verification** — delegated to
  `normalizeStarknetAddress` in `src/utils/address.ts`. This module only
  ensures the input is a valid hex string before passing it to the normalizer.
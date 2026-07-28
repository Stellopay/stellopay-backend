# Validation — Schema Definitions & Error Mapping

Source of truth: [`src/utils/validation.ts`](../../src/utils/validation.ts)

## Contract

This module provides the shared schemas and error-mapping helpers used by every
route handler that validates request parameters. All of the following are
exported:

| Export | Kind | Purpose |
|---|---|---|
| `StarknetAddress` | `z.ZodString` → transform | Parse + normalize a Starknet hex address |
| `AgreementId` | `z.ZodString` | Parse a numeric-string agreement identifier |
| `parsePagination` | function | Clamp `limit`/`offset` query params to safe defaults |
| `loggedParse` | function | Parse + log structured diagnostics on failure |
| `formatValidationError` | function | Map a caught error to the standard API JSON shape |
| `mapZodError` | function | Return the first issue of a validation failure |
| `previewInput` | function | Build a bounded, sanitized preview of an untrusted value |
| `isPlainObject` | type guard | Is a value safe to index by key? |
| `isValidationError` | type guard | Is a caught value a validation failure? |
| `ValidationError` | class | The error thrown by `loggedParse` |
| `ValidationErrorOptions` | interface | Constructor options for `ValidationError` |
| `ValidationErrorMetric` | interface | Structured diagnostic attached to every failure |
| `ValidationIssue` | interface | One issue; structurally compatible with `z.ZodIssue` |
| `ValidationErrorResponse` | interface | Return type of `formatValidationError` |
| `MAX_PAGE_LIMIT` | `number` (= 100) | Upper bound for pagination limit |
| `DEFAULT_PAGE_LIMIT` | `number` (= 50) | Fallback pagination limit |
| `INPUT_PREVIEW_MAX_LENGTH` | `number` (= 40) | Max characters of input echoed into diagnostics |

## Security boundary

These invariants are what the rest of the backend is allowed to rely on. They
are asserted directly in [`validation.test.ts`](../../src/utils/validation.test.ts)
so they cannot drift silently.

### 1. A validation failure is always a client error

`ValidationError.status` is clamped to `400`–`499` and defaults to `400`.
Anything else — a `2xx`, a `5xx`, a negative number, a float, `NaN`,
`Infinity`, a non-number, or `undefined` — collapses to `400`.

This matters because the global error handler in
[`src/index.ts`](../../src/index.ts) replays `err.status` verbatim for
non-`ZodError` errors. Without the clamp, a caller that constructs a
`ValidationError` with `status: 200` would turn a rejected request into a
fail-open success, and one with `status: 500` would misreport a client mistake
as a server fault (and page the on-call for it).

```typescript
new ValidationError({ ...opts, status: 422 }).status; // 422 — preserved
new ValidationError({ ...opts, status: 200 }).status; // 400 — cannot fail open
new ValidationError({ ...opts, status: 503 }).status; // 400 — stays a client error
```

### 2. Diagnostics never carry a raw payload

Every `input` recorded on a `ValidationError` or written to the log goes
through `previewInput`, which:

1. echoes **strings only** — every other type is rendered via `String()`, so a
   request body becomes `"[object Object]"` rather than its contents (a body
   holding a token or a password is never written to the log stream);
2. replaces **control characters** (`U+0000`–`U+001F`, `U+007F`–`U+009F`)
   with a space, so a crafted input cannot embed a newline and forge a second
   `[validation:error]` record in a downstream plain-text log sink;
3. **truncates** to `INPUT_PREVIEW_MAX_LENGTH` (40) characters;
4. **never throws** — a `null`-prototype object or a value whose `toString`
   throws degrades to `"[unserializable]"`.

Point 4 is a boundary, not a nicety: before it, `String(Object.create(null))`
threw a `TypeError` out of `loggedParse`, converting a 400 into an unhandled
500 and losing the diagnostic entirely.

```typescript
previewInput("0x1234");                 // "0x1234"
previewInput({ password: "hunter2" });  // "[object Object]"
previewInput("a\n[validation:error] "); // "a [validation:error] "
previewInput(Object.create(null));      // "[unserializable]"
```

### 3. `formatValidationError` emits only two shapes

A `ZodError` or a `ValidationError` yields
`{ error: "Validation failed", details }`. **Everything else** yields
`{ error: "Invalid request" }` with no `details`, so an unexpected internal
error never leaks its message, stack, or connection details to a client.

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

This function **never throws**. Every input is gracefully degraded, and both
returned values are always *safe* integers (`Number.isSafeInteger`) inside the
documented bounds:

| Input | Behaviour |
|---|---|
| Missing / `undefined` / `null` query | Defaults: `{ limit: 50, offset: 0 }` |
| Non-object query (string, number, array, boolean) | Defaults |
| `limit` or `offset` is `null` / `""` | Treated as `undefined` → falls back to default |
| `limit` > `MAX_PAGE_LIMIT` | Clamped down to `MAX_PAGE_LIMIT` (100) |
| `limit` < 1 | Clamped up to `1` |
| `offset` < 0 | Clamped up to `0` |
| Non-numeric strings (`"abc"`, `"1.5"`) | Fall back to default via `.catch()` |
| `Infinity` / `NaN` | Fall back to default (rejected by `.int()`) |
| Beyond `Number.MAX_SAFE_INTEGER` (`"1e20"`) | Fall back to default, **not** clamped |
| Array values | Single-element arrays coerce; multi-element fall back to default |
| Object / boolean values | Fall back to default |

The safe-integer rule is deliberate. `"1e20"` has no fractional part, so it
passes Zod's `.int()`, but it cannot be represented exactly; clamping it would
hand a lossy number to the query layer. The documented default is the safer
answer, and it is the same answer the caller gets for `"abc"`.

```typescript
parsePagination({ limit: "5000" })   // { limit: 100, offset: 0 }
parsePagination({ offset: "-3" })    // { limit: 50, offset: 0 }
parsePagination({ limit: "1e20" })   // { limit: 50, offset: 0 }
parsePagination(null)                // { limit: 50, offset: 0 }
parsePagination("not-an-object")     // { limit: 50, offset: 0 }
```

## Logged Parse

### `loggedParse(schema, value, validatorName)` → `T`

Wraps any Zod schema with structured error logging. On failure:

1. Logs one JSON entry via `console.warn` with the `[validation:error]` prefix
2. Log payload (`ValidationErrorMetric`): `validator`, `input` (sanitized
   preview, see above), `error` (semicolon-joined issue messages), `timestamp`
3. Throws a `ValidationError` carrying the same metric, the issue list, a
   `400` status, and the original `ZodError` as `cause`

```typescript
const address = loggedParse(StarknetAddress, raw, "createAgreement");

// On failure logs:
// [validation:error] {"validator":"createAgreement","input":"0xbad...","error":"...","timestamp":"..."}
```

Note that `loggedParse` throws a `ValidationError`, **not** the bare
`ZodError`. A handler that catches with `instanceof z.ZodError` will therefore
miss it — use `formatValidationError` or `isValidationError`, both of which
recognize either type.

## Error Mapping

### `formatValidationError(error)` → `ValidationErrorResponse`

Maps a caught value to the standard API error shape used across all routes:

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
// ZodError or ValidationError
{ "error": "Validation failed", "details": [{ "code": "invalid_type", "...": "..." }] }

// Anything else
{ "error": "Invalid request" }
```

### `mapZodError(error)` → `ValidationIssue | undefined`

Returns the first issue of a `ZodError` or a `ValidationError`, or `undefined`
for anything else (including a validation failure with an empty issue list).
Useful when a route wants to branch on a single issue's `code`.

### `isValidationError(error)` → `boolean`

Type guard for `ValidationError`. Prefer it over `instanceof` at module
boundaries: it also accepts an error that crossed a bundling or duplicate
dependency boundary, where the class identity differs but the contract (name
`ValidationError` + an `issues` array) still holds.

## Error Handling Architecture

1. **Zod schemas throw `ZodError`** on invalid input; **`loggedParse` throws
   `ValidationError`** with the `ZodError` as `cause`
2. **Route handlers** either:
   - Catch the error inline and return 400 via `formatValidationError`
     (e.g. `backfill-events.ts`)
   - Let the error propagate to the global error handler
3. **Global error handler** (`src/index.ts`) detects `instanceof ZodError` and
   responds with HTTP 400 attaching `err.issues` as `details`; for any other
   error it replays `err.status` (defaulting to 500). A `ValidationError`
   therefore lands on a 400 with a populated `details` list, because its
   `status` is clamped into the 4xx range and its `issues` is always an array

## Edge Cases (Intentionally Out of Scope)

- Custom `ZodIssue` formatting for specific API versions
- Automatic i18n of error messages
- Async validation schemas
- Field-level allow/deny lists (a validator says whether a value is *well
  formed*, never whether a caller is *entitled* to it — that decision stays in
  the auth middleware)
- Redacting values that are well formed but sensitive (e.g. a valid session
  token echoed in `input`): the preview is bounded and sanitized, but a
  40-character string input is still echoed verbatim into the log stream
- Integration testing of the global error handler with every schema

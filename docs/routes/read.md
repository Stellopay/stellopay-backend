# Read Route Contract

All read-only data access lives in `src/routes/read.ts`. This document is the
single source of truth for request/response shapes, error handling, and
backward-compatibility guarantees.

## Shared helpers

### `CursorPaginationSchema`

Validates cursor-based pagination query parameters used by streaming/listing
endpoints.

```typescript
export const CursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
```

| Field  | Type                  | Default | Constraint     |
| ------ | --------------------- | ------- | -------------- |
| cursor | `string \| undefined` | —       | Passed through |
| limit  | `number`              | 50      | integer, 1–100 |

### `BatchReadSchema`

Validates a batch-read request body for fetching multiple discrete items.

```typescript
export const BatchReadSchema = z.object({
  ids: z.array(z.coerce.bigint().positive()).min(1).max(50),
});
```

| Field | Constraint                               |
| ----- | ---------------------------------------- |
| ids   | Non-empty array, max 50 positive bigints |

### `PaginatedReadResponse<T>`

Standard envelope returned by all cursor-paginated endpoints.

```typescript
export interface PaginatedReadResponse<T> {
  data: T[]; // always an array (may be empty)
  nextCursor: string | null; // null when no more pages
  hasMore: boolean; // true iff nextCursor is non-null
  limit: number; // mirrors validated input or default
}
```

**Backward-compatibility guarantee:** The shape of `PaginatedReadResponse` will
not change without a major version bump. Existing consumers that destructure
`data`, `nextCursor`, `hasMore`, or `limit` will continue to work.

---

## Token routes

### `GET /token/:token/balance/:owner`

Returns the ERC-20 balance for an owner address.

| Param | Constraint          |
| ----- | ------------------- |
| token | `z.string().min(3)` |
| owner | `z.string().min(3)` |

**Success response (200):**

```json
{ "token": "0xabc", "owner": "0xdef", "balance": "1000" }
```

**Error responses:**

- `400` — invalid address (< 3 chars)
- `500` — unexpected RPC result shape or RPC failure

### `GET /token/:token/decimals`

Returns the number of decimals for an ERC-20 token.

**Success response (200):**

```json
{ "token": "0xabc", "decimals": 6 }
```

**Error responses:**

- `400` — invalid address
- `500` — empty/undefined RPC result

### `GET /token/:token/symbol`

Returns the ERC-20 symbol, decoded from Cairo short-string when possible.

**Success response (200):**

```json
{ "token": "0xabc", "symbol": "USDC" }
```

If `decodeShortString` throws, the raw RPC value is returned as-is.

**Error responses:**

- `400` — invalid address
- `500` — empty RPC result

---

## Escrow routes

### `GET /escrow/:address/balance/:agreement_id`

Returns the balance for a specific agreement within an escrow contract.

**Success response (200):**

```json
{ "escrow": "0x1234", "agreement_id": "1", "balance": "5000" }
```

### `GET /escrow/:address/summary/:agreement_id`

Returns a UI-friendly summary including token address, employer, and balance.

**Success response (200):**

```json
{
  "escrow": "0x1234",
  "agreement_id": "1",
  "employer": "0xabcd",
  "token": "0x3039",
  "balance": "2000000"
}
```

---

## Agreement route

### `GET /agreement/:address/summary/:agreement_id`

Returns the full agreement details (employer, contributor, amounts, status).

**Success response (200):**

```json
{
  "agreement": "0x5678",
  "agreement_id": "2",
  "employer": "0x64",
  "contributor": "0x200",
  "token": "0x12c",
  "escrow": "0x190",
  "total_amount": "1000",
  "paid_amount": "500",
  "status": 1,
  "mode": 0,
  "dispute_status": 2
}
```

**Enum values:**

- `mode`: 0 = Escrow, 1 = Payroll
- `dispute_status`: 0 = None, 1 = Raised, 2 = Resolved

---

## Error handling

All routes follow the same pattern:

1. Input is validated via Zod. Validation failures propagate as `500` via
   Express `next(e)`.
2. RPC calls are wrapped in `try/catch`. On failure, structured telemetry is
   logged and the error is forwarded via `next(e)`.
3. The global error handler (in `src/index.ts`) returns a JSON envelope:
   `{ "error": "<message>" }`.

## Telemetry

Every route emits a structured log entry via `logReadTelemetry` with:

- `operation` — e.g. `erc20_balance_of`, `escrow_get_summary`
- `duration_ms` — wall-clock milliseconds
- `status` — `"success"` or `"error"`
- Optional context: `token`, `owner`, `escrow`, `agreement`, `agreement_id`,
  `request_id`

Log format is controlled by `env.LOG_FORMAT` (`"json"` or `"pretty"`).

## Edge cases intentionally out of scope

- Pagination of token routes (not yet needed; balance is a single value)
- Partial batch failures (batch schema enforces all-or-nothing)
- Rate limiting (handled by `src/middleware/rate-limit.ts`)

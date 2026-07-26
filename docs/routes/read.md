# Read Route Documentation

This document defines the strict contracts for pagination and batching across
`src/routes/read.ts` and its consumers, and the **reliability contract** that
every on-chain RPC read in this module follows.

## Cursor-Based Pagination

When an endpoint supports cursor-based pagination to read streams of events
or records, it MUST use `CursorPaginationSchema` to validate the incoming
query parameters.

```typescript
export const CursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
```

- **limit**: Caps results per page. Minimum 1, Maximum 100, Default 50.
- **cursor**: A string representing the starting position for the next page.

The successful response MUST match the generic `PaginatedReadResponse<T>` shape:

```typescript
export interface PaginatedReadResponse<T> {
  data: T[]; // The actual array of records
  nextCursor: string | null; // The cursor to use for the next page, or null if there are no more pages
  hasMore: boolean; // True if there are more records remaining
  limit: number; // The limit that was applied to the query
}
```

## Batching

When reading multiple discrete items by their ID (e.g. fetching summaries for
multiple agreements), endpoints MUST use `BatchReadSchema` to prevent
oversized queries or resource exhaustion.

```typescript
export const BatchReadSchema = z.object({
  ids: z.array(z.coerce.bigint().positive()).min(1).max(50),
});
```

- **ids**: A non-empty array of positive bigints.
- **Max Batch Size**: Hardcoded to 50 items per request to keep RPC calls
  and database lookups constrained.

## Reliability — Bounded Read Retry

Every Starknet RPC read exported by `src/routes/read.ts` is wrapped in a
bounded retry policy defined by {@link withReadRetry}. This layer sits **on
top of** the multi-RPC failover already implemented in
`src/starknet/client.ts` so a transient failure on every configured
endpoint still surfaces as a single retryable error.

### Retry policy

| Knob                  | Default | Source                              |
| --------------------- | ------- | ----------------------------------- |
| `enabled`             | `true`  | `READ_RETRY_ENABLED`                |
| `maxAttempts`         | `3`     | `READ_RETRY_MAX_ATTEMPTS`           |
| `baseDelayMs`         | `50`    | `READ_RETRY_BASE_DELAY_MS`          |
| `maxDelayMs`          | `500`   | `READ_RETRY_MAX_DELAY_MS`           |

Backoff between attempts is exponential with ±20 % jitter:
`delay = min(maxDelayMs, baseDelayMs * 2^(attempt - 2) * jitter)`.
Cancelling via `AbortSignal` aborts the backoff sleep, throwing
`Error("aborted")` so the caller can drop the in-flight request.

### What counts as a retryable error

The retry layer retries **transport-level** errors and treats local
**deterministic** errors as fail-fast:

- **Retried:**
  - `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EPIPE`, `ECONNREFUSED`,
    `EAI_AGAIN`
  - `network`, `fetch`, `timeout`, `temporary`/`temporarily`
  - Starknet-node transient 5xx-like: `try again`, `5\d\d`, `internal
    server`, `service unavailable`
- **Fail-fast (zero retries):**
  - `"Unexpected … result: …"` (provider returned data that didn't match
    our schema)
  - `"Contract not found"`, `"Contract missing"`
  - Caller-side validation errors (`"Invalid Starknet address"`, `"is
    required"`, `"must be a hex"`)

The default classification lives in {@link isRetriableRpcError} inside
`src/routes/read.ts`.

### Telemetry

Every route handler emits exactly **one** `[read-telemetry]` log entry per
request, containing:

- `operation` — e.g. `erc20_balance_of`, `escrow_get_summary`
- `duration_ms` — wall-clock time of the route handler
- `status` — `"success"` or `"error"`
- `retries` — number of retry rounds that fired (0 on first-try success,
  `maxAttempts - 1` at exhaustion). The single entry folds the retry
  count instead of emitting one warn line per retry attempt so a flaky
  provider doesn't drown the log stream.
- `request_id`, `token`, `owner`, `escrow`, `agreement`, `agreement_id`
  (as applicable)
- `error` — present only on the error path

The auth subsystem uses a *separate* helper in
`src/auth/session-retry.ts` and emits one `session.revoke_retry` warn line
per retry. Read paths intentionally follow the **single folded-entry**
style because read traffic is much higher volume than revoke/sweep
traffic and per-retry log lines would be a noisy regression.

### Disconnect-safe retries

Each route constructs an `AbortSignal` via
`makeRequestAbortSignal(req)` that aborts when the HTTP client closes
the connection before the response is sent. Under `NODE_ENV === "test"`
the helper returns a never-aborting signal so supertest doesn't trip the
abort path on the normal end-of-response close.

#### What the abort actually cancels

`provider.callContract` (Starknet.js `RpcProvider`) does NOT honour an
`AbortSignal` natively, so an in-flight RPC call will run to completion
even after the client disconnects. What the signal does cancel:

- the **backoff sleep** between retry attempts (so the next attempt
  isn't started),
- any **pending `withReadRetry` start** if the signal is already
  aborted when the loop is entered,

and the route handler logs the abort through the standard `Error("aborted")`
error path. This is intentional: aborting an already-dispatched JSON-RPC
in flight would just lose the work; routing the next retry through the
abort path is enough to ensure the client sees no useful response.

### Idempotency of retries

Read routes are reads — replaying them against the same on-chain state
yields the same result. The retry layer is therefore safe to invoke
under retries without an explicit idempotency key. **Write paths** in
`src/routes/escrow.ts`, `src/routes/agreement.ts`, and the transaction
flows are NOT covered here; those need different idempotency primitives
(see "Out of scope" below).

## Out of scope (intentionally not addressed in this module)

These items remain on the backlog and are explicitly NOT changed by
`src/routes/read.ts`:

- **Wire-up of `CursorPaginationSchema` / `BatchReadSchema`** into actual
  paginated route handlers. The schemas are exported and documented for
  future paged read endpoints; the current routes are single-shot
  summary reads.
- **Retry / idempotency for write paths.** `src/routes/escrow.ts` and
  the transaction endpoints need write-side retry primitives that
  account for nonce, fee, and idempotency keys — this PR doesn't touch
  them.
- **Retry-After on 429 responses.** Already handled by
  `src/middleware/rate-limit.ts`; this module leaves that as-is.
- **Background refresh / push-based invalidation** of cached reads.
- **Shared `try/catch` telemetry helper** across read routes. The current
  handlers keep their explicit per-route telemetry blocks because they
  expose operation-specific context fields that don't generalize cleanly.
- **Cross-RPC correlation / distributed tracing.** Retry attempts are
  scoped to a single `request_id`; they do not yet emit per-attempt
  spans.
- **Cumulative retry budgets per request.** Each individual call has its
  own budget; a worst-case parallel summary exhausts
  `9 calls × (maxAttempts - 1)` retries. Acceptable for the current
  module size, lifted later if read load changes.

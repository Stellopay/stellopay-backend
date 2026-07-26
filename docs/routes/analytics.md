# Analytics Route Contract

All analytics aggregation lives in `src/routes/analytics.ts`. This document is
the single source of truth for the request/response shapes, idempotency
guarantees, sign conventions, and edge cases.

## Endpoint

```
GET /api/v1/analytics/:user_address?year=<number>
```

### Path parameters

| Parameter    | Type     | Constraint                                                          |
| ------------ | -------- | ------------------------------------------------------------------- |
| user_address | `string` | Valid Starknet address (validated via `StarknetAddress` Zod schema) |

### Query parameters

| Parameter | Type     | Default      | Constraint         |
| --------- | -------- | ------------ | ------------------ |
| year      | `number` | current year | integer, 2020–2100 |

### Headers

| Header          | Direction | Description                                                      |
| --------------- | --------- | ---------------------------------------------------------------- |
| `If-None-Match` | request   | ETag from a previous response; triggers 304 if matched           |
| `ETag`          | response  | SHA-256 hash of the response payload (truncated to 16 hex chars) |
| `Cache-Control` | response  | Always `private, max-age=60`                                     |

---

## Idempotency contract

This is a **pure read** endpoint. Identical requests (`user_address` + `year`)
always produce the same response. Three mechanisms enforce this:

### 1. ETag / 304 Not Modified

The route computes an `ETag` from the response JSON. If the client sends
`If-None-Match` matching the ETag, the route returns `304` with no body. This
handles retries cleanly: the client gets a fast no-op instead of re-transferring
the full payload.

### 2. Cache-Control

Every successful response includes `Cache-Control: private, max-age=60`. This
prevents thundering-herd re-queries from the same client within a minute. The
`private` directive ensures intermediate caches (CDNs, proxies) do not cache
user-specific financial data.

### 3. Concurrent deduplication (409)

If a duplicate request for the same `user_address:year` arrives while a
previous request is still in flight (within a 5-second window), the route
returns:

```json
{ "error": "Duplicate rollup in progress — retry after a few seconds" }
```

with HTTP status **409 Conflict**. This prevents multiple concurrent DB
round-trips for the same data. The lock is released when the first request
completes (success or error).

---

## Response shape

```json
{
  "year": 2026,
  "data": [
    { "month": "Jan", "views": 0 },
    { "month": "Feb", "views": 0 },
    { "month": "Mar", "views": 4 },
    { "month": "Apr", "views": -3 },
    { "month": "May", "views": 4 },
    { "month": "Jun", "views": 2 },
    { "month": "Jul", "views": 0 },
    { "month": "Aug", "views": 0 },
    { "month": "Sept", "views": 10 },
    { "month": "Oct", "views": 0 },
    { "month": "Nov", "views": 0 },
    { "month": "Dec", "views": 0 }
  ],
  "total": 17
}
```

| Field | Type           | Description                                                |
| ----- | -------------- | ---------------------------------------------------------- |
| year  | `number`       | Calendar year queried                                      |
| data  | `ChartMonth[]` | Exactly 12 entries (Jan → Dec), zero-filled                |
| total | `number`       | Lossless sum of every month's raw BigInt amount, formatted |

### `ChartMonth`

| Field | Type     | Description                                                 |
| ----- | -------- | ----------------------------------------------------------- |
| month | `string` | Abbreviated label: `"Jan"` … `"Dec"`                        |
| views | `number` | Net aggregated financial value (see sign conventions below) |

> **Name note:** The field is named `views` for backward compatibility with
> existing consumers. It represents a **net monetary amount**, not a view count.

---

## Sign conventions

All values are aggregated in **BigInt space** and divided by
`10 ** DEFAULT_TOKEN_DECIMALS` (6) for display. Amounts are aggregated across
all tokens.

### Payments

| Direction | Condition                       | Sign |
| --------- | ------------------------------- | ---- |
| Incoming  | `payment.to === user_address`   | `+`  |
| Outgoing  | `payment.from === user_address` | `−`  |

If a user appears as both sender and receiver in the same month, the amounts
net correctly (e.g., +5 received − 2 sent = 3).

### Escrow events

| Event type | Sign | Rationale                     |
| ---------- | ---- | ----------------------------- |
| Funded     | `−`  | Employer sends funds out      |
| Released   | `+`  | Contributor receives funds    |
| Refunded   | `+`  | Employer receives refund back |

### Agreement creation proxy

Each `AgreementCreated` event adds **1000 base units** (≈ 0.001 display value)
to the month. This proxy is **only applied when no payment or escrow data
exists for that month** — real financial data always takes precedence.

---

## Error responses

| Status | Condition                        | Body                                                 |
| ------ | -------------------------------- | ---------------------------------------------------- |
| 400    | Invalid `user_address` or `year` | `{ "error": "Validation failed", "details": [...] }` |
| 409    | Duplicate request in flight      | `{ "error": "Duplicate rollup in progress — ..." }`  |
| 500    | DB failure or unexpected error   | `{ "error": "<message>" }`                           |

---

## Telemetry

Every invocation emits a structured log entry via `logAnalyticsTelemetry`:

- `operation`: always `"analytics_monthly_rollup"`
- `duration_ms`: wall-clock milliseconds for the entire handler
- `status`: `"success"` or `"error"`
- `request_id`: correlation ID (when set by middleware)
- `user_address`: normalized Starknet address
- `year`: queried year (success only)
- `row_counts`: `{ payments, escrow_events, agreement_creations }` (success only)
- `error`: error message (error only)

Log format is controlled by `env.LOG_FORMAT` (`"json"` or `"pretty"`).

---

## Edge cases intentionally out of scope

| Item                             | Reason                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Token-specific breakdown         | Amounts are aggregated across all tokens with `DEFAULT_TOKEN_DECIMALS`; per-token aggregation requires schema changes. |
| Persistent caching / memoization | In-flight dedup + ETag/304 + Cache-Control cover the main idempotency cases; persistent caching is a separate concern. |
| Pagination                       | The response is a fixed 12-month window; no pagination needed.                                                         |
| WCAG / accessibility             | Not applicable to this server-side route.                                                                              |

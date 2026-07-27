# Analytics Route Contract

All analytics aggregation lives in `src/routes/analytics.ts`. This document is
the single source of truth for the request/response shapes, idempotency
guarantees, sign conventions, and edge cases.

Exposes `GET /api/v1/analytics/:user_address` — a monthly aggregation rollup that combines:

- **Payment events** (direct P2P transfers),
- **Escrow events** (Funded / Released / Refunded), and
- **Agreement creation events** (proxy for platform activity).

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

### Performance characteristics

The three DB queries (payments, escrow events, agreement creations) are **independent** — they share no result dependency. The route fires them via `Promise.all()` so the wall-clock latency is `max(T_payments, T_escrow, T_agreements)` instead of the sum of the three.

Monthly BigInt amounts are converted to display numbers using a **precomputed divisor** (`10 ** DEFAULT_TOKEN_DECIMALS`) rather than calling `formatTokenAmount` 13 times per request. This eliminates repeated string formatting, BigInt exponentiation, and regex replacement per rollup.

The `MONTH_NAMES` constant is hoisted to module scope to avoid re-allocation on every request.

### Backward compatibility

- **Response shape**: unchanged — `{ year, data: ChartMonth[], total }`.
- **Sign conventions**: unchanged — all payments are summed as positive; escrow Funded is negative, Released/Refunded are positive.
- **Agreement creation proxy**: unchanged — adds `count * 1000` base units to months with no payment or escrow data.
- **`views` field name**: preserved for backward compatibility; represents a net monetary amount.

---

## Contract

### Endpoint

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

### Response shape

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

### Sign conventions

All values are aggregated in **BigInt space** and converted via the precomputed
`DISPLAY_DIVISOR` (= `10 ** 6`). Amounts are aggregated across all tokens.

#### Payments

| Direction | Condition                      | Sign |
| --------- | ------------------------------ | ---- |
| All       | `payment.from` or `payment.to` | `+`  |

Payments are summed as positive regardless of direction. Netting across
incoming/outgoing in the same month produces the correct aggregate.

#### Escrow events

| Event type | Sign | Rationale                     |
| ---------- | ---- | ----------------------------- |
| Funded     | `−`  | Employer sends funds out      |
| Released   | `+`  | Contributor receives funds    |
| Refunded   | `+`  | Employer receives refund back |

#### Agreement creation proxy

Each `AgreementCreated` event adds **1000 base units** (≈ 0.001 display value)
to the month. This proxy is **only applied when no payment or escrow data
exists for that month** — real financial data always takes precedence.

---

## Input Validation & Input Hardening

- **`user_address` (path param)**:
  - Validated via `StarknetAddress` Zod schema (hex string up to 64 chars, optional `0x` prefix).
  - Transformed into canonical normalized hex address before database querying.
  - Invalid formats throw a `ZodError` mapped to HTTP 400 before database execution.
- **`year` (query param)**:
  - Validated via `AnalyticsQuerySchema`.
  - Must be an integer within the range `2020` to `2100`.
  - Empty values (`""`, `null`, `undefined`) fall back gracefully to the current year (`new Date().getFullYear()`).
  - Malformed strings, non-integers (e.g. `2026.5`), or out-of-range years (`1999`, `3000`) throw a `ZodError` mapped to HTTP 400.

---

## Data Aggregation Robustness

- **Safe Amount Parsing (`parseBigIntSafe`)**:
  - Raw amount values from database rows (`payments`, `escrowEvents`) are safely parsed using `parseBigIntSafe`.
  - Missing, `null`, `undefined`, or unparseable string values fall back to `0n` instead of throwing unhandled `TypeError` or `SyntaxError` exceptions.
- **Month Bounds Check (`isValidMonth`)**:
  - Extracted month values are checked via `isValidMonth(month)` to ensure they are integers between `1` and `12`.
  - Any corrupted or out-of-bound month values are safely skipped without corrupting chart data or array indexing.

---

## Idempotency contract

Every invocation of the rollup endpoint is instrumented. Telemetry fires **after all three DB queries complete** (success path) or **inside the catch block for non-Zod errors** (error path), and respects global `LOG_FORMAT` and `LOG_LEVEL` settings. Zod 400 validation failures do not emit DB error telemetry.

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

**Success:**

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

**Error (DB failure):**

```json
{
  "timestamp": "2026-07-26T18:47:05.456Z",
  "level": "error",
  "operation": "analytics_monthly_rollup",
  "duration_ms": 1204.88,
  "status": "error",
  "request_id": "req-abc-001",
  "user_address": "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
  "error": "DB connection lost"
}
```

### `ChartMonth`

| Field | Type     | Description                                                 |
| ----- | -------- | ----------------------------------------------------------- |
| month | `string` | Abbreviated label: `"Jan"` … `"Dec"`                        |
| views | `number` | Net aggregated financial value (see sign conventions below) |

> **Name note:** The field is named `views` for backward compatibility with
> existing consumers. It represents a **net monetary amount**, not a view count.

---

## Sign conventions

| Field          | Type                    | Present on | Description                                        |
| -------------- | ----------------------- | ---------- | -------------------------------------------------- |
| `timestamp`    | ISO 8601 string         | always     | Log emission time                                  |
| `level`        | `"info"` / `"error"`    | always     | Log severity                                       |
| `operation`    | string                  | always     | `"analytics_monthly_rollup"`                       |
| `duration_ms`  | number                  | always     | End-to-end query + aggregation latency             |
| `status`       | `"success"` / `"error"` | always     | Outcome                                            |
| `request_id`   | string                  | when set   | Correlation ID from `res.locals.requestId`         |
| `user_address` | string                  | always     | Normalized Starknet address                        |
| `year`         | number                  | success    | Year used for date range filter                    |
| `row_counts`   | object                  | success    | `{ payments, escrow_events, agreement_creations }` |
| `error`        | string                  | error      | Error message                                      |

---

## Error responses

| Status | Condition                        | Body                                                 |
| ------ | -------------------------------- | ---------------------------------------------------- |
| 400    | Invalid `user_address` or `year` | `{ "error": "Validation failed", "details": [...] }` |
| 500    | DB failure or unexpected error   | `{ "error": "<message>" }`                           |

---

## Security & Reliability Notes

- `duration_ms` is total DB round-trip time for all three queries, useful as a latency gauge against slow queries or pool exhaustion.
- `row_counts` is a diagnostic metric; it does not leak per-row data or PII.
- `user_address` in logs is the **normalized** form; no raw user input appears in logs.
- Unparseable amounts or malformed DB rows default to zero rather than crashing the endpoint with a 500 error.

---

## Edge cases intentionally out of scope

| Item                      | Reason                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-query timers          | All three queries run in parallel via `Promise.all()`; the aggregate duration is sufficient for diagnosing slow paths. Per-query breakdown can be added if needed. |
| Token-specific breakdowns | Amounts are aggregated across all tokens with `DEFAULT_TOKEN_DECIMALS`; per-token aggregation requires schema changes.                                             |
| Caching / memoization     | No caching is applied at the route layer; the route is a pure read that should reflect fresh DB state.                                                             |
| WCAG / accessibility      | Not applicable to this server-side route.                                                                                                                          |

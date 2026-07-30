# Analytics Route Contract

All analytics aggregation lives in `src/routes/analytics.ts`. This document is
the single source of truth for the request/response shapes, idempotency
guarantees, sign conventions, and edge cases.

Exposes `GET /api/v1/analytics/:user_address` — a monthly aggregation rollup
that combines:

- **Payment events** (direct P2P transfers),
- **Escrow events** (Funded / Released / Refunded), and
- **Agreement creation events** (proxy for platform activity).

```
GET /api/v1/analytics/:user_address?year=<number>
```

---

## Endpoint

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
| `x-user-address` | request  | Caller's Starknet wallet address (required by `requireAuth`)     |
| `authorization` | request  | `Bearer <session-token>` issued by `/auth/verify` (required)     |
| `If-None-Match` | request   | ETag from a previous response; triggers 304 if matched           |
| `ETag`          | response  | SHA-256 hash of the response payload (truncated to 16 hex chars) |
| `Cache-Control` | response  | Always `private, max-age=60`                                     |

---

## Authorization

The route is mounted behind `requireAuth`, which resolves the caller's
Starknet address from the `x-user-address` header and validates the bearer
session token. A second middleware, `requireAnalyticsOwner`, enforces that the
authenticated principal may only read rollups for their own address.

### Middleware chain

```
analyticsRouter.use("/analytics", requireAuth);
analyticsRouter.get("/analytics/:user_address", requireAnalyticsOwner, handler);
```

### Contract

1. `requireAuth` runs first. It reads `x-user-address` and `authorization`
   headers verbatim. On any failure it responds `401 { error: "Unauthorized" }`
   and does **not** call `next()`. On success it sets `req.auth = { address,
   token }` and calls `next()`.

2. `requireAnalyticsOwner` runs next. It normalizes both the path parameter
   (`:user_address`) and the principal's address via
   `normalizeStarknetAddress` so that padding and casing differences (e.g.
   `0x1`, `0x0001`, a valid checksum for the same address) cannot cause a
   false mismatch or a false grant.

   - If the path parameter cannot be normalized (invalid address), the request
     is passed through to the route handler, which rejects it with `400` via
     `StarknetAddress.parse`. This keeps a single source of truth for address
     validation.
   - If the normalized addresses do not match, the middleware responds
     `403 { error: "Forbidden" }` and does **not** call `next()`.

### Status matrix

| Condition                                         | Status | Body                        |
| ------------------------------------------------- | ------ | --------------------------- |
| No auth headers / invalid session                 | 401    | `{ error: "Unauthorized" }` |
| Authenticated but `:user_address` ≠ principal     | 403    | `{ error: "Forbidden" }`    |
| Invalid `:user_address` format                    | 400    | `{ error: "Validation failed", details: [...] }` |
| Valid request                                     | 200    | `{ year, data, total }`     |

### Security notes

- The cache key includes the normalized user address, so no caller can ever
  receive data scoped to a different identity (see `docs/routes/analytics.md`,
  "Idempotency contract" → "In-process aggregation cache").
- `Cache-Control: private` ensures intermediate caches do not store
  user-specific financial data.
- The `requireAnalyticsOwner` middleware is exported from `src/routes/analytics.ts`
  so it can be reused or tested independently.

---

## Response shape

### Success (200)

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

### Not Modified (304)

No body. ETag matching triggers a 304 via `If-None-Match`.

### Error responses

| Status | Condition                        | Body                                                                 |
| ------ | -------------------------------- | -------------------------------------------------------------------- |
| 400    | Invalid `user_address` or `year` | `{ "error": "Validation failed", "details": [...] }`                 |
| 401    | Missing/invalid auth headers or session | `{ "error": "Unauthorized" }`                                 |
| 403    | Principal ≠ requested `:user_address` | `{ "error": "Forbidden" }`                                    |
| 409    | Duplicate rollup in flight       | `{ "error": "Duplicate rollup in progress — retry after a few seconds" }` |
| 500    | DB failure or unexpected error   | `{ "error": "<message>" }`                                           |

---

## Sign conventions

All values are aggregated in **BigInt space** and converted via the precomputed
`DISPLAY_DIVISOR` (= `10 ** 6`). Amounts are aggregated across all tokens.

### Payments

| Condition                      | Sign | Rationale                     |
| ------------------------------ | ---- | ----------------------------- |
| `payment.from === userAddress` | `−`  | Outgoing payment (user paid)  |
| `payment.to === userAddress`   | `+`  | Incoming payment (user received) |
| Neither (third-party tx)       | `+`  | User is an intermediary       |

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

## Rollup batching contract

The endpoint does not expose client pagination. Internally, each of its three
event sources is read in batches of at most `ANALYTICS_ROLLUP_BATCH_SIZE` (500
rows). Pages use the ascending `(created_at, id)` keyset, with both fields
forming the cursor. This makes a timestamp tie deterministic and prevents offset
drift from skipping or repeating pre-existing rows as the tables grow.

The route continues until a short page is received. If a full page fails to
advance the cursor, it fails the request rather than looping indefinitely or
returning a silently incomplete rollup.

**Snapshot isolation:** There is no cross-query database snapshot. Events
committed while a rollup is in progress may be included if they sort after the
current cursor.

---

## Performance characteristics

The three DB queries (payments, escrow events, agreement creations) are
**independent** — they share no result dependency. The route fires them via
`Promise.all()` so the wall-clock latency is `max(T_payments, T_escrow,
T_agreements)` instead of the sum of the three.

Monthly BigInt amounts are converted to display numbers using a **precomputed
divisor** (`10 ** DEFAULT_TOKEN_DECIMALS`) rather than calling
`formatTokenAmount` 13 times per request.

The `MONTH_NAMES` constant is hoisted to module scope to avoid re-allocation on
every request.

---

## Input Validation & Input Hardening

- **`user_address` (path param)**:
  - Validated via `StarknetAddress` Zod schema (hex string up to 64 chars,
    optional `0x` prefix).
  - Transformed into canonical normalized hex address before database querying.
  - Invalid formats throw a `ZodError` mapped to HTTP 400 before database
    execution.
- **`year` (query param)**:
  - Validated via `AnalyticsQuerySchema`.
  - Must be an integer within the range `2020` to `2100`.
  - Empty values (`""`, `null`, `undefined`) fall back gracefully to the
    current year (`new Date().getFullYear()`).
  - Malformed strings, non-integers (e.g. `2026.5`), or out-of-range years
    (`1999`, `3000`) throw a `ZodError` mapped to HTTP 400.

---

## Data Aggregation Robustness

- **Safe Amount Parsing (`parseBigIntSafe`)**:
  - Raw amount values from database rows (`payments`, `escrowEvents`) are
    safely parsed using `parseBigIntSafe`.
  - Missing, `null`, `undefined`, or unparseable string values fall back to `0n`
    instead of throwing unhandled `TypeError` or `SyntaxError` exceptions.
- **Month Bounds Check (`isValidMonth`)**:
  - Extracted month values are checked via `isValidMonth(month)` to ensure they
    are integers between `1` and `12`.
  - Any corrupted or out-of-bound month values are safely skipped without
    corrupting chart data or array indexing.

---

## Idempotency contract

Every invocation of the rollup endpoint is instrumented. Telemetry fires
**after all three DB queries complete** (success path) or **inside the catch
block for non-Zod errors** (error path), and respects global `LOG_FORMAT`
settings. Zod 400 validation failures do not emit DB error telemetry.

### 1. In-process aggregation cache

Results are cached in memory via `AnalyticsCache` (TTL:
`ANALYTICS_CACHE_TTL_MS`, default 30 s). Identical requests within the TTL
window skip the database entirely. The cache key includes the normalized user
address and all query parameters, so different users or years never share a
cache slot. Failed responses are never cached.

### 2. ETag / 304 Not Modified

The route computes an `ETag` (truncated SHA-256 hex) from the response JSON.
If the client sends `If-None-Match` matching the ETag, the route returns `304`
with no body. This handles retries cleanly: the client gets a fast no-op instead
of re-transferring the full payload.

### 3. Cache-Control

Every successful response includes `Cache-Control: private, max-age=60`. This
prevents thundering-herd re-queries from the same client within a minute. The
`private` directive ensures intermediate caches (CDNs, proxies) do not cache
user-specific financial data.

### 4. Concurrent deduplication (409)

If a duplicate request for the same `user_address:year` arrives while a
previous request is still in flight, the route returns:

```json
{ "error": "Duplicate rollup in progress — retry after a few seconds" }
```

with HTTP status **409 Conflict**. The in-flight lock is released in a `finally`
block when the first request completes (success or error).

---

## Telemetry

| Field          | Type                    | Present on | Description                                        |
| -------------- | ----------------------- | ---------- | -------------------------------------------------- |
| `timestamp`    | ISO 8601 string         | always     | Log emission time                                  |
| `level`        | `"info"` / `"error"`    | always     | Log severity                                       |
| `operation`    | string                  | always     | `"analytics_monthly_rollup"`                       |
| `duration_ms`  | number                  | always     | End-to-end wall-clock time (queries + aggregation) |
| `status`       | `"success"` / `"error"` | always     | Outcome                                            |
| `request_id`   | string                  | when set   | Correlation ID from `res.locals.requestId`         |
| `user_address` | string                  | always     | Normalized Starknet address                        |
| `year`         | number                  | success    | Year used for date range filter                    |
| `row_counts`   | object                  | success    | `{ payments, escrow_events, agreement_creations }` |
| `error`        | string                  | error      | Error message                                      |

---

## Security & Reliability Notes

- `duration_ms` is the total wall-clock time for all three parallel queries plus
  aggregation — useful as a latency gauge against slow queries or pool exhaustion.
- `row_counts` is a diagnostic metric; it does not leak per-row data or PII.
- `user_address` in logs is the **normalized** form; no raw user input appears
  in logs.
- Unparseable amounts or malformed DB rows default to zero rather than crashing
  the endpoint with a 500 error.

## Shared cache (optional)

Set `REDIS_URL` to enable the Redis-backed analytics cache across backend
replicas. It uses the same `buildAnalyticsCacheKey` format and the configured
`ANALYTICS_CACHE_TTL_MS` expiry. When Redis is unset, the route keeps using the
in-process cache; Redis connection, serialization, and invalidation failures
are treated as cache misses so they do not turn into analytics errors. Use a
private Redis instance and TLS/credentials appropriate for the deployment.

---

## Edge cases intentionally out of scope

| Item                      | Reason                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-query timers          | All three queries run in parallel via `Promise.all()`; the aggregate duration is sufficient for diagnosing slow paths. Per-query breakdown can be added if needed. |
| Token-specific breakdowns | Amounts are aggregated across all tokens with `DEFAULT_TOKEN_DECIMALS`; per-token aggregation requires schema changes.                                             |
| WCAG / accessibility      | Not applicable to this server-side route.                                                                                                                          |

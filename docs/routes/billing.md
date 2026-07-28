# Billing Routes

## Overview

The billing routes are located under `/api/v1/billing/profiles/:profileId`. They are responsible for retrieving billing profile information, payment methods, invoice history, and reward-limit summaries.

All endpoints require:
1. `BILLING_ENABLED=true` in the environment.
2. A valid authentication session (see `src/auth/middleware.ts`).
3. The authenticated user's wallet address must match the billing profile's `ownerAddress`.

## Contract and Performance

The primary resource is the `BillingProfile`, loaded during authorization by the `requireBillingOwner` middleware.

- The `requireBillingOwner` middleware verifies ownership by loading the entire `BillingProfile` from the database.
- If ownership is verified, the profile is securely attached to `res.locals.profile`.
- Route handlers MUST use `res.locals.profile` rather than querying the database again for the profile, to avoid repeated I/O and unnecessary computation.

### Ownership denial contract

When the billing profile does not exist OR the caller is not the owner, the middleware responds with HTTP 404 and a generic "not found" message. The two cases are intentionally indistinguishable to the caller so attackers cannot enumerate billing profile IDs. The split is visible in logs only via the `billing.ownership.denied` event (see [Observability](#observability)).

### Profile ID validation

The `:profileId` path parameter must be a non-empty alphanumeric string (letters, digits, underscores, dashes only), 1–128 characters. Invalid values receive HTTP 400 without echoing the invalid input.

## Endpoints

### `GET /billing/profiles/:profileId`

Returns the full billing profile (with sensitive fields stripped), payment methods, and invoices in a single response.

### `GET /billing/profiles/:profileId/general-information`

Returns identity fields, with sensitive information stripped, plus a convenience `fullAddress` field.

**Contract:**
- Uses `res.locals.profile` from the middleware — does NOT re-query the database for the profile.
- Fetches payment methods and invoices in parallel via `Promise.all`.
- Strips `taxId` and `dateOfBirth` from the profile before serialisation.
- Emits a `billing.profile.fetched` event on success.
- Emits a `billing.amount.coerced` warning when invoice amounts are unusable (matching the behaviour of the `/invoices` route).
- On TOCTOU race (profile deleted between middleware and handler): responds with HTTP 404 without attempting DB queries.
- On DB failure: responds with HTTP 500.

**Response (`200`):**

```json
{
  "success": true,
  "data": {
    "profile": {
      "id": "profile-001",
      "ownerAddress": "0xabc123...",
      "profileType": "Individual",
      "firstName": "Alice",
      "lastName": "Example",
      "email": "alice@example.com",
      "street": "123 Main St",
      "city": "Metropolis",
      "state": "NY",
      "zipCode": "10001",
      "country": "US",
      "annualRewardLimit": "10000.000000",
      "usedAmount": "2500.500000",
      "currency": "USD",
      "createdAt": "…",
      "updatedAt": "…"
    },
    "paymentMethods": [ … ],
    "invoices": [ … ]
  }
}
```

- **GET `/billing/profiles/:profileId/summary`**
  Returns the reward-limit and spend summary, utilizing shared billing math
  logic for numeric fields (`parseBillingAmount`).

Sensitive fields (`taxId`, `dateOfBirth`) are never included in the response.

---

### `GET /billing/profiles/:profileId`

Returns the full billing profile (with sensitive fields stripped), the list of
payment methods, and the invoice history — all in a single response.

**Response (`200`):**

```json
{
  "success": true,
  "data": {
    "profile": {
      "id": "profile-001",
      "ownerAddress": "0xabc123...",
      "profileType": "Individual",
      "firstName": "Alice",
      "lastName": "Example",
      "email": "alice@example.com",
      "street": "123 Main St",
      "city": "Metropolis",
      "state": "NY",
      "zipCode": "10001",
      "country": "US",
      "annualRewardLimit": "10000.000000",
      "usedAmount": "2500.500000",
      "currency": "USD",
      "createdAt": "…",
      "updatedAt": "…"
    },
    "paymentMethods": [ … ],
    "invoices": [ … ]
  }
}
```

Sensitive fields (`taxId`, `dateOfBirth`) are never included in the response.

---

### `GET /billing/profiles/:profileId/general-information`

Returns identity / contact fields for the profile. Sensitive fields (`taxId`, `dateOfBirth`) are excluded.

**Contract:**
- Uses `res.locals.profile` from the middleware — does NOT re-query the DB.
- Strips `taxId` and `dateOfBirth`.
- Computes a convenience `fullAddress` string from non-null address components (street, city, state, zipCode, country). Returns `null` when every component is falsy.
- On TOCTOU race (profile deleted between middleware and handler): responds with HTTP 404.
- On DB failure: responds with HTTP 500.

**Response (`200`):**

```json
{
  "success": true,
  "data": {
    "id": "profile-001",
    "firstName": "Alice",
    "lastName": "Example",
    "email": "alice@example.com",
    "phone": "+1-555-0100",
    "street": "123 Main St",
    "city": "Metropolis",
    "state": "NY",
    "zipCode": "10001",
    "country": "US",
    "fullAddress": "123 Main St, Metropolis, NY, 10001, US",
    …
  }
}
```

`fullAddress` is `null` when every address component is falsy.

---

### `GET /billing/profiles/:profileId/payment-methods`

Returns the list of payment methods for the profile. Only masked/safe representations are stored and returned (`maskedAccount`, `maskedRouting`). Raw account numbers are never present in the API.

**Contract:**
- Queries the `billingPaymentMethods` table filtered by `profileId`.
- Returns an empty array when no payment methods exist (never `null`).
- The response includes `profileId` for caller convenience.
- On DB failure: responds with HTTP 500.

**Response (`200`):**

```json
{
  "success": true,
  "data": {
    "profileId": "profile-001",
    "paymentMethods": [
      {
        "id": "pm-1",
        "type": "bank_account",
        "displayName": "Chase ****1234",
        "maskedAccount": "****1234",
        "maskedRouting": "****5678",
        "isDefault": true,
        "createdAt": "2025-01-01T00:00:00.000Z",
        "updatedAt": "2025-06-01T00:00:00.000Z"
      }
    ]
  }
}
```

---

### `GET /billing/profiles/:profileId/invoices`

Returns the invoice history for the profile. Every invoice row is parsed through the safe `parseBillingAmount` helper so malformed amounts never propagate NaN into the aggregate telemetry. Supports optional pagination via `limit` and `offset` query parameters.

**Contract:**
- Queries the `billingInvoices` table filtered by `profileId`.
- The response body contains the raw rows unchanged — existing callers see exactly the same shape as before observability was added.
- A read-side aggregate (`summarizeInvoices`) is computed for telemetry only and is NOT written back to the database or returned in the response.
- When invoice amounts are unusable (missing, malformed, or negative): one `billing.amount.coerced` warning is emitted with a per-reason breakdown, and the `billing_amount_coerced_total` counter is bumped.
- The aggregate normalises invoice statuses to lowercase; unrecognised or null statuses are bucketed as `"unknown"` rather than widening the log key space with arbitrary values.
- On DB failure: responds with HTTP 500.

**Query parameters:**

| Parameter | Type    | Default | Max | Description                                              |
| --------- | ------- | ------- | --- | -------------------------------------------------------- |
| `limit`   | integer | —       | 200 | Maximum rows to return. When omitted, returns all rows.  |
| `offset`  | integer | 0       | —   | Number of rows to skip before returning results.         |

When neither `limit` nor `offset` is supplied, the response envelope omits the
`pagination` block (backward-compatible with earlier callers).

**Paginated response (`200`):**

```json
{
  "success": true,
  "data": {
    "profileId": "profile-001",
    "invoices": [ … ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "hasMore": true
    }
  }
}
```

`hasMore` is computed by fetching `limit + 1` rows and discarding the probe
row — no separate `COUNT` query.

**Ordering:** Invoices are returned in descending order by `createdAt` with
`id` as a tiebreaker, ensuring deterministic pagination even when rows share
the same timestamp.

**Unpaginated response (`200` — backward-compatible):**

```json
{
  "success": true,
  "data": {
    "profileId": "profile-001",
    "invoices": [ … ]
  }
}
```

---

### `GET /billing/profiles/:profileId/summary`

Returns a spend-limit summary computed from the profile's `annualRewardLimit` and `usedAmount` columns.

**Math contract:**

- Both columns are stored as `numeric(18,6)` and arrive as strings. They are parsed by `parseBillingAmount()`, which returns `0` for missing, malformed, or negative inputs and reports which of those three cases fired (see [Observability](#observability)).
- `remainingAmount = max(0, annualRewardLimit – usedAmount)` — clamped to zero so overruns never produce a negative remainder. The clamp hides an overrun from the response, so an overrun is reported through `billing.summary.limit_exceeded` instead.
- `progressPercentage` is `(usedAmount / annualRewardLimit) × 100`, rounded to 2 decimal places. When `annualRewardLimit` is `0`, progress is `0`. Progress is NOT clamped to 100% — a profile that exceeds its limit correctly reports > 100% progress.
- All intermediate arithmetic is rounded to 6 decimal places to stay within the column's declared scale.
- Each coerced column emits its own `billing.amount.coerced` event naming the offending field.

**Contract:**
- Uses `res.locals.profile` from the middleware — does NOT re-query the DB.
- On TOCTOU race (profile deleted between middleware and handler): responds with HTTP 404.
- On DB failure: responds with HTTP 500.

**Response (`200`):**

```json
{
  "success": true,
  "data": {
    "profileId": "profile-001",
    "profileType": "Individual",
    "annualRewardLimit": 10000,
    "usedAmount": 2500.5,
    "remainingAmount": 7499.5,
    "currency": "USD",
    "progressPercentage": 25.01
  }
}
```

## `parseBillingAmount` contract

The `parseBillingAmount(value: unknown): BillingAmount` function is the canonical parser for all `numeric(18,6)` columns in the billing module.

| Input                        | `amount` | `coercion`   |
| ---------------------------- | -------- | ------------ |
| `"2500.500000"`              | 2500.5   | `null`       |
| `"0.000000"`                 | 0        | `null`       |
| `null`, `undefined`, `""`    | 0        | `"missing"`  |
| `"abc"`, `"Infinity"`        | 0        | `"malformed"`|
| `"-1.5"`                     | 0        | `"negative"` |
| `42` (number, not string)    | 0        | `"missing"`  |
| `{}` (object)                | 0        | `"missing"`  |

## `summarizeInvoices` contract

`summarizeInvoices(rows: readonly { amount?: unknown; status?: unknown }[]): InvoiceTotals` is a read-side aggregate for telemetry only. Nothing is written back to the database and no response body changes.

**Aggregation rules:**
- Statuses are lower-cased. `"paid"` (case-insensitive) counts toward `paidAmount`; everything else — `pending`, `overdue`, `void`, an unrecognised status, or a null/blank status — counts toward `outstandingAmount`. Therefore `paidAmount + outstandingAmount === totalAmount` always holds.
- A null, non-string, or blank status is bucketed as `"unknown"` rather than widening the `statusCounts` key space with arbitrary values.
- Rows whose `amount` is unusable contribute `0` and are counted in `coercedCount`, with a per-reason breakdown in `coercionReasons`.
- All monetary aggregates are rounded to 6 decimal places.

## Observability

`src/routes/billing-metrics.ts` owns the telemetry side-channel for this module, in the same shape as `src/auth/session-metrics.ts`: one structured log line per decision, plus process-local counters. Nothing here changes a response body — the entire surface is additive, and every endpoint returns exactly what it returned before.

**Log format.** `logBillingEvent(level, event, data)` emits `{ timestamp, level, event, …data }` as JSON when `LOG_FORMAT=json` (the default), otherwise as a single `[billing] …` line. Events below `LOG_LEVEL` are dropped before serialization.

**Redaction.** Log payloads carry profile IDs, the caller address, bounded reason codes, row counts, durations, and the rounded monetary aggregates the routes already return. They never carry `taxId`, `dateOfBirth`, payment credentials, session tokens, or the caller-supplied `Idempotency-Key`. Failure events log `err.message` only — never a stack, which can contain query text and bound parameters.

### Events

| Event                                 | Level   | Emitted when                                                       | Notable fields                                                                                 |
| ------------------------------------- | ------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `billing.profile.fetched`             | `info`  | Full-profile read succeeds                                         | `profileId`, `paymentMethodCount`, `invoiceCount`, `totalAmount`, `coercedCount`               |
| `billing.general_information.fetched` | `info`  | General-information read succeeds                                  | `profileId`, `addressComponentCount`                                                           |
| `billing.payment_methods.listed`      | `info`  | Payment-method list succeeds                                       | `profileId`, `paymentMethodCount`                                                              |
| `billing.invoices.listed`             | `info`  | Invoice list succeeds                                              | `invoiceCount`, `totalAmount`, `paidAmount`, `outstandingAmount`, `statusCounts`, `durationMs` |
| `billing.summary.computed`            | `info`  | Summary math completes                                             | `annualRewardLimit`, `usedAmount`, `remainingAmount`, `progressPercentage`, `durationMs`       |
| `billing.summary.limit_exceeded`      | `warn`  | `usedAmount > annualRewardLimit` (the response clamps this to `0`) | `overageAmount`, `currency`                                                                    |
| `billing.amount.coerced`              | `warn`  | A stored `numeric(18,6)` value was unusable and became `0`         | `field`, `reason` (summary) or `affectedRows` + `reasons` (invoices/profile)                   |
| `billing.ownership.denied`            | `warn`  | Ownership gate rejects the caller                                  | `profileId`, `callerAddress`, `reason`, `route`                                                |
| `billing.idempotency.replayed`        | `info`  | A cached response is replayed for a repeated key                   | `route`, `method`, `keyAgeMs`, `statusCode`                                                    |
| `billing.idempotency.conflict`        | `warn`  | A key is reused with a different body (`409`)                      | `route`, `method`, `keyAgeMs`                                                                  |
| `billing.*.failed`                    | `error` | Any handler or the ownership lookup throws (`500`)                 | `profileId`, `message`, `durationMs` where measured                                            |

`billing.ownership.denied` carries `reason: "not_found" | "not_owner"`. **This split exists in the logs only** — the HTTP response is an identical `404` for both, so the enumeration guarantee above is unaffected. Operators need the split to tell a stale bookmark apart from someone probing other people's profile IDs.

### Counters

Read them with `getBillingMetricsSnapshot()`; `resetBillingMetrics()` exists for tests.

| Counter                                     | Meaning                                                      |
| ------------------------------------------- | ------------------------------------------------------------ |
| `billing_profile_fetched_total`             | Successful full-profile reads                                |
| `billing_profile_duration_ms_total`         | Cumulative full-profile handler wall-time                    |
| `billing_general_information_fetched_total` | Successful general-information reads                         |
| `billing_payment_methods_listed_total`      | Successful payment-method lists                              |
| `billing_invoices_listed_total`             | Successful invoice lists (calls, not rows)                   |
| `billing_invoice_rows_total`                | Invoice **rows** aggregated                                  |
| `billing_summary_computed_total`            | Successful summary computations                              |
| `billing_amount_coerced_total`              | Stored amounts coerced to `0` (per column, per row)          |
| `billing_summary_limit_exceeded_total`      | Summaries where `usedAmount` overran the limit               |
| `billing_ownership_denied_total`            | Ownership rejections (both reasons)                          |
| `billing_ownership_denied_not_found_total`  | …of which the profile did not exist                          |
| `billing_ownership_denied_not_owner_total`  | …of which the caller was not the owner                       |
| `billing_errors_total`                      | Any 5xx-producing failure, including the ownership lookup    |
| `billing_idempotency_replayed_total`        | Cached responses replayed                                    |
| `billing_idempotency_conflict_total`        | `409` conflicts on a reused key                              |
| `billing_invoices_duration_ms_total`        | Cumulative invoice-handler wall-time                         |
| `billing_summary_duration_ms_total`         | Cumulative summary-handler wall-time                         |

The three `*_duration_ms_total` counters are cumulative sums: divide by the matching `*_total` counter for a mean. Percentiles need a real histogram, which is out of scope (see below).

The three `*_duration_ms_total` counters are cumulative sums: divide by the matching `*_total` counter for a mean. Percentiles need a real histogram, which is out of scope (see below).

### Invoice aggregation

`summarizeInvoices(rows)` is exported so the arithmetic can be unit-tested directly. It is
a **read-side aggregate for telemetry only** — nothing is written back to the database and
no response body changes. When pagination is active the aggregate covers only the returned
page, not the full dataset.

- An invoice counts toward `paidAmount` when its status is exactly `paid`
  (case-insensitive). Everything else — `pending`, `overdue`, `void`, an unrecognised
  status, or a null status — counts toward `outstandingAmount`, so
  `paidAmount + outstandingAmount === totalAmount` always holds.
- A null, non-string, or blank status is bucketed as `unknown` rather than widening the
  `statusCounts` key space with arbitrary values.
- Rows whose `amount` is unusable contribute `0` and are counted in `coercedCount`, with a
  per-reason breakdown in `coercionReasons`.

## Error codes

| Status | Condition                                                       |
| ------ | --------------------------------------------------------------- |
| `400`  | Invalid `profileId`, or invalid pagination parameters           |
| `401`  | Missing or invalid session credentials                          |
| `404`  | Profile does not exist, **or** the caller does not own it       |
| `409`  | Idempotency key reused with a different request body            |
| `500`  | Unexpected server error (e.g. database failure)                 |
| `501`  | `BILLING_ENABLED` feature flag is `false`                       |

## Idempotency contract

Mutating billing routes (POST, PUT, PATCH, DELETE) support request replay protection
through the `Idempotency-Key` header.

### Header

| Header             | Value                        | Required |
| ------------------ | ---------------------------- | -------- |
| `Idempotency-Key`  | A caller-chosen unique key   | No       |
| `idempotency-key`  | Lowercase alias (same value) | No       |

When the header is absent, the handler executes normally for every request — no caching
and no replay protection. GET, HEAD, and OPTIONS requests always pass through regardless
of the header.

### Behaviour

1. **First request** — the handler runs and the response `(statusCode, body)` is cached
   keyed by `{accountScope, method, route, profileId, idempotencyKey}`. The
   `accountScope` is resolved from `x-user-address`, `x-account-id`, or `x-user-id` (in
   that order), falling back to the request IP.

2. **Replay (same key, same body)** — the cached response is returned without running the
   handler. The process-local counter `billing_idempotency_replayed_total` is bumped and a
   `billing.idempotency.replayed` info event is emitted.

3. **Conflict (same key, different body)** — the request is rejected with `409 Conflict`.
   The counter `billing_idempotency_conflict_total` is bumped and a
   `billing.idempotency.conflict` warning is emitted. Neither the key nor the body is
   written to the log — only `route`, `method`, and `keyAgeMs` are recorded.

### Cache lifetime and scope

- **TTL**: 24 hours from the first successful response. After expiry, a subsequent request
  with the same key is treated as a fresh request and re-executed.
- **Scope**: cache keys are isolated by account scope. The same idempotency key used by
  two different `x-user-address` values will each execute independently.
- **Storage**: in-process `Map` — see the caveat under
  [Intentionally out of scope](#intentionally-out-of-scope) about horizontal scaling.
- **Pruning**: expired entries are lazily removed on the next request that carries an
  `Idempotency-Key` header.

### Security

The caller-supplied `Idempotency-Key` is never written to logs, metrics, or response
bodies. Only its age (`keyAgeMs`) and the associated route appear in structured log
events.

## Billing math determinism

The two exported billing math helpers are **pure, deterministic functions** — calling them
multiple times with the same input always produces the same output:

### `parseBillingAmount(value): BillingAmount`

- No internal state, no side effects (the telemetry variant
  `parseBillingAmountWithTelemetry` is the one that emits logs).
- `stableSerialize` ensures that JSON bodies with different key orderings produce the same
  fingerprint, so the idempotency fingerprint is byte-for-byte reproducible.

### `summarizeInvoices(rows): InvoiceTotals`

- Iterates rows in the order given, applies `parseBillingAmount` per row, and
  accumulator logic that is purely arithmetic.
- No database writes, no external state mutations.
- Calling `summarizeInvoices` twice on the same `rows` input yields identical
  `InvoiceTotals`.

These functions are tested as pure functions in
`src/routes/billing.test.ts` without any HTTP or database setup.

## Intentionally out of scope

- **Write operations** (create/update/delete profiles, payment methods, or invoices).
  These are not implemented in this module. Adding them would require separate
  authorization checks for each mutation and an audit trail.
- **Invoice generation** — the module reads existing invoice rows but does not create
  them. Invoice creation logic and its associated billing-math decisions live in a
  separate concern. The invoice telemetry here therefore describes the **read-side**
  aggregate over stored rows, not an issuance pipeline.
- **Rate limiting specific to billing** — billing routes inherit the global rate limiter
  applied to all `/api/` paths. A per-route limiter could be added if billing endpoints
  show heavier-than-average traffic.
- **Metrics export** — counters are process-local and readable only through
  `getBillingMetricsSnapshot()`. There is deliberately no Prometheus/OTel exporter and no
  `/admin/metrics` endpoint in this change; wiring one up is a separate concern that would
  cover every metrics module in `src/`, not just billing.
- **Latency histograms / percentiles** — only cumulative duration sums are recorded.
  p95/p99 need a real histogram implementation, which belongs with the exporter above.
- **Counter durability** — counters reset on process restart and are per-instance, so a
  horizontally scaled deployment sees N independent sets. This matches the existing
  in-process idempotency store's caveat.
- **Cursor-based pagination** — the invoices endpoint uses offset-based pagination.
  Cursor-based pagination (e.g., `createdAt` + `id`-anchored) would be more robust
  against insertions shifting page boundaries, but would require database-level
  `WHERE` filtering the mock infrastructure cannot currently simulate. This is a
  candidate improvement if offset drift becomes measurable in production.

## Testing

```bash
pnpm test -- src/routes/billing.test.ts
```

The test suite covers:

- `parseBillingAmount`: well-formed input, 6-decimal rounding, and each of the three
  coercion reasons (`missing`, `malformed`, `negative`)
- `summarizeInvoices`: empty list, paid/outstanding split summing to the total,
  case-insensitive `paid` matching, `unknown` status bucketing, per-reason coercion
  counts, and fractional precision
- Summary route: happy path with the emitted `billing.summary.computed` payload,
  per-column coercion warnings, over-limit flagging, and the zero-limit boundary
- Invoice route: response shape unchanged, aggregate event contents, empty-list boundary,
  and the single per-request coercion warning with its reason breakdown
- Invoice pagination: paginated response with hasMore, boundary cases (limit equals total,
  limit exceeds total, offset skip), validation rejection for out-of-range values, and
  backward-compatible envelope when no pagination params are supplied
- Ownership denial: `not_found` vs `not_owner` logged distinctly behind an identical
  `404` body
- Failure paths: handler and ownership-lookup rejections produce one `*.failed` event and
  bump `billing_errors_total` without also bumping a success counter
- Idempotency: pass-through without a key, replay, `409` on a body mismatch, and the
  guarantee that the caller-supplied key never reaches the logs
- Idempotency edge cases: TTL expiry, lowercase header acceptance, body key-ordering
  invariance (`stableSerialize`), and per-account-scope cache isolation

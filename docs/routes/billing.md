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

Returns the invoice history for the profile. Every invoice row is parsed through the safe `parseBillingAmount` helper so malformed amounts never propagate NaN into the aggregate telemetry.

**Contract:**
- Queries the `billingInvoices` table filtered by `profileId`.
- The response body contains the raw rows unchanged — existing callers see exactly the same shape as before observability was added.
- A read-side aggregate (`summarizeInvoices`) is computed for telemetry only and is NOT written back to the database or returned in the response.
- When invoice amounts are unusable (missing, malformed, or negative): one `billing.amount.coerced` warning is emitted with a per-reason breakdown, and the `billing_amount_coerced_total` counter is bumped.
- The aggregate normalises invoice statuses to lowercase; unrecognised or null statuses are bucketed as `"unknown"` rather than widening the log key space with arbitrary values.
- On DB failure: responds with HTTP 500.

**Response (`200`):**

```json
{
  "success": true,
  "data": {
    "profileId": "profile-001",
    "invoices": [
      {
        "id": "inv-1",
        "invoiceNumber": "INV-2025-001",
        "amount": "500.000000",
        "currency": "USD",
        "status": "pending",
        "description": "Monthly retainer",
        "issuedAt": "2025-06-01T00:00:00.000Z",
        "paidAt": null,
        "createdAt": "2025-06-01T00:00:00.000Z",
        "updatedAt": "2025-06-01T00:00:00.000Z"
      }
    ]
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

## Error codes

| Status | Condition                                                       |
| ------ | --------------------------------------------------------------- |
| `400`  | Invalid `profileId` (empty, illegal characters, or > 128 chars) |
| `401`  | Missing or invalid session token                                |
| `404`  | Profile not found OR caller is not the owner (intentionally ambiguous) |
| `500`  | Database failure or unexpected error                            |
| `501`  | Billing is not yet enabled (`BILLING_ENABLED` is `false`)       |

## Edge cases intentionally out of scope

- **Histogram percentiles for handler wall-time.** The `*_duration_ms_total` counters are cumulative sums only. A real histogram (e.g., Prometheus) is deferred.
- **External metrics library.** All observability is process-local counters and structured logs. Prometheus/OpenTelemetry integration is deferred.
- **Horizontal idempotency.** The billing idempotency store is currently an in-process TTL cache. If the service is scaled horizontally, this must be moved to a shared store (Redis or similar).
- **Raw payment credentials.** The API never accepts or returns raw account/routing numbers. Only masked representations (`maskedAccount`, `maskedRouting`) are stored and returned.
- **Invoice mutation.** Invoice creation, updating, and payment processing are out of scope for this module. All routes are read-only.

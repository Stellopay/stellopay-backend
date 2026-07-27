# Billing Routes

> **Module:** `src/routes/billing.ts`  
> **Base path:** `/api/v1/billing`  
> **Feature flag:** `BILLING_ENABLED`

## Security model

Every billing route enforces three independent gates in order:

1. **Feature flag (`BILLING_ENABLED`)** — Must be `true`. Returns `501 Not Implemented` with
   a descriptive message when disabled.

2. **Authentication (`requireAuth`)** — Requires a valid session. The caller must supply
   `x-user-address` and `Authorization: Bearer <session-token>` headers. Missing or invalid
   credentials return `401 Unauthorized`.

3. **Authorization (ownership)** — The route verifies that the authenticated wallet address
   matches the billing profile's `ownerAddress`. When the profile does not exist **or** the
   caller is not the owner, the route returns `404 Not Found`. These two cases are
   **intentionally indistinguishable** — an attacker probing profile IDs cannot tell whether
   a profile exists or belongs to someone else.

## Response envelope

All responses use a uniform JSON envelope:

```json
{
  "success": true,
  "data": { … }
}
```

```json
{
  "success": false,
  "error": "Human-readable message"
}
```

## Sensitive fields

The columns `taxId` and `dateOfBirth` are stored in the database but **never included** in
any API response. They must only be accessed through separately-authorised, audited internal
processes. The `stripSensitive()` helper enforces this contract for every route.

## Endpoints

### `GET /billing/profiles/:profileId`

Returns the full billing profile together with its payment methods and invoices.

**Path parameters:** `profileId` — alphanumeric + dash, 1–128 characters.

**Response (`200`):**

```json
{
  "success": true,
  "data": {
    "profile": {
      "id": "profile-001",
      "ownerAddress": "0xabc…",
      "profileType": "Individual",
      "firstName": "Alice",
      "lastName": "Example",
      "email": "alice@example.com",
      "phone": "+1-555-0100",
      "street": "123 Main St",
      "city": "Metropolis",
      "state": "NY",
      "zipCode": "10001",
      "country": "US",
      "taxResidency": "US",
      "companyName": null,
      "vatNumber": null,
      "businessType": null,
      "occupation": "Engineer",
      "website": null,
      "notes": null,
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-06-01T00:00:00.000Z"
    },
    "paymentMethods": [ … ],
    "invoices": [ … ]
  }
}
```

> `taxId` and `dateOfBirth` are stripped from `profile`. There is no way to retrieve them
> through this endpoint.

---

### `GET /billing/profiles/:profileId/general-information`

Returns identity and contact fields. Includes a convenience `fullAddress` string built
from the non-null address components.

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

Returns the list of payment methods attached to the profile. Only masked representations
are stored and returned (`maskedAccount`, `maskedRouting`). Raw account numbers are never
present in the API.

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

Returns the invoice history for the profile.

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

Returns a spend-limit summary computed from the profile's `annualRewardLimit` and
`usedAmount` columns.

**Math contract:**

- Both columns are stored as `numeric(18,6)` and arrive as strings. They are parsed by
  `parseBillingAmount()`, which returns `0` for missing, malformed, or negative inputs
  and reports which of those three cases fired (see
  [Observability](#observability)).
- `remainingAmount = max(0, annualRewardLimit – usedAmount)` — clamped to zero so
  overruns never produce a negative remainder. The clamp hides an overrun from the
  response, so an overrun is reported through `billing.summary.limit_exceeded` instead.
- `progressPercentage` is `(usedAmount / annualRewardLimit) × 100`, rounded to 2 decimal
  places. When `annualRewardLimit` is `0`, progress is `0`.
- All intermediate arithmetic is rounded to 6 decimal places to stay within the column's
  declared scale.

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

## Observability

`src/routes/billing-metrics.ts` owns the telemetry side-channel for this module, in the
same shape as `src/auth/session-metrics.ts`: one structured log line per decision, plus
process-local counters. Nothing here changes a response body — the entire surface is
additive, and every endpoint returns exactly what it returned before.

**Log format.** `logBillingEvent(level, event, data)` emits `{ timestamp, level, event, …data }`
as JSON when `LOG_FORMAT=json` (the default), otherwise as a single `[billing] …` line.
Events below `LOG_LEVEL` are dropped before serialization.

**Redaction.** Log payloads carry profile IDs, the caller address, bounded reason codes,
row counts, durations, and the rounded monetary aggregates the routes already return.
They never carry `taxId`, `dateOfBirth`, payment credentials, session tokens, or the
caller-supplied `Idempotency-Key`. Failure events log `err.message` only — never a stack,
which can contain query text and bound parameters.

### Events

| Event                                 | Level   | Emitted when                                                       | Notable fields                                                                                 |
| ------------------------------------- | ------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `billing.profile.fetched`             | `info`  | Full-profile read succeeds                                         | `profileId`, `paymentMethodCount`, `invoiceCount`                                              |
| `billing.general_information.fetched` | `info`  | General-information read succeeds                                  | `profileId`, `addressComponentCount`                                                           |
| `billing.payment_methods.listed`      | `info`  | Payment-method list succeeds                                       | `profileId`, `paymentMethodCount`                                                              |
| `billing.invoices.listed`             | `info`  | Invoice list succeeds                                              | `invoiceCount`, `totalAmount`, `paidAmount`, `outstandingAmount`, `statusCounts`, `durationMs` |
| `billing.summary.computed`            | `info`  | Summary math completes                                             | `annualRewardLimit`, `usedAmount`, `remainingAmount`, `progressPercentage`, `durationMs`       |
| `billing.summary.limit_exceeded`      | `warn`  | `usedAmount > annualRewardLimit` (the response clamps this to `0`) | `overageAmount`, `currency`                                                                    |
| `billing.amount.coerced`              | `warn`  | A stored `numeric(18,6)` value was unusable and became `0`         | `field`, `reason` (summary) or `affectedRows` + `reasons` (invoices)                           |
| `billing.ownership.denied`            | `warn`  | Ownership gate rejects the caller                                  | `profileId`, `callerAddress`, `reason`, `route`                                                |
| `billing.idempotency.replayed`        | `info`  | A cached response is replayed for a repeated key                   | `route`, `method`, `keyAgeMs`, `statusCode`                                                    |
| `billing.idempotency.conflict`        | `warn`  | A key is reused with a different body (`409`)                      | `route`, `method`, `keyAgeMs`                                                                  |
| `billing.*.failed`                    | `error` | Any handler or the ownership lookup throws (`500`)                 | `profileId`, `message`, `durationMs` where measured                                            |

`billing.ownership.denied` carries `reason: "not_found" | "not_owner"`. **This split
exists in the logs only** — the HTTP response is an identical `404` for both, so the
enumeration guarantee above is unaffected. Operators need the split to tell a stale
bookmark apart from someone probing other people's profile IDs.

### Counters

Read them with `getBillingMetricsSnapshot()`; `resetBillingMetrics()` exists for tests.

| Counter                                     | Meaning                                                   |
| ------------------------------------------- | --------------------------------------------------------- |
| `billing_profile_fetched_total`             | Successful full-profile reads                             |
| `billing_general_information_fetched_total` | Successful general-information reads                      |
| `billing_payment_methods_listed_total`      | Successful payment-method lists                           |
| `billing_invoices_listed_total`             | Successful invoice lists (calls, not rows)                |
| `billing_invoice_rows_total`                | Invoice **rows** aggregated                               |
| `billing_summary_computed_total`            | Successful summary computations                           |
| `billing_amount_coerced_total`              | Stored amounts coerced to `0` (per column, per row)       |
| `billing_summary_limit_exceeded_total`      | Summaries where `usedAmount` overran the limit            |
| `billing_ownership_denied_total`            | Ownership rejections (both reasons)                       |
| `billing_ownership_denied_not_found_total`  | …of which the profile did not exist                       |
| `billing_ownership_denied_not_owner_total`  | …of which the caller was not the owner                    |
| `billing_errors_total`                      | Any 5xx-producing failure, including the ownership lookup |
| `billing_idempotency_replayed_total`        | Cached responses replayed                                 |
| `billing_idempotency_conflict_total`        | `409` conflicts on a reused key                           |
| `billing_invoices_duration_ms_total`        | Cumulative invoice-handler wall-time                      |
| `billing_summary_duration_ms_total`         | Cumulative summary-handler wall-time                      |

The two `*_duration_ms_total` counters are cumulative sums: divide by the matching
`*_total` counter for a mean. Percentiles need a real histogram, which is out of scope
(see below).

### Invoice aggregation

`summarizeInvoices(rows)` is exported so the arithmetic can be unit-tested directly. It is
a **read-side aggregate for telemetry only** — nothing is written back to the database and
no response body changes.

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
| `400`  | Invalid `profileId` (empty, illegal characters, or > 128 chars) |
| `401`  | Missing or invalid session credentials                          |
| `404`  | Profile does not exist, **or** the caller does not own it       |
| `500`  | Unexpected server error (e.g. database failure)                 |
| `501`  | `BILLING_ENABLED` feature flag is `false`                       |

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
- Ownership denial: `not_found` vs `not_owner` logged distinctly behind an identical
  `404` body
- Failure paths: handler and ownership-lookup rejections produce one `*.failed` event and
  bump `billing_errors_total` without also bumping a success counter
- Idempotency: pass-through without a key, replay, `409` on a body mismatch, and the
  guarantee that the caller-supplied key never reaches the logs

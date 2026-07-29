# Billing routes

Source: [`src/routes/billing.ts`](../../src/routes/billing.ts)

## Overview

All billing endpoints live under `/api/v1/billing/` and are gated behind the
`BILLING_ENABLED` feature flag. When the flag is `false` every endpoint returns
`HTTP 501` with a clear message. Set `BILLING_ENABLED=true` in the environment
to activate them.

All responses follow a uniform envelope:

```json
{ "success": true,  "data": { ... } }
{ "success": false, "error": "..." }
```

---

## Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/billing/profiles/:profileId` | Full profile (info + payment methods + invoices) |
| `GET` | `/billing/profiles/:profileId/general-information` | Identity / contact fields |
| `GET` | `/billing/profiles/:profileId/payment-methods` | Payment methods list |
| `GET` | `/billing/profiles/:profileId/invoices` | Invoice history |
| `GET` | `/billing/profiles/:profileId/summary` | Reward-limit / spend summary |

---

## Path parameter validation

Every route validates `:profileId` before touching the database:

- Must be between 1 and 128 characters
- Must match `^[\w\-]+$` (alphanumeric and dashes only)

Invalid values return `HTTP 400` with `success: false` before any DB query runs.

---

## Sensitive field policy

`taxId` and `dateOfBirth` are stored in `billing_profiles` but **never** included
in any API response. They are stripped by `stripSensitive` before serialisation.
This applies to both the full-profile route and the general-information route.

---

## Exported pure helpers

These functions are extracted from the route handlers and exported so they can
be unit-tested without a database or HTTP layer.

### `computeBillingSummary(annualRewardLimit, usedAmount)`

Computes the reward-limit summary fields from raw `numeric(18,6)` strings as
stored in the database.

```ts
import { computeBillingSummary } from "./routes/billing.js";

const summary = computeBillingSummary("1000.000000", "250.500000");
// → { annualRewardLimit: 1000, usedAmount: 250.5,
//     remainingAmount: 749.5, progressPercentage: 24.95 }
```

**Contract**

| Input | Behaviour |
|---|---|
| `null` / `undefined` | Treated as `"0"` |
| `usedAmount > annualRewardLimit` | `remainingAmount` is clamped to `0`; `progressPercentage` may exceed 100 (over-spend signal) |
| `annualRewardLimit === 0` | `progressPercentage` is `0` (avoids division by zero) |
| Any value | `progressPercentage` is rounded to 2 decimal places |

---

### `buildFullAddress(parts)`

Joins address parts into a single display string, filtering absent values.

```ts
import { buildFullAddress } from "./routes/billing.js";

buildFullAddress(["1 Main St", "NYC", "NY", "10001", "USA"])
// → "1 Main St, NYC, NY, 10001, USA"

buildFullAddress([null, "Berlin", null, null, "DE"])
// → "Berlin, DE"

buildFullAddress([null, null, null, null, null])
// → null
```

Returns `null` (not an empty string) when all parts are absent so callers can
omit the field rather than return an empty value.

---

## Idempotency middleware

Mutating routes can opt into replay protection by wrapping their handler with
`withBillingIdempotency`. When the client sends an `Idempotency-Key` header:

- **Same key + same body** — returns the cached response; the handler is not
  re-executed.
- **Same key + different body** — returns `HTTP 409 Conflict`.
- **No key** — handler executes normally; no caching.
- **GET / HEAD / OPTIONS** — always pass through; never cached.

The cache is in-process with a 24-hour TTL. Entries are pruned lazily on each
request. For multi-instance deployments, replace the in-process store with a
shared backend (e.g. Redis).

```ts
import { withBillingIdempotency } from "./routes/billing.js";

router.post("/billing/invoices", withBillingIdempotency(async (req, res) => {
  // handler body — only runs once per unique key+body pair within the TTL
}));
```

The `clearBillingIdempotencyStore()` export is provided for test isolation only.

---

## Summary math contract

The `/summary` endpoint exposes the following computed fields:

| Field | Formula | Notes |
|---|---|---|
| `annualRewardLimit` | `parseFloat(db.annualRewardLimit)` | Raw limit from DB |
| `usedAmount` | `parseFloat(db.usedAmount)` | Raw used from DB |
| `remainingAmount` | `max(0, limit - used)` | Never negative |
| `progressPercentage` | `round((used/limit)*100, 2)` | 0 when limit=0; may exceed 100 on over-spend |

---

## Out of scope

- **Invoice creation / mutation** — no write endpoints exist yet; all current
  routes are read-only.
- **Per-invoice math** — individual invoice amounts are stored as entered; no
  aggregation or tax calculation is performed by this layer.
- **Row-level security** — `taxId` and `dateOfBirth` are stripped at the
  application layer. Database-level RLS is not yet applied.
- **Pagination** — invoice and payment-method lists are returned in full.
  Pagination is tracked separately.
- **Currency conversion** — amounts are returned in the stored currency; no
  FX conversion is performed.

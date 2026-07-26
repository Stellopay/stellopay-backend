# Billing Routes — Backward-Compatible Contract

> Source: `src/routes/billing.ts`  
> Tests:  `src/routes/billing.test.ts`  
> Feature flag: `BILLING_ENABLED` (env var, default `false`)

---

## Overview

All billing endpoints live under `/api/v1/billing/profiles/:profileId`.  
Every endpoint is gated by the `BILLING_ENABLED` feature flag. When the flag is
`false` (the default) **every** route returns `501 Not Implemented` — no
database call is made. Set `BILLING_ENABLED=true` in your environment to
activate the surface.

---

## Response Envelope

All responses — success and failure — use the same wrapper shape. This shape is
**frozen**: changing it is a breaking change for existing callers.

```jsonc
// success
{ "success": true,  "data": { … } }

// failure
{ "success": false, "error": "<human-readable message>" }
```

`data` is never present on error responses; `error` is never present on success
responses.

---

## Path-Parameter Contract

| Parameter   | Rules |
|-------------|-------|
| `profileId` | Non-empty string, max 128 chars, characters `[A-Za-z0-9_-]` only. |

Violations return `400` with `{ "success": false, "error": "Invalid profileId: …" }`.

---

## Sensitive-Field Policy

`taxId` and `dateOfBirth` are stored in `billing_profiles` but **must never
appear in any API response**. They are stripped by `stripSensitive()` before
any handler serialises a profile row. This invariant is enforced by tests and
must be preserved by all future changes to the handler or the schema projection.

---

## Endpoints

### `GET /api/v1/billing/profiles/:profileId`

Returns the complete billing picture for one profile in a single round-trip.

**Success `200`**

```jsonc
{
  "success": true,
  "data": {
    "profile":        { /* SafeProfile — see field table below */ },
    "paymentMethods": [ /* BillingPaymentMethod[] */ ],
    "invoices":       [ /* BillingInvoice[] */ ]
  }
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| `400`  | Invalid `profileId` |
| `404`  | No row found for `profileId` |
| `500`  | Unexpected database error (internal detail never leaked) |
| `501`  | `BILLING_ENABLED=false` |

---

### `GET /api/v1/billing/profiles/:profileId/general-information`

Returns identity and contact fields plus a convenience `fullAddress` string.

**Success `200`**

```jsonc
{
  "success": true,
  "data": {
    /* ...all SafeProfile fields... */
    "fullAddress": "123 Main St, Springfield, IL, 62701, US"
    //             null when every address part is absent
  }
}
```

**`fullAddress` construction rule (stable — callers render this string directly)**

```
fullAddress = [street, city, state, zipCode, country]
                .filter(Boolean)
                .join(", ")
              // null when the filtered array is empty
```

Order and separator (`, `) must not change without a breaking-change notice.

**Errors** — same table as the full-profile endpoint.

---

### `GET /api/v1/billing/profiles/:profileId/payment-methods`

Returns masked payment method records. Raw account/routing numbers are **never**
stored; only `maskedAccount` (`****1234`) and `maskedRouting` (`****5678`)
representations are persisted.

**Success `200`**

```jsonc
{
  "success": true,
  "data": {
    "profileId": "…",
    "paymentMethods": [
      {
        "id": "pm-1",
        "profileId": "…",
        "type": "bank_account",
        "displayName": "Chase ****1234",
        "maskedAccount": "****1234",
        "maskedRouting": "****5678",
        "email": null,
        "isDefault": true,
        "createdAt": "…",
        "updatedAt": "…"
      }
    ]
  }
}
```

Returns an empty `paymentMethods` array (not an error) when the profile exists
but has no methods attached.

---

### `GET /api/v1/billing/profiles/:profileId/invoices`

Returns invoice history for the profile.

**Success `200`**

```jsonc
{
  "success": true,
  "data": {
    "profileId": "…",
    "invoices": [
      {
        "id": "inv-1",
        "profileId": "…",
        "invoiceNumber": "INV-2024-001",
        "amount": "500.000000",
        "currency": "USD",
        "status": "paid",          // pending | paid | void
        "description": "…",
        "issuedAt": "…",
        "paidAt": "…",
        "createdAt": "…",
        "updatedAt": "…"
      }
    ]
  }
}
```

`amount` is the raw `numeric` string from the database (precision 18, scale 6).
Callers are responsible for display formatting.

Valid `status` values: `pending`, `paid`, `void`. This set is **closed** —
adding a new status requires a migration and a version note here.

---

### `GET /api/v1/billing/profiles/:profileId/summary`

Returns the reward-limit spend summary. This endpoint drives progress-bar UI
and billing gate checks — its math is load-bearing.

**Success `200`**

```jsonc
{
  "success": true,
  "data": {
    "profileId":          "…",
    "profileType":        "Individual",   // Individual | Business
    "annualRewardLimit":  1000,           // number (parsed from DB numeric)
    "usedAmount":         250,            // number
    "remainingAmount":    750,            // number — see math contract below
    "currency":           "USD",
    "progressPercentage": 25.00          // number — see math contract below
  }
}
```

#### Billing Math Contract (frozen — enforced by tests)

These formulas live in `computeBillingSummary()` in `src/routes/billing.ts`.
Do not change them without updating this document and the unit tests.

```
limit     = parseFloat(annualRewardLimit ?? "0")
used      = parseFloat(usedAmount       ?? "0")

remainingAmount    = Math.max(0, limit - used)
                   // always ≥ 0; never negative even when used > limit

progressPct        = limit > 0 ? (used / limit) * 100 : 0
                   // 0 when limit is 0 — avoids division by zero

progressPercentage = Math.round(progressPct * 100) / 100
                   // rounded to 2 decimal places
                   // e.g. 1/3 of limit → 33.33, not 33.333…
```

| Scenario | `remainingAmount` | `progressPercentage` |
|---|---|---|
| `limit=0, used=0` | `0` | `0` |
| `limit=1000, used=250` | `750` | `25` |
| `limit=1000, used=1000` | `0` | `100` |
| `limit=500, used=600` (over-limit) | `0` | `120` |
| `limit=3, used=1` | `2` | `33.33` |

> **Note:** `progressPercentage` can exceed 100 when `usedAmount > annualRewardLimit`.
> This is intentional — callers should clamp the display value themselves.
> `remainingAmount` is always clamped to `0` (never negative).

---

## SafeProfile Fields

All endpoints that return a profile object omit `taxId` and `dateOfBirth`.
The remaining fields are:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Primary key |
| `ownerAddress` | `string` | Starknet wallet address |
| `profileType` | `string` | `Individual` \| `Business` |
| `annualRewardLimit` | `string` | Numeric string, precision 18 scale 6 |
| `usedAmount` | `string` | Numeric string, precision 18 scale 6 |
| `currency` | `string` | ISO 4217, default `USD` |
| `firstName` | `string \| null` | |
| `lastName` | `string \| null` | |
| `email` | `string \| null` | |
| `phone` | `string \| null` | |
| `street` | `string \| null` | |
| `city` | `string \| null` | |
| `state` | `string \| null` | |
| `zipCode` | `string \| null` | |
| `country` | `string \| null` | |
| `taxResidency` | `string \| null` | |
| `companyName` | `string \| null` | Business profiles only |
| `vatNumber` | `string \| null` | Business profiles only |
| `businessType` | `string \| null` | Business profiles only |
| `occupation` | `string \| null` | |
| `website` | `string \| null` | |
| `notes` | `string \| null` | |
| `createdAt` | `string` (ISO 8601) | |
| `updatedAt` | `string` (ISO 8601) | |

---

## Error Reference

| Status | Meaning | Body |
|---|---|---|
| `400` | Validation failure | `{ "success": false, "error": "Invalid profileId: …" }` |
| `404` | Profile not found | `{ "success": false, "error": "Billing profile '…' not found" }` |
| `500` | Unexpected server error | `{ "success": false, "error": "Failed to fetch …" }` — internal details are never leaked |
| `501` | Feature not enabled | `{ "success": false, "error": "Billing is not yet enabled … Set BILLING_ENABLED=true …" }` |

---

## Out of Scope (issue #304)

The following are intentionally not covered by this surface:

- **Invoice creation / mutation** — no `POST`/`PATCH`/`DELETE` endpoints exist yet.
- **Billing profile creation** — profiles are seeded externally.
- **Authentication / authorisation** — caller identity checks sit at a higher
  layer; these routes do not yet enforce per-user ownership of a profile.
- **Pagination** — invoice and payment-method lists are returned in full;
  pagination is a follow-up concern once volumes grow.
- **Currency conversion** — all math is single-currency; multi-currency support
  is out of scope.

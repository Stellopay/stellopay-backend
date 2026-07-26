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

All responses use the same wrapper shape. This shape is **frozen**.

```jsonc
// success
{ "success": true,  "data": { … } }

// failure
{ "success": false, "error": "<human-readable message>" }
```

`data` is never present on error responses; `error` is never present on success responses.

---

## Path-Parameter Contract

| Parameter   | Rules |
|-------------|-------|
| `profileId` | Non-empty string, max 128 chars, characters `[A-Za-z0-9_-]` only. |

Violations return `400` with `{ "success": false, "error": "Invalid profileId: …" }`.

---

## Sensitive-Field Policy

`taxId` and `dateOfBirth` are stored in `billing_profiles` but **must never
appear in any API response**. Stripped by `stripSensitive()` before any handler
serialises a profile row. Enforced by tests.

---

## Endpoints

### `GET /api/v1/billing/profiles/:profileId`

**Success `200`**
```jsonc
{ "success": true, "data": { "profile": { /* SafeProfile */ }, "paymentMethods": [], "invoices": [] } }
```

### `GET /api/v1/billing/profiles/:profileId/general-information`

Adds a computed `fullAddress` string (stable — callers render directly):
```
[street, city, state, zipCode, country].filter(Boolean).join(", ")
// null when every part is absent
```

### `GET /api/v1/billing/profiles/:profileId/payment-methods`

Returns masked records only. Empty array (not an error) when profile has no methods.

### `GET /api/v1/billing/profiles/:profileId/invoices`

`amount` is the raw `numeric` string (precision 18, scale 6). Valid `status`: `pending | paid | void` (closed set).

### `GET /api/v1/billing/profiles/:profileId/summary`

#### Billing Math Contract (frozen — enforced by tests)

```
limit     = parseFloat(annualRewardLimit ?? "0")
used      = parseFloat(usedAmount       ?? "0")

remainingAmount    = Math.max(0, limit - used)   // always ≥ 0
progressPercentage = limit > 0 ? round2(used/limit*100) : 0
                   // rounded to 2dp; can exceed 100 when used > limit
```

| Scenario | `remainingAmount` | `progressPercentage` |
|---|---|---|
| `limit=0, used=0` | `0` | `0` |
| `limit=1000, used=250` | `750` | `25` |
| `limit=1000, used=1000` | `0` | `100` |
| `limit=500, used=600` | `0` | `120` |
| `limit=3, used=1` | `2` | `33.33` |

---

## Error Reference

| Status | Meaning |
|---|---|
| `400` | Invalid `profileId` |
| `404` | Profile not found |
| `500` | Unexpected server error — internal details never leaked |
| `501` | `BILLING_ENABLED=false` |

---

## Out of Scope (issue #304)

Invoice/profile creation, authentication enforcement, pagination, currency conversion.

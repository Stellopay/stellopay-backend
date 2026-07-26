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

- Both columns are stored as `numeric(18,6)` and arrive as strings. They are parsed with
  a safe parser that returns `0` for missing, malformed, or negative inputs.
- `remainingAmount = max(0, annualRewardLimit – usedAmount)` — clamped to zero so
  overruns never produce a negative remainder.
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

## Error codes

| Status | Condition |
|--------|-----------|
| `400`  | Invalid `profileId` (empty, illegal characters, or > 128 chars) |
| `401`  | Missing or invalid session credentials |
| `404`  | Profile does not exist, **or** the caller does not own it |
| `500`  | Unexpected server error (e.g. database failure) |
| `501`  | `BILLING_ENABLED` feature flag is `false` |

## Intentionally out of scope

- **Write operations** (create/update/delete profiles, payment methods, or invoices).
  These are not implemented in this module. Adding them would require separate
  authorization checks for each mutation and an audit trail.
- **Invoice generation** — the module reads existing invoice rows but does not create
  them. Invoice creation logic and its associated billing-math decisions live in a
  separate concern.
- **Rate limiting specific to billing** — billing routes inherit the global rate limiter
  applied to all `/api/` paths. A per-route limiter could be added if billing endpoints
  show heavier-than-average traffic.

## Testing

```bash
pnpm test -- src/routes/billing.test.ts
```

The test suite covers:

- Feature-flag gating (501 when disabled)
- Authentication rejection (401 without valid session)
- Authorization / ownership (404 for non-owned or nonexistent profiles, consistent
  across all 5 endpoints)
- Profile ID validation (empty, illegal chars, too long)
- Happy-path responses with correct data shapes for every endpoint
- Sensitive-field stripping (taxId, dateOfBirth never leaked)
- Summary math: normal case, over-limit clamping, zero-limit, null/missing values,
  fractional precision
- Case-insensitive address matching
- Database-failure fallback (500)

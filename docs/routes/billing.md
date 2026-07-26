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

## Endpoints

- **GET `/billing/profiles/:profileId`**
  Returns the full profile, including payment methods and invoices.

- **GET `/billing/profiles/:profileId/general-information`**
  Returns identity fields, with sensitive information stripped.

- **GET `/billing/profiles/:profileId/payment-methods`**
  Returns the list of payment methods for the profile.

- **GET `/billing/profiles/:profileId/invoices`**
  Returns the invoice history.

- **GET `/billing/profiles/:profileId/summary`**
  Returns the reward-limit and spend summary, utilizing shared billing math logic for numeric fields (`parseSafeAmount`).

## Billing Math and Idempotency

Mutating endpoints (if implemented) benefit from `withBillingIdempotency` middleware, ensuring requests are processed idempotently using a TTL cache.

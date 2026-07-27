# Auth Routes Contract

This document defines the strict contracts for authentication routes in `src/routes/auth.ts`.

## Strict Payloads (No Batching or Pagination)
To ensure safety under growth and prevent unintended behavior, all authentication endpoints (`/auth/challenge`, `/auth/verify`, `/auth/session/validate`, `/auth/refresh`) strictly reject extra payload attributes.
This means **pagination** and **batching** are explicitly not supported for login, challenge, and session issuance endpoints. Attempting to pass arrays (batching) or pagination arguments (like `limit`, `offset`, `cursor`) will result in a validation failure.

### Contracts
- `AddressBody`: `{ address: string }`
- `VerifyBody`: `{ address: string, signature: string[] }`
- `SessionBody`: `{ address: string, session_token: string }`
- `RefreshBody`: `{ address: string, refresh_token: string }`

# Auth Routes

Wallet-based authentication for Starknet accounts: a signed-nonce challenge
proves wallet ownership, after which the backend issues a session/refresh
token pair used for subsequent requests. All routes are mounted under
`/api/v1` and implemented in `src/routes/auth.ts`, backed by
`src/auth/challenge.ts` (nonce issuance) and `src/auth/session.ts`
(session/refresh-token lifecycle).

## Lifecycle

```
challenge  ->  verify (login)  ->  session/validate  ->  refresh  ->  logout / revoke
```

### 1. `POST /auth/challenge`

Issues a short-lived nonce the caller's wallet must sign to prove ownership.

Request:

```json
{ "address": "0x123..." }
```

Response `200`:

```json
{
  "address": "0x123...",
  "nonce": "0x...",
  "expires_in_ms": 300000,
  "chain_id": "0x534e5f5345504f4c4941",
  "typed_data": { "...": "SNIP-12 typed data payload to sign" }
}
```

**Single-outstanding-challenge-per-address:** issuing a new challenge for an
address unconditionally overwrites any previous, unconsumed challenge for
that same address. Only the most recently issued nonce is ever valid — if a
caller requests two challenges back-to-back without verifying in between,
the first nonce is silently invalidated and any later attempt to verify
against it fails with `400 "No active challenge (or expired)"`. This is
intentional (it keeps the challenge store bounded to one entry per address
and avoids stale-nonce accumulation), not a bug.

### 2. `POST /auth/verify` (login)

Verifies the signed challenge and, on success, creates a new session.

Request:

```json
{ "address": "0x123...", "signature": ["0x...", "0x..."] }
```

Response `200`:

```json
{
  "ok": true,
  "address": "0x123...",
  "session_token": "raw-token",
  "refresh_token": "raw-token",
  "expires_in_ms": 3600000
}
```

`session_token` and `refresh_token` are **the same value** — see
"Dual-role token contract" below. Errors: `400` if there is no active
challenge for the address (never requested, already consumed, or
overwritten by a later challenge); `401` if signature verification fails.

### 3. `POST /auth/session/validate`

Validates a `session_token` (e.g. so a frontend can detect a backend
restart or an expired/revoked session without hitting a protected route).

Request:

```json
{ "address": "0x123...", "session_token": "raw-token" }
```

Response: `200 { "ok": true, "address": "0x123..." }` or
`401 { "ok": false, "error": "Invalid session" }`.

### 4. `POST /auth/refresh`

Rotates a refresh token: the presented token is consumed and a new one is
issued in the same token family.

Request:

```json
{ "address": "0x123...", "refresh_token": "raw-token" }
```

Response `200`:

```json
{
  "ok": true,
  "address": "0x123...",
  "refresh_token": "new-raw-token",
  "session_token": "new-raw-token",
  "expires_in_ms": 3600000
}
```

`refresh_token` and `session_token` are again **the same value**. Error:
`401 { "ok": false, "error": "Invalid refresh token" }` if the token is
unknown, expired, address-mismatched, or has already been rotated/revoked
(see the reuse-detection model below).

### 5. `POST /auth/logout` (requires bearer auth)

Revokes the single session token used to authenticate the request.
`200 { "ok": true }`, or `401` if the presented token is not a valid
session.

### 6. `POST /auth/revoke` (requires bearer auth)

Revokes every outstanding session/refresh token for the authenticated
address ("sign out everywhere"). `200 { "ok": true }`.

## Dual-role token contract

`createSession()` issues a single raw token, not a separate session token
and refresh token. That one token is valid both as a bearer `session_token`
(for protected routes and `/auth/session/validate`) and as the initial
`refresh_token` accepted by `/auth/refresh` — `rotateSession` looks the
presented value up by its hash in the same `sessions` table regardless of
which field name it arrived under.

After a rotation, the newly issued token from `/auth/refresh` is likewise
dual-role: it can be used as the next `refresh_token` **or** as a bearer
`session_token`.

To make this contract discoverable from either endpoint's response alone,
**both `/auth/verify` and `/auth/refresh` return both field names for the
same value**:

- `/auth/verify` returns `session_token` (as before) and now also
  `refresh_token`, equal to it.
- `/auth/refresh` returns `refresh_token` (as before) and now also
  `session_token`, equal to it.

This is purely additive — no existing field was removed or renamed, so
callers relying on only one of the two names continue to work unchanged.

## Refresh-rotation security model

Implemented in `src/auth/session.ts` (`rotateSession` / `revokeFamily`):

- Every session/refresh token belongs to a **family** (`familyId`), assigned
  when the family's first token is created and preserved across rotations.
- Calling `/auth/refresh` **consumes** the presented token (marks it
  `rotatedAt`) and issues a brand-new token in the same family.
- If a token that has already been rotated (or revoked) is presented again,
  this is treated as a **token-theft signal**, not just an ordinary invalid
  token: the entire family is revoked immediately via `revokeFamily`, so
  even the legitimate, currently-active token in that family stops working.
  The caller must re-authenticate from `/auth/challenge` to get a new
  family.

## Performance notes

### Admin address Set (`rebuildAdminSet`)

`/auth/session/revoke` must check whether the authenticated caller is an
admin. The naive implementation allocates a new lowercased array on every
request:

```ts
// before — O(n) allocation + linear scan on every request
env.ADMIN_ADDRESSES.map((a) => a.toLowerCase()).includes(callerAddress.toLowerCase())
```

`auth.ts` now builds a `Set<string>` of lowercased admin addresses once at
module load and reuses it across all requests:

```ts
// after — O(1) per request, one allocation at startup
adminAddressSet.has(callerAddress.toLowerCase())
```

If `env.ADMIN_ADDRESSES` is mutated after module load (e.g. in tests), call
the exported `rebuildAdminSet()` to synchronise the Set with the new array
contents.

### Debug middleware body clone

The debug middleware clones `req.body` only when it is a non-null object.
Previously it always spread `req.body` into a new object, including on
requests that have no body (e.g. `GET` health checks routed through the
same middleware, or malformed requests without a JSON body). The guard:

```ts
if (req.body && typeof req.body === "object") { /* clone and redact */ }
```

...avoids an unnecessary object allocation and spread on every no-body
request while keeping the redaction logic identical for the normal case.

## Known limitations / out of scope

- **Address format is intentionally unvalidated.** All four request schemas
  (`AddressBody`, `VerifyBody`, `SessionBody`, `RefreshBody`) accept
  `address` as an opaque `z.string().min(3)` with no Starknet-address/hex
  format check. This is left as-is to preserve compatibility with existing
  callers and tests (which use non-address placeholder strings such as
  `"address"` or `"0xExpiredChallenge"`); tightening it is out of scope for
  this change.
- `getCachedNetworkInfo()` is already memoised in `src/starknet/client.ts`
  and adds no per-request overhead beyond a Map lookup; no change was
  needed there.
- The `chainIdCache` inside `src/auth/challenge.ts` (`buildTypedChallenge`)
  is likewise already memoised; the double-decode concern is already
  handled at that layer.

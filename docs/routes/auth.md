# Auth route contract (`src/routes/auth.ts`)

This document is the source of truth for the runtime contract of the routes
in [`src/routes/auth.ts`](../src/routes/auth.ts) — wallet-ownership login
(challenge, signature verification, session issuance, refresh, validation,
logout, revocation).

The contract below is what callers, integration tests, and the inline route
handlers all describe. Behaviour on any endpoint is frozen unless this
document is updated alongside the change.

---

## Surface table

| Method | Path | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `POST` | `/auth/challenge` | none | Issue a short-lived challenge nonce + SNIP-12 typed data |
| `POST` | `/auth/verify` | challenge | Verify signature, consume challenge, issue session |
| `POST` | `/auth/session/validate` | session | Read-only check that a token is valid; sliding-renews TTL |
| `POST` | `/auth/refresh` | session (dual-role token) | Rotate a session, sliding TTL |
| `POST` | `/auth/logout` | bearer session | Revoke the single session used to authenticate |
| `POST` | `/auth/revoke` | bearer session | Revoke every outstanding session for the caller |
| `POST` | `/auth/session/revoke` | bearer session | Revoke a specific session by `token_hash` (owner or admin only) |

All seven routes are JSON-only with `Content-Type: application/json`. All
Zod validation failures go through the central error handler in
`src/index.ts` and surface as:

```json
{ "error": "Validation failed", "request_id": "<id>", "details": [ ... ZodIssue ... ] }
```

with HTTP status `400`.

---

## 1. `POST /auth/challenge` — issue nonce

Issue a short-lived challenge for the supplied wallet address. This nonce is
the active proof expected by the next `/auth/verify` call.

### Request body

```json
{ "address": "0xWALLET" }
```

Validation: `address` is `z.string().min(3)`. The schema is `.strict()` —
additional properties on the body cause `400 Validation failed`. Address
format / hex-shape is intentionally **not** enforced (see "Known limitations
/ out of scope").

### Response `200`

```json
{
  "address": "0xWALLET",
  "nonce": "0xRANDOM_16_BYTE_NONCE",
  "expires_in_ms": 300000,
  "chain_id": "0xCHAIN_ID_FELT",
  "typed_data": {
    "types": { "StarknetDomain": [...], "Challenge": [...] },
    "primaryType": "Challenge",
    "domain":   { "name": "StelloPay", "version": "1", "chainId": "SN_SEPOLIA", "revision": "1" },
    "message":  { "action": "LOGIN", "wallet": "0xWALLET", "nonce": "0xRANDOM_16_BYTE_NONCE" }
  }
}
```

### Frozen response fields

| Field | Type | Notes |
| :--- | :--- | :--- |
| `address` | string | Echoed request address |
| `nonce` | hex string | The challenge nonce the wallet will sign |
| `expires_in_ms` | integer | Remaining challenge lifetime in ms (default `300000`, 5 minutes) |
| `chain_id` | hex string | Raw Starknet chain ID returned by the configured RPC |
| `typed_data` | object | SNIP-12 typed-data the wallet must sign verbatim — do not reconstruct |

### Failure modes

| Status | Body | When |
| :--- | :--- | :--- |
| `400` | `{ "error": "Validation failed", "details": [...] }` | Body fails Zod (unknown property, `address` shorter than 3 chars, missing `address`) |
| `500` | `{ "error": "<underlying error message>" }` | `createChallenge` throws (see *Out of scope* for the asymmetric address-validation surface); `getCachedNetworkInfo` throws (RPC failure); `buildTypedChallenge` throws |

### Idempotency within the active TTL window

Within the active TTL window (5 minutes from issuance), a retry returns the
**same** nonce with the **remaining** TTL — not the original full TTL.
`createChallenge` in `src/auth/challenge.ts` returns the existing nonce and
emits a `challenge_replayed` metric rather than overwriting it. A retry
therefore **cannot** invalidate an in-flight `/auth/verify` for the same
address, and the expiry clock is anchored to the original issuance.

When the TTL elapses, or after the challenge was consumed by a successful
verify, the next call returns a brand-new nonce and a fresh 5-minute window.
The two terminal states (expired vs consumed) behave identically from the
caller's perspective.

### Single-outstanding-challenge-per-address

Each canonical address maps to at most one stored challenge at any time.
Whether a retry returns the existing nonce or generates a new one depends on
clock state: while the existing nonce is still unexpired, the retry returns
the existing nonce unchanged; once it is gone (expired or consumed), the
retry issues a fresh nonce. Either way, **only the nonce returned by the most
recent successful response is ever valid** for verification — signers
should never hold onto a nonce they saw on an earlier response.

---

## 2. `POST /auth/verify` — login

Verify the signed challenge and, on success, issue a session and consume the
challenge.

### Request body

```json
{ "address": "0xWALLET", "signature": ["0xPART_0", "0xPART_1"] }
```

Validation:

| Field | Schema | Notes |
| :--- | :--- | :--- |
| `address` | `z.string().min(3)` | Same intentionally-unvalidated format as challenge |
| `signature` | `z.array(z.string().min(1)).min(2)` | At least two non-empty felts. **No fixed upper bound** — Starknet wallets can produce variable-length signatures, send the array returned by the wallet without truncating. |
| (envelope) | `.strict()` | Unknown properties are rejected with `400 Validation failed` |

### Response `200`

```json
{
  "ok": true,
  "address": "0xWALLET",
  "session_token": "raw-token",
  "refresh_token": "raw-token",
  "expires_in_ms": 86400000
}
```

`session_token` and `refresh_token` are **the same value** — see
"Dual-role token contract" below. `expires_in_ms` is `SESSION_TTL_MS`
(default `86400000`, 24 hours). The consumed challenge is removed from the
in-memory store on success.

### Failure modes

| Status | Response body | When | Challenge state after response |
| :--- | :--- | :--- | :--- |
| `400` | `{ "error": "Validation failed", "details": [...] }` | Zod validation fails | **unchanged** (consumeChallenge runs after parse) |
| `400` | `{ "error": "No active challenge (or expired). Call /auth/challenge again." }` | No challenge for the address — never requested, expired, already consumed, or overwritten by a later challenge | n/a |
| `401` | `{ "error": "Invalid signature or account locked" }` | **`isLockedOut(address)`** returned true at the top of the handler — lockout is checked **before** `consumeChallenge` runs | **unchanged** |
| `401` | `{ "error": "Invalid signature or account locked" }` | RPC signature check failed — `consumeChallenge` already ran and removed the nonce | **consumed** |
| `500` | `{ "error": "<underlying error message>" }` | Session-store write throws after signature was successfully verified | **consumed** |

> **The two `401` envelopes are byte-identical** — a caller cannot tell
> whether the 401 came from the lockout branch (challenge still valid,
> retry with the same nonce after the 15-minute lockout elapses) or from
> a signature failure (challenge already consumed, need a new one). This
> is intentional (probes cannot distinguish "locked" from "wrong
> signature"), but it does mean callers must re-issue a fresh
> `/auth/challenge` on any `401` they cannot otherwise reconcile.
>
> **Consequence:** when a `401` is the only signal a caller has, the
> safe retry is "request a new challenge, then verify again" — not
> "retry the existing signature with the existing nonce". Only call
> sites that can introspect the in-flight challenge's TTL can decide to
> skip the re-issue between consecutive attempts.

### Replay and concurrency

The challenge is consumed exactly once (`consumeChallenge` in
`src/auth/challenge.ts` removes it atomically before signature verification
begins). A second `/auth/verify` for the same address, even with a valid
signature, returns `400 No active challenge (or expired)` because the nonce
has already been removed. Concurrent verify attempts against the same
challenge share the guarantee — exactly one succeeds, the others fail with
`400`.

### Lockout

`recordFailure(address)` is called exactly once per failed RPC verify. After
`MAX_FAILURES = 5` failed attempts (`src/auth/lockout.ts`), the address is
locked out for `LOCKOUT_MS = 15` minutes. The counter is **non-sliding**:
when a previous lockout's `lockedUntil` has elapsed, the next `recordFailure`
call resets the failure count to 1 rather than carrying the partial count
across cycles. Subsequent requests — even with a valid challenge and
signature — short-circuit before the RPC provider is called and return
`401 Invalid signature or account locked`. A successful verify
(`clearFailures`) deletes the lockout record outright.

---

## 3. `POST /auth/session/validate`

Validate a session token. Read-only — successful validation sliding-renews
the token TTL server-side but does NOT issue a new token.

### Request body

```json
{ "address": "0xWALLET", "session_token": "raw-token" }
```

Validation: `address` is `z.string().min(3)`; `session_token` is
`z.string().min(10)`; envelope is `.strict()`.

### Response `200`

```json
{ "ok": true, "address": "0xWALLET" }
```

### Failure modes

| Status | Body | When |
| :--- | :--- | :--- |
| `400` | `{ "error": "Validation failed", "details": [...] }` | Body fails Zod |
| `401` | `{ "ok": false, "error": "Invalid session" }` | Token hash unknown, expired, revoked, or address-mismatched; or no session rows match |
| `500` | `{ "error": "<underlying error message>" }` | `requireSession` throws (session-store lookup / update fails) |

### Idempotency

Validate is read-only. Repeating the same call N times yields the same
`200` and does not consume the session — `requireSession` in
`src/auth/session.ts` only refreshes `lastSeen`/`expiresAt`, capped to once
per `SESSION_UPDATE_THRESHOLD_MS` (default 60 s) per request burst.

---

## 4. `POST /auth/refresh`

Rotate the session. The presented token is consumed (its row is marked
`rotatedAt`) and a new token is issued in the same `familyId` with a fresh
sliding TTL.

### Request body

```json
{ "address": "0xWALLET", "refresh_token": "raw-token" }
```

Validation: `address` is `z.string().min(3)`; `refresh_token` is
`z.string().min(10)`; envelope is `.strict()`.

### Response `200`

```json
{
  "ok": true,
  "address": "0xWALLET",
  "refresh_token": "new-raw-token",
  "session_token": "new-raw-token",
  "expires_in_ms": 86400000
}
```

The rotated token is dual-role — see below.

### Failure modes

| Status | Body | When | Side effect |
| :--- | :--- | :--- | :--- |
| `400` | `{ "error": "Validation failed", "details": [...] }` | Zod fails | none |
| `401` | `{ "ok": false, "error": "Invalid refresh token" }` | Token unknown / expired / address-mismatched | none |
| `401` | `{ "ok": false, "error": "Invalid refresh token" }` | Stale-token reuse — presented token already rotated OR revoked. Envelope is identical to the row above; the only difference is the side-effect column. | **`revokeFamily` runs** — the live token in the same family is invalidated too. Caller must re-authenticate from `/auth/challenge`. |
| `500` | `{ "error": "<underlying error message>" }` | `rotateSession` throws (rotation write fails) | none |

---

## 5. `POST /auth/logout` (bearer auth)

Revoke the single session used to authenticate the request.

Headers:

| Header | Value |
| :--- | :--- |
| `Authorization` | `Bearer <session_token>` |
| `x-user-address` | `<session_address>` (must match token hash) |

### Response `200`

```json
{ "ok": true }
```

### Failure modes

| Status | Body | When |
| :--- | :--- | :--- |
| `401` | `{ "error": "Unauthorized" }` | Missing or invalid bearer / x-user-address, or session was already revoked |
| `500` | `{ "error": "<underlying error message>" }` | `revokeSession` throws (session-store write fails) |

### Idempotency

A second `/auth/logout` against a session that was just revoked returns
`401`, **not `200`**. This deliberately does not distinguish "session
already revoked" from "session never existed" so probes cannot enumerate
session history.

---

## 6. `POST /auth/revoke` (bearer auth)

Revoke every outstanding session token for the authenticated address
("sign out everywhere"). All tokens belonging to any family under that
address are revoked in a single pass.

Headers: same as `/auth/logout`.

### Response `200`

```json
{ "ok": true }
```

### Failure modes

| Status | Body | When |
| :--- | :--- | :--- |
| `401` | `{ "error": "Unauthorized" }` | Missing or invalid bearer / x-user-address, or session was already revoked |
| `500` | `{ "error": "<underlying error message>" }` | `revokeAllSessionsForAddress` throws (session-store write fails) |

### Idempotency

A second `/auth/revoke` after the session was already revoked returns
`401` (the bearer token is no longer valid), matching `/auth/logout`'s
non-distinguishable envelopes.

---

## 7. `POST /auth/session/revoke` (bearer auth)

Revoke a specific session by its `token_hash` (the SHA-256 hash of the raw
token). The caller must either own the target session (case-insensitive
address equality) or be listed in `env.ADMIN_ADDRESSES`.

Headers: same as `/auth/logout`.

### Request body

```json
{ "token_hash": "<64 hex chars — SHA-256 of the raw token>" }
```

Validation: `token_hash` is `z.string().length(64)`. The envelope for this
endpoint is **not** `.strict()` — it permits additional properties so future
fields (e.g. an admin-only reason string) can be added without breaking
existing callers.

### Response `200`

```json
{ "ok": true }
```

### Failure modes

| Status | Body | When |
| :--- | :--- | :--- |
| `400` | `{ "error": "Validation failed", "details": [...] }` | `token_hash` is not exactly 64 chars |
| `401` | `{ "error": "Unauthorized" }` | Missing / invalid bearer; or caller is not the owner and not in the admin set |
| `404` | `{ "error": "Session not found" }` | `token_hash` does not match any session row (active or revoked) |
| `500` | `{ "error": "<underlying error message>" }` | `revokeSessionByHash` throws (session-store write fails) |

> The `401` envelope is reused for both "no auth" and "not authorised", the
> same way `/auth/logout` and `/auth/revoke` do, so probes cannot
> distinguish "no auth" from "wrong owner". A `404` is only returned when the
> bearer is valid but the requested `token_hash` does not exist at all.

The owner check uses case-insensitive equality:
`session.address.toLowerCase() === callerAddress.toLowerCase()`. The admin
check is an O(1) `Set<string>` lookup — see "Admin address Set" below.

---

## Dual-role token contract

`createSession` issues a single raw token, not a separate session token and
refresh token. That one token is valid both as:

- `session_token`, accepted by the bearer middleware
  (`src/auth/middleware.ts`) and `/auth/session/validate`;
- `refresh_token`, accepted by `/auth/refresh` — the lookup goes through the
  same `sessions` table by hash regardless of which field name the body used.

To make this contract discoverable from either endpoint's response alone,
**both `/auth/verify` and `/auth/refresh` return both field names for the
same value**:

- `/auth/verify` returns `session_token` (always present) and `refresh_token`
  (equal to it).
- `/auth/refresh` returns `refresh_token` (always present) and `session_token`
  (equal to it).

Purely additive — no field was removed or renamed, so callers that read
only one of the two names continue to work unchanged.

---

## Refresh-rotation security model

Implemented in `src/auth/session.ts` (`rotateSession` / `revokeFamily`):

- Every session/refresh token belongs to a `familyId`, assigned on first
  creation and preserved across rotations.
- `/auth/refresh` consumes the presented token (marks `rotatedAt`) and
  issues a new token in the same family.
- If a token that has **already** been rotated (or revoked) is presented
  again, that is treated as a **token-theft signal**: the entire family is
  revoked immediately (`revokeFamily`). Even the legitimately-rotated,
  currently-active token in the same family stops working, forcing the
  caller to re-authenticate from `/auth/challenge`.

Pre-existing rotation tests `it.skip(...)` in `src/routes/auth.test.ts`
carry a `TODO(lint-fix-310)` note tracking this path; they are not part of
this docs/contract change.

---

## Admin address Set (`rebuildAdminSet`)

`/auth/session/revoke` must check whether the caller is an admin. The naive
implementation allocates a new lowercased array on every request:

```ts
// before — O(n) allocation + linear scan per request
env.ADMIN_ADDRESSES.map((a) => a.toLowerCase()).includes(callerAddress.toLowerCase());
```

`auth.ts` builds a `Set<string>` of lowercased admin addresses once at
module load and reuses it across all requests:

```ts
// after — O(1) per request, one allocation at startup
adminAddressSet.has(callerAddress.toLowerCase());
```

If `env.ADMIN_ADDRESSES` is mutated after module load (e.g. in tests), the
exported `rebuildAdminSet()` synchronises the Set with the new array
contents. Without calling it, `isAdminAddress` keeps the pre-mutation view.
This helper is exported precisely so tests that push or pop entries can
rebuild deterministically and re-run the scenario.

---

## Debug middleware body clone

The first middleware on `authRouter` clones `req.body` for a structured log
line, redacting `session_token` and `signature` so plaintext never reaches
the log. The clone is skipped entirely when `req.body` is not a non-null
object:

```ts
if (req.body && typeof req.body === "object") { /* clone + redact */ }
```

Without this guard, every request with no JSON body would still spread
`req.body`, which previously failed with a `TypeError` on
`req.body = {}` (or on the unconditional `bodyLog.xxx = "***"` assignments).
The guard preserves the redaction behaviour for normal requests at zero
extra cost to no-body requests.

---

## Known limitations / out of scope

- **Address format regex is intentionally loose.** All four request schemas
  (`AddressBody`, `VerifyBody`, `SessionBody`, `RefreshBody`) restrict
  `address` to a maximum string length of 100 characters to prevent huge
  payloads from reaching downstream logic, but they deliberately omit a strict
  Starknet-address/hex regex check. This is left as-is to preserve compatibility
  with existing callers and tests (which use non-address placeholder strings such
  as `"address"` or `"0xExpiredChallenge"`); tightening it to strictly require
  hex digits is out of scope for this change.
- `signature` arrays are clamped to realistic length bounds (between 2 and 10 elements, max 255 chars per element) to reject excessively large or deeply nested payloads before signature verification.
- `getCachedNetworkInfo()` is already memoised in `src/starknet/client.ts`
  and adds no per-request overhead beyond a Map lookup; no change was
  needed there.
- The `chainIdCache` inside `src/auth/challenge.ts` (`buildTypedChallenge`)
  is likewise already memoised; the double-decode concern is already
  handled at that layer.

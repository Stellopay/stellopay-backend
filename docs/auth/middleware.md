# Auth Middleware Contract

This document is the authoritative contract for `src/auth/middleware.ts`. It
describes the principal-resolution boundary and the route-authorization
boundary that every HTTP route in this codebase relies on. Read this before
adding or moving a route that touches `req.auth`.

The implementation in `src/auth/middleware.ts` mirrors this contract line
for line; if the two files ever disagree, this document is the source of
truth and the implementation needs fixing.

## Why this exists

`requireAuth` and `requireAdmin` are the only two authorized sources of
`req.auth`. Centralizing them in a single module prevents privilege checks
from drifting as new routers are added, and gives the test suite one place to
exercise the boundary instead of N places.

## Principal resolution — `requireAuth`

`requireAuth` resolves the principal from the request headers and binds it
to `req.auth`.

**Inputs (read verbatim):**

| Header           | Purpose                                                                         |
| ---------------- | ------------------------------------------------------------------------------- |
| `x-user-address` | The Starknet wallet address of the calling user.                                |
| `authorization`  | `Bearer <token>`. The token is the session token issued by `POST /auth/verify`. |

**Failure modes** — all respond `401 { error: "Unauthorized" }` and never
call `next()`:

- Either header is missing, `undefined`, or a non-string (Node's HTTP
  parser can hand back multi-value headers as an array; calling
  `.startsWith()` on those would throw, and the type guard catches it).
- `authorization` does not start with `Bearer `.
- The trimmed token or the trimmed address is empty.
- `requireSession(address, token)` returns `false` or throws.

No failure path leaks the underlying reason, the session state, or the
admin allowlist. The 401 body is identical across failure modes so the
response cannot be used to probe header validity.

**Success path** — sets `req.auth = { address, token }` and calls `next()`:

- `req.auth.address` is the **lowercased header value, not the canonical
  `0x + 64 hex` form**. `auth/session.ts` writes the same lowercased value
  into the `sessions` table and does an exact 1:1 match on it. Adding
  canonical padding at the boundary would silently desync principal vs.
  session.
- `req.auth.token` is the trimmed bearer token. Routes that need to revoke
  the underlying session feed it to `revokeSession` from `auth/session.ts`,
  which hashes it before the DB query.
- `next()` is called **after** the try/catch — a throw in a downstream
  route must be caught by Express and surfaced as a 5xx, never silently
  relabeled as a 401.

## Route authorization — `requireAdmin`

`requireAdmin` may only be used **after** `requireAuth`. It reads
`req.auth.address` and the `ADMIN_ADDRESSES` env list (which
`config.ts` lowercases at startup) and makes a yes-or-no decision.

**Canonical comparison.** Both the principal address and every allowlist
entry are passed through `normalizeStarknetAddress` (which pads to 64 hex
characters, strips redundant leading zeros, verifies a mixed-case
checksum, and rejects malformed values) before the comparison. As a result
`0x1`, `0x000…001`, and a valid mixed-case checksum for the same address all
resolve to one canonical string.

**Failure modes** — each with a distinct HTTP status:

| Cause                                                    | Status | Body                        |
| -------------------------------------------------------- | -----: | --------------------------- |
| `req.auth` missing or `req.auth.address` is empty string |  `401` | `{ error: "Unauthorized" }` |
| Principal present, but cannot be parsed as an address    |  `403` | `{ error: "Forbidden" }`    |
| Parsed canonical ≠ every parsed allowlist entry          |  `403` | `{ error: "Forbidden" }`    |
| Malformed entry in `ADMIN_ADDRESSES` is silently         |  `403` | `{ error: "Forbidden" }`    |
| skipped (never matched, never crashed).                  |        |                             |
| Principal matches the allowlist                          | (next) | (route handler response)    |

The `401`/`403` split is deliberate: callers must be able to tell "you are
not signed in" apart from "you are signed in but not allowed". Collapsing
them into a single 401 (the previous behaviour) made clients retry
credentials forever on the second case.

**Success path** — calls `next()` and lets the route handle the request.

## How callers consume `req.auth`

`/auth/logout` reads `req.auth.token` and passes it to
`revokeSession(token)`. `/auth/revoke` reads `req.auth.address` and passes
it to `revokeAllSessionsForAddress(address)`. Both downstream functions
do their own lowercase normalization, so the middleware's
"raw lowercase header" choice is compatible without further massaging.

Diagnostic, backfill, and reprocess-event routes layer
`requireAuth, requireAdmin` per route. Order matters — `requireAdmin`
asserts `req.auth` is present, so it MUST run after `requireAuth`.

## Tests

`src/auth/middleware.test.ts` covers the full contract:

- `requireAuth` failure paths (missing header, non-string array header,
  non-Bearer, empty trimmed token, empty trimmed address, invalid session,
  throwing session lookup).
- `requireAuth` success path (lowercased address stored, raw token
  stored, next called).
- `requireAdmin` 401 path (missing `req.auth`, empty address).
- `requireAdmin` 403 path (non-admin authenticated, malformed
  principal, allowlist has malformed entries).
- `requireAdmin` success paths including canonical padding equivalence
  between admin and principal.

`src/routes/diagnostics.test.ts` exercises the boundary end-to-end with
the real middlewares and a mocked session, so changing the
401/403 contract will fail the route test too.

## Out of scope

The following are explicitly NOT part of this contract:

- Adding a third role beyond `admin`.
- Theming the unauthorized response (e.g. Web3 wallet prompts).
- Rate-limiting on the principal itself (see `middleware/rate-limit.ts`).
- Session creation, which lives in `auth/session.ts`.
- Token refresh/rotation, which lives in `routes/auth.ts`.

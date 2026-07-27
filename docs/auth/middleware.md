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

## Public surface

Everything below is exported and covered by the compatibility guarantees at
the end of this document. Nothing else in the module is public.

| Export                                                      | Kind       | Purpose                                             |
| ----------------------------------------------------------- | ---------- | --------------------------------------------------- |
| `requireAuth`                                               | middleware | Resolve the principal from headers, bind `req.auth` |
| `requireAdmin`                                              | middleware | Gate a route on the admin allowlist                 |
| `AuthPrincipal`                                             | type       | The shape bound to `req.auth`                       |
| `getPrincipal(req)`                                         | function   | Read the principal, or `null`                       |
| `requirePrincipal(req)`                                     | function   | Read the principal, throwing when absent            |
| `isAdminPrincipal(address)`                                 | function   | The allowlist decision `requireAdmin` makes         |
| `PRINCIPAL_HEADER`, `AUTHORIZATION_HEADER`, `BEARER_PREFIX` | constants  | The header names and prefix read verbatim           |
| `UNAUTHORIZED_STATUS`, `FORBIDDEN_STATUS`                   | constants  | `401` / `403`                                       |
| `UNAUTHORIZED_BODY`, `FORBIDDEN_BODY`                       | constants  | The two frozen denial bodies                        |

### `AuthPrincipal`

```ts
type AuthPrincipal = { address: string; token: string };
```

The global `Express.Request` augmentation is declared **in terms of this
type**, so the exported type and the runtime shape of `req.auth` cannot drift
apart. Import it rather than re-declaring the object literal.

### Reading the principal

`req.auth` is stable and is not going away. New code should still prefer the
accessors:

```ts
const principal = getPrincipal(req); // AuthPrincipal | null
const principal = requirePrincipal(req); // AuthPrincipal, throws if absent
```

`getPrincipal` returns `null` under exactly the predicate `requireAdmin` has
always used — `req.auth` missing, or `req.auth.address` empty. Using it means
a caller does not re-implement that check, and `requirePrincipal` removes the
need for a non-null assertion (`req.auth!`) that would silently become wrong
if a route were ever mounted without `requireAuth`. `requirePrincipal` throws
rather than responding, because a route reaching it without a principal is a
wiring mistake and belongs in the 5xx bucket, not the 401 one.

### Asking the admin question directly

`isAdminPrincipal(address)` is the same decision `requireAdmin` makes,
exported for routes that need to vary a response for admins without gating the
whole route. `requireAdmin` delegates to it, so the two can never disagree.
It never throws: a malformed principal, a malformed allowlist entry, and an
empty allowlist all resolve to `false`.

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
resolve to one canonical string. This comparison lives in
`isAdminPrincipal`, which `requireAdmin` delegates to.

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

## Compatibility guarantees

These are the promises existing callers already depend on. Each is pinned by a
case in the "compatibility guarantees" block of `src/auth/middleware.test.ts`,
so breaking one fails the suite rather than surfacing in production.

**Principal shape.**

1. `req.auth` is set on success and has **exactly** the keys `address` and
   `token`. An added key silently widens what routes can read; a removed one
   breaks `routes/auth.ts`'s logout and revoke handlers.
2. `req.auth.address` is the **raw lowercased header value**, not the
   canonical `0x + 64 hex` form. `auth/session.ts` does an exact 1:1 match
   against the lowercased value, so canonicalising here would desync
   principal vs. session for every already-issued session.
3. `req.auth.token` is the trimmed bearer token, **verbatim** — no case
   folding. `routes/auth.ts` feeds it straight to `revokeSession`, which
   hashes it; any normalization would make every logout miss.
4. `requireSession` is called with the **trimmed but not lowercased** address.
   It does its own normalization; lowercasing before the call would change
   which rows match.

**Failure behaviour.**

5. Every `requireAuth` failure path responds with the **identical** body and
   never sets `req.auth`. No reason code, no varying shape — the response must
   not be usable to probe which header was wrong or whether a session exists.
6. The `401`/`403` split in `requireAdmin` is load-bearing. Unauthenticated is
   never `403`; an authenticated non-admin is never `401`. Collapsing them (the
   behaviour before this split existed) made clients retry credentials forever
   on the second case.
7. `requireAdmin` is a **pure gate**: on success it calls `next()` exactly once
   without touching the response, and it never canonicalises, annotates, or
   otherwise rewrites what `requireAuth` bound.
8. A malformed value — a malformed principal, a malformed `ADMIN_ADDRESSES`
   entry, or an empty allowlist — is always "not a match". It never throws and
   never accidentally grants access.

**Response bodies.**

9. `UNAUTHORIZED_BODY` and `FORBIDDEN_BODY` are frozen, but each response is
   sent a **fresh copy**. Sending the frozen constant itself would make any
   body-rewriting middleware downstream throw on a frozen target.

**What counts as a breaking change.** Adding an optional field to
`AuthPrincipal`, or adding a new export, is backward compatible. Changing any
of the nine points above — including adding a reason code to a denial body,
canonicalising `req.auth.address`, or renaming a header constant — is
breaking, and needs a coordinated change in `routes/auth.ts`,
`routes/billing.ts`, and every admin-gated router.

## Tests

`src/auth/middleware.test.ts` covers the full contract:

- `requireAuth` failure paths (missing header, non-string array header,
  non-Bearer, empty trimmed token, empty trimmed address, invalid session,
  throwing session lookup).
- `requireAuth` success path (lowercased address stored, raw token
  stored, next called).
- `requireAuth` idempotency paths (second call skips re-validation,
  original principal preserved when headers change between calls).
- `requireAdmin` 401 path (missing `req.auth`, empty address).
- `requireAdmin` 403 path (non-admin authenticated, malformed
  principal, allowlist has malformed entries).
- `requireAdmin` success paths including canonical padding equivalence
  between admin and principal.
- The exported constants (header names, statuses, frozen bodies) and the
  fresh-copy-per-response guarantee.
- `getPrincipal` / `requirePrincipal` presence, absence, and the
  same-object-as-`req.auth` guarantee.
- `isAdminPrincipal` across casing, padding, malformed principal, malformed
  and empty allowlists, plus an agreement check against `requireAdmin`.
- The nine compatibility guarantees above, one case each.

`src/routes/diagnostics.test.ts` exercises the boundary end-to-end with
the real middlewares and a mocked session, so changing the
401/403 contract will fail the route test too.

## Out of scope

The following are explicitly NOT part of this contract:

- Adding a third role beyond `admin`. `isAdminPrincipal` is deliberately a
  yes/no answer about one allowlist, not a general role resolver — a real
  role system would replace this module's authorization half rather than
  extend it.
- Migrating existing `req.auth` readers onto `getPrincipal` /
  `requirePrincipal`. The accessors are additive; `routes/auth.ts` and
  `routes/billing.ts` keep reading `req.auth` directly, and converting them
  is mechanical churn that belongs in its own change.
- A deprecation mechanism (runtime warnings, `@deprecated` tooling) for the
  direct `req.auth` reads. Nothing here is deprecated — `req.auth` remains
  supported indefinitely.
- Theming the unauthorized response (e.g. Web3 wallet prompts).
- Rate-limiting on the principal itself (see `middleware/rate-limit.ts`).
- Session creation, which lives in `auth/session.ts`.
- Token refresh/rotation, which lives in `routes/auth.ts`.

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

## Caller map

Every route that reads `req.auth` must go through one of the middlewares in
this module. The table below maps each consumer to what it imports and why.

| Consumer file                         | Imports                              | Purpose                                         |
| ------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `routes/auth.ts`                      | `requireAuth`                        | Logout/revoke endpoints read `req.auth`         |
| `routes/billing.ts`                   | `requireAuth`                        | Billing endpoints require a signed-in user      |
| `routes/diagnostics.ts`              | `requireAuth`, `requireAdmin`        | Admin-gated diagnostics                         |
| `routes/events.ts`                    | `requireAuth`, `requireAdmin`        | Admin-gated event inspection                    |
| `routes/backfill-events.ts`          | `requireAuth`, `requireAdmin`        | Admin-gated backfill trigger                    |
| `routes/reprocess-events.ts`         | `requireAuth`, `requireAdmin`        | Admin-gated reprocess trigger                   |
| `auth/middleware.test.ts`            | All exports                          | Full contract coverage                          |

Route files that import `requireAuth` without `requireAdmin` use the
principal for user-specific operations (e.g. looking up the caller's own
billing records). Routes that import both guard administrative operations.

## Related modules

This module depends on and integrates with the following:

| Module                              | Relationship                                                        |
| ----------------------------------- | ------------------------------------------------------------------- |
| `auth/session.ts`                   | `requireAuth` calls `requireSession` to validate the bearer token   |
| `auth/challenge.ts`                 | Session creation; the token that `requireAuth` reads is issued here |
| `config.ts`                         | Provides `env.ADMIN_ADDRESSES` for `requireAdmin`'s allowlist check |
| `utils/address.js`                  | Provides `normalizeStarknetAddress` used by `isAdminPrincipal`      |

Request flow:

```
Request → requireAuth → requireAdmin → Route handler
                |             |
          reads headers    reads req.auth
          calls session    checks allowlist
          binds req.auth
```

`requireAuth` MUST run before `requireAdmin` because `requireAdmin` reads
`req.auth` which `requireAuth` sets. Both are idempotent — see the
idempotency sections below.

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
always used — `req.auth` missing, `req.auth` set to `null`, or
`req.auth.address` empty (but NOT whitespace-only — see edge cases below).
Using it means a caller does not re-implement that check, and
`requirePrincipal` removes the need for a non-null assertion (`req.auth!`)
that would silently become wrong if a route were ever mounted without
`requireAuth`. `requirePrincipal` throws rather than responding, because a
route reaching it without a principal is a wiring mistake and belongs in the
5xx bucket, not the 401 one.

**Edge cases for `getPrincipal`:**

| Input                                      | Result                           |
| ------------------------------------------ | -------------------------------- |
| `req.auth` is `undefined`                  | `null`                           |
| `req.auth` is `null`                       | `null`                           |
| `req.auth.address` is `""` (empty string)  | `null`                           |
| `req.auth.address` is `null`               | `null`                           |
| `req.auth.address` is `"   "` (whitespace) | Returns the principal (not null) |

A whitespace-only address is NOT treated as absent — it falls through to
`isAdminPrincipal` and is rejected as malformed there. `requireAuth` cannot
produce a whitespace-only address (it trims and rejects empty after trim), so
this only arises if a downstream middleware mutates `req.auth`.

### Asking the admin question directly

`isAdminPrincipal(address)` is the same decision `requireAdmin` makes,
exported for routes that need to vary a response for admins without gating the
whole route. `requireAdmin` delegates to it, so the two must never disagree.
It never throws: a malformed principal, a malformed allowlist entry, an empty
allowlist, an empty string, and a bare `0x` prefix all resolve to `false`.

**Usage example:**

```ts
import { isAdminPrincipal, getPrincipal } from "../auth/middleware.js";

function handler(req: Request, res: Response) {
  const principal = getPrincipal(req);
  if (principal && isAdminPrincipal(principal.address)) {
    // Include admin-only fields in the response
  }
}
```

## Principal resolution — `requireAuth`

`requireAuth` resolves the principal from the request headers and binds it
to `req.auth`.

**Middleware signature:**

```ts
router.get("/protected", requireAuth, handler);
```

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

**Idempotency.** Once `req.auth` is set, subsequent `requireAuth` calls in
the same request lifecycle are no-ops — they skip re-validation and preserve
the original principal even if the request headers have changed. This is
load-bearing for route stacks where multiple routers each apply their own
`requireAuth`.

**Edge cases for header validation:**

| Input                                                                | Behaviour                                  |
| -------------------------------------------------------------------- | ------------------------------------------ |
| `x-user-address` is a `string[]` (multi-value header)                | 401 — type guard rejects non-string        |
| `authorization` is a `string[]` (multi-value header)                 | 401 — type guard rejects non-string        |
| Both headers are `string[]`                                          | 401 — type guard rejects first non-string  |
| `authorization` has correct `Bearer ` prefix but token is whitespace | 401 — empty after trim                     |
| `x-user-address` is all whitespace                                   | 401 — empty after trim                     |

## Route authorization — `requireAdmin`

`requireAdmin` may only be used **after** `requireAuth`. It reads
`req.auth.address` and the `ADMIN_ADDRESSES` env list (which
`config.ts` lowercases at startup) and makes a yes-or-no decision.

**Middleware signature:**

```ts
router.get("/admin-only", requireAuth, requireAdmin, handler);
```

Order matters — `requireAdmin` asserts `req.auth` is present, so it MUST
run after `requireAuth`.

**Canonical comparison.** Both the principal address and every allowlist
entry are passed through `normalizeStarknetAddress` (which pads to 64 hex
characters, strips redundant leading zeros, verifies a mixed-case
checksum, and rejects malformed values) before the comparison. As a result
`0x1`, `0x000…001`, and a valid mixed-case checksum for the same address all
resolve to one canonical string. This comparison lives in
`isAdminPrincipal`, which `requireAdmin` delegates to.

**Failure modes** — each with a distinct HTTP status:

| Cause                                                       | Status | Body                        |
| ----------------------------------------------------------- | -----: | --------------------------- |
| `req.auth` missing or `req.auth.address` is empty string    |  `401` | `{ error: "Unauthorized" }` |
| `req.auth` is a non-object (e.g. a string) at runtime       |  `401` | `{ error: "Unauthorized" }` |
| Principal present, but cannot be parsed as an address       |  `403` | `{ error: "Forbidden" }`    |
| Parsed canonical ≠ every parsed allowlist entry             |  `403` | `{ error: "Forbidden" }`    |
| Malformed entry in `ADMIN_ADDRESSES` silently skipped       |  `403` | `{ error: "Forbidden" }`    |
| (never matched, never crashed)                              |        |                             |
| Principal matches the allowlist                             | (next) | (route handler response)    |

The `401`/`403` split is deliberate: callers must be able to tell "you are
not signed in" apart from "you are signed in but not allowed". Collapsing
them into a single 401 (the previous behaviour) made clients retry
credentials forever on the second case.

**Idempotency.** `requireAdmin` is idempotent: once the principal is
authorized, the result is cached in `res.locals.adminAuthorized` and
subsequent calls short-circuit to `next()` without re-checking the
allowlist. This means allowlist changes during a request's lifecycle do
not affect an already-authorized principal, and the middleware stack can
be safely replayed without re-evaluating the allowlist.

**Success path** — calls `next()` and lets the route handle the request.

### Resilience

- **Session lookup failures are observable.** When `requireSession` throws
  (e.g. database connection issue), the error is logged via `console.warn`
  with the full error object before the request is denied with a standard
  401 response. The client-facing response does not leak the nature of the
  failure, but operators can detect infrastructure issues from the log.
- **Safe replay.** Both `requireAuth` and `requireAdmin` are idempotent,
  so applying them multiple times in a middleware stack (e.g. router-level
  + route-level) is safe and produces the same result as a single
  application.

## How callers consume `req.auth`

### Route handlers reading `req.auth`

Route handlers access the principal through `req.auth` (direct property read)
or via the accessors `getPrincipal` / `requirePrincipal`. The table below
shows how each caller uses the principal:

| Caller                              | Reads               | Passes to                          |
| ----------------------------------- | ------------------- | ---------------------------------- |
| `routes/auth.ts` — logout           | `req.auth.token`    | `revokeSession(token)`             |
| `routes/auth.ts` — revoke all       | `req.auth.address`  | `revokeAllSessionsForAddress(addr)` |
| `routes/billing.ts`                 | `req.auth.address`  | (looks up caller's billing records) |
| Admin-gated routes                  | `req.auth`          | (diagnostics, events, backfill)    |

Both downstream session functions do their own lowercase normalization, so
the middleware's "raw lowercase header" choice is compatible without
further massaging.

### Route-level middleware patterns

**User-only endpoint** (requires authentication, no admin check):

```ts
router.get("/billing/invoices", requireAuth, getInvoices);
```

**Admin-only endpoint** (requires both authentication and admin role):

```ts
router.get("/diagnostics/report", requireAuth, requireAdmin, getReport);
```

Both middlewares can be applied per-route or per-router. They are idempotent,
so applying them multiple times in a middleware stack is safe — downstream
routers can re-apply `requireAuth` without re-validating the session.

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
  throwing session lookup — including console.warn observability check).
- `requireAuth` success path (lowercased address stored, raw token
  stored, next called).
- `requireAuth` idempotency paths (second call skips re-validation,
  original principal preserved when headers change between calls).
- `requireAdmin` 401 path (missing `req.auth`, empty address,
  non-object `req.auth`, `req.auth.address` is null).
- `requireAdmin` 403 path (non-admin authenticated, malformed
  principal, allowlist has malformed entries).
- `requireAdmin` idempotency paths (short-circuit when
  `res.locals.adminAuthorized` is pre-set, second call skips re-check,
  allowlist changes ignored after first authorization).
- `requireAdmin` success paths including canonical padding equivalence
  between admin and principal.
- `requireAdmin` idempotency paths (short-circuit when
  `res.locals.adminAuthorized` is pre-set, second call skips re-check,
  allowlist changes ignored after first authorization).
- The exported constants (header names, statuses, frozen bodies) and the
  fresh-copy-per-response guarantee.
- `getPrincipal` presence, absence, null `req.auth`, null address,
  whitespace-only address, and the same-object-as-`req.auth` guarantee.
- `requirePrincipal` presence, absence, and empty-address edge case.
- `isAdminPrincipal` across casing, padding, malformed principal, empty
  string, bare `0x` prefix, malformed and empty allowlists, plus an
  agreement check against `requireAdmin`.
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
- Input format validation of the `x-user-address` header beyond
  non-empty-after-trim. Address format validation is the responsibility of
  `requireSession` (which checks the database) and `normalizeStarknetAddress`
  (used by `isAdminPrincipal`). Adding address format parsing at the
  middleware boundary would be a breaking change (see compatibility
  guarantee #2).

## Version history

| Change | Description |
| ------ | ----------- |
| #335   | Added idempotency to both `requireAuth` and `requireAdmin` |
| #327   | Implemented `requireAdmin` idempotency guard (was documented but not yet implemented) |
| #328   | Added regression coverage for edge cases |
| #329   | This document — caller map, usage examples, edge case tables, request lifecycle |

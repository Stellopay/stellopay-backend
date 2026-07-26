# Session lifecycle contract

This document describes the persistence, expiration, and invalidation rules that
are owned by [src/auth/session.ts](src/auth/session.ts). The goal is to keep the
runtime behavior, tests, and maintenance guidance aligned.

## Persistence

A new session is created by `createSession(address)` and stored as a single row in
`sessions` with the following contract:

- the raw session token is generated client-side and never stored in the database;
- the database stores a SHA-256 hash of the token, not the token itself;
- the wallet address is normalized to lowercase before persistence;
- the row always carries two expiry timestamps:
  - `expiresAt`: the sliding TTL for the current token;
  - `absoluteExpiresAt`: the hard maximum lifetime for the token family.

The initial values are derived from the module configuration:

- `expiresAt = now + SESSION_TTL_MS`
- `absoluteExpiresAt = now + SESSION_MAX_TTL_MS`

## Expiration

A session is considered valid only when all of the following are true:

- the token hash exists in the database;
- the token has not been revoked or rotated out;
- `expiresAt` is still in the future;
- `absoluteExpiresAt` is still in the future; and
- the presented address matches the stored address (case-insensitive).

The sliding expiry behaves as follows:

- every successful `requireSession` call refreshes `expiresAt` by one TTL window;
- the refresh never moves `expiresAt` past `absoluteExpiresAt`;
- `absoluteExpiresAt` is immutable once the row is created and remains the hard cap.

The boundary is inclusive for the current moment:

- a request at exactly the expiry boundary is still accepted;
- a request after the boundary is rejected.

## Invalidation

A session becomes invalid when one of the following happens:

- `revokeSession(token)` marks the matching row as revoked;
- `revokeFamily(familyId)` marks every row in that family as revoked;
- `revokeAllSessionsForAddress(address)` marks every row for that wallet as revoked;
- `rotateSession(address, token)` marks the presented token as rotated and issues a replacement token;
- `rotateSession` treats a reused rotated or revoked token as a compromise signal and revokes the whole family.

Any revoked or rotated token is rejected by `requireSession`.

## Sweep behavior

`sweepExpiredSessions(now)` deletes rows whose sliding expiry, absolute expiry, or
revocation state indicates they are no longer active. This is the cleanup path for
expired or explicitly invalidated sessions.

## Compatibility and scope

This contract is intentionally scoped to the existing module and its current
callers. The public function signatures remain unchanged, and the behavior above
is covered by the session tests in [src/auth/session.test.ts](src/auth/session.test.ts).

## Edge cases intentionally out of scope

- exporting session metrics to Prometheus or OTLP;
- adding request-scoped correlation IDs to the session module;
- changing the public function signatures for existing callers.
# Session Lifecycle Observability

This document describes the **observability contract** for `src/auth/session.ts`.
It pins down the structured logs and metric counters that every state
transition in the session lifecycle emits, so that SREs, dashboards, and
alerting rules can rely on a stable shape.

For the request-level access log, see `src/middleware/access-log.ts`. The
conventions in this file mirror that middleware: JSON output when
`LOG_FORMAT=json`, otherwise a single human-readable line.

## When to read this

- You are debugging session-related production failures and need to know
  which event names and counter names to grep for.
- You are writing a new caller of `createSession`, `requireSession`,
  `revokeSession`, `rotateSession`, `revokeFamily`,
  `revokeAllSessionsForAddress`, or `sweepExpiredSessions` and want to know
  what side effects to expect.
- You are adding a new session lifecycle event and need to keep the contract
  consistent.

---

## Lifecycle at a glance

```
               ┌─────────────┐
   /auth/verify│ createSession│
   ───────────▶│             │──▶ session.created (info)
               └──────┬──────┘    session_created_total += 1
                      │
                      ▼
   ┌──────────────────────────────────────┐
   │ requireSession / rotateSession      │  ← called on every authenticated request
   │                                      │
   │  valid ──▶ session.validated (debug)│
   │            session_validated_total  │
   │                                      │
   │  invalid ──▶ session.rejected (warn)│
   │              session_rejected_total  │
   │              + one of:               │
   │                session_rejected_unknown_token_total
   │                session_rejected_address_mismatch_total
   │                session_rejected_revoked_total
   │                session_rejected_expired_total
   │                                      │
   │  rotation OK ──▶ session.rotated     │
   │                  session_rotated_total│
   │                                      │
   │  reuse (rotated/revoked token seen)──▶ session.reuse_detected (warn)
   │                                       session_reuse_detected_total
   │                                       session.family_revoked (warn)
   │                                       session_family_revoked_total
   └──────────────────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────┐
   │ revokeSession / revokeFamily /       │
   │ revokeAllSessionsForAddress          │
   │   ──▶ session.revoked (info)        │
   │       session_revoked_total          │
   │   ──▶ session.family_revoked (warn) │
   │       session_family_revoked_total   │
   │   ──▶ session.all_revoked (info)    │
   │       session_all_revoked_total      │
   └──────────────────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────┐
   │ sweepExpiredSessions (every 10 min)  │
   │   ──▶ session.sweep_completed (info)│
   │       session_sweep_runs_total       │
   │       session_sweep_deleted_total    │
   │       session_sweeper_last_deleted_count (gauge)
   │       session_sweeper_last_run_at_ms  (gauge)
   │                                      │
   │   on DB error ──▶ session.sweep_failed (error)
   │                   session_sweeper_errors_total
   └──────────────────────────────────────┘
```

#### Sliding Expiration Write-Throttling
To minimize database write load during frequent API requests, `requireSession` implements write-throttling. The session's `lastSeen` and `expiresAt` timestamps are only updated in the database if the time elapsed since `lastSeen` is at least 1 minute (`60,000 ms`). Validations occurring within this 1-minute window return successfully without invoking write operations to the database.

### Token Rotation

## Structured log events

#### Concurrency & Transaction Safety
Token rotation is executed within a database transaction using row-level locking (`FOR UPDATE` on the matched session). This guarantees that concurrent rotation requests do not result in race conditions, ensuring that compromise detection and family revocation behave deterministically.

#### Compromise Detection (Family Revocation)

---
Every event is a single line. Format depends on `LOG_FORMAT`:

| `LOG_FORMAT`     | Output shape (per line)                                            |
| ---------------- | ------------------------------------------------------------------ |
| `json` (default) | `JSON.stringify({ timestamp, level, event, ...data })` to stdout   |
| anything else    | `[session] <ts> <LEVEL> <event> k1=v1 k2=v2 ...` to stdout         |

`LOG_LEVEL` (default `info`) filters by minimum severity. Levels, in
ascending verbosity: `error`, `warn`, `info`, `debug`.

| Event                     | Level | Emitted by                                  | Notable fields                                                                 |
| ------------------------- | ----- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `session.created`         | info  | `createSession` (success)                  | `address`, `expires_in_ms`, `absolute_expires_in_ms`                           |
| `session.validated`       | debug | `requireSession` (success)                 | `address`, `next_expires_at`                                                   |
| `session.rejected`        | warn  | `requireSession` / `rotateSession` (false) | `reason`, `address`                                                            |
| `session.rejected`        | error | `requireSession` (DB error) / `createSession` (DB error) | `reason="db_error"`, `operation` (`require` or `create`), `address`, `message` |
| `session.revoked`         | info  | `revokeSession`                            | `kind="single"`, `token_hash_prefix` (first 8 hex chars, never the raw token) |
| `session.rotated`         | info  | `rotateSession` (success)                  | `address`, `family_id`, `expires_in_ms`                                        |
| `session.reuse_detected`  | warn  | `rotateSession` (replay of stale token)    | `address`, `family_id`, `had_rotated_at`, `had_revoked_at`                     |
| `session.family_revoked`  | warn  | `revokeFamily` / reuse-detection path      | `family_id`                                                                    |
| `session.all_revoked`     | info  | `revokeAllSessionsForAddress`              | `address`                                                                      |
| `session.sweep_completed` | info  | `sweepExpiredSessions` (success)           | `deleted`, `now` (ISO timestamp)                                               |
| `session.sweep_failed`    | error | `sweepExpiredSessions` (DB error)          | `message`                                                                      |
| `session.sweeper_crashed` | error | background interval `.catch`               | `message`                                                                      |
| `session.revoke_already`  | info  | `revokeSession` / `revokeFamily` / `revokeAllSessionsForAddress` (idempotent re-revoke detected) | `kind` (`single` / `family` / `all`), `token_hash_prefix` (single only), `family_id` (family only), `address` (all only) |
| `session.revoke_retry`    | warn  | `withBoundedRetry` (revoke-family path)    | `kind`, `attempt`, `max_attempts`, `message` + kind-specific fields           |
| `session.revoke_failed`   | error | `withBoundedRetry` (revoke-family path, exhausted) | `kind`, `message` + kind-specific fields                                       |
| `session.sweep_retry`     | warn  | `withBoundedRetry` (`sweepExpiredSessions`) | `attempt`, `max_attempts`, `message`                                          |

### `session.rejected` reasons

The `reason` field is a **bounded enum** — never free-form text — so log
searches and dashboards stay predictable:

| Reason            | Meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `missing_input`   | `requireSession` called with empty `token` or empty `address`           |
| `unknown_token`   | Hash of the presented token does not match any row in `sessions`         |
| `address_mismatch`| Token is valid but was issued for a different wallet address            |
| `revoked`         | Row exists but `revokedAt` is set                                        |
| `expired_sliding` | `expiresAt` (sliding) is in the past                                     |
| `expired_absolute`| `absoluteExpiresAt` is in the past                                       |
| `db_error`        | DB query itself threw (network, constraint, etc.)                        |

---

## Metric counters

All metrics are **process-local**, monotonic counters (plus a small set of
gauges). They are exposed via `getSessionMetricsSnapshot()` from
`src/auth/session-metrics.ts` — for now, read them directly from a debug
endpoint or admin script. Wiring them into Prometheus / OTLP is intentionally
out of scope for this PR.

| Counter name                                  | Bumped by                                        |
| --------------------------------------------- | ------------------------------------------------ |
| `session_created_total`                       | `createSession` (success)                       |
| `session_validated_total`                     | `requireSession` returns `true`                  |
| `session_rejected_total`                      | Every `requireSession` / `rotateSession` non-`true` return path |
| `session_rejected_unknown_token_total`        | `reason="unknown_token"`                        |
| `session_rejected_address_mismatch_total`     | `reason="address_mismatch"`                     |
| `session_rejected_revoked_total`              | `reason="revoked"`                              |
| `session_rejected_expired_total`              | `reason="expired_sliding"` OR `reason="expired_absolute"` |
| `session_revoked_total`                       | `revokeSession` (non-empty token)               |
| `session_rotated_total`                       | `rotateSession` returns `{ ok: true, ... }`     |
| `session_reuse_detected_total`                | `rotateSession` saw a rotated/revoked token     |
| `session_family_revoked_total`                | `revokeFamily` (incl. the reuse-detection path) |
| `session_all_revoked_total`                   | `revokeAllSessionsForAddress`                   |
| `session_sweep_runs_total`                    | `sweepExpiredSessions` (success)                |
| `session_sweep_deleted_total`                 | `sweepExpiredSessions` (success), by `count`    |
| `session_sweeper_errors_total`                | `sweepExpiredSessions` DB error OR background `.catch` |
| `session_revoke_retry_total`                 | `withBoundedRetry` (revoke-family path, between attempts) |
| `session_revoke_failed_total`                | `withBoundedRetry` (revoke-family path, exhausted)        |
| `session_sweep_retry_total`                  | `withBoundedRetry` (`sweepExpiredSessions`, between attempts) |
| `session_revoke_already_total`               | `revokeSession` (idempotent re-revoke detected) |
| `session_family_revoke_already_total`        | `revokeFamily` (idempotent re-revoke detected)  |
| `session_all_revoke_already_total`           | `revokeAllSessionsForAddress` (idempotent re-revoke detected) |

| Gauge name                              | Set by                                   |
| --------------------------------------- | ---------------------------------------- |
| `session_sweeper_last_deleted_count`    | `sweepExpiredSessions` (success)         |
| `session_sweeper_last_run_at_ms`        | `sweepExpiredSessions` (success)         |

### Cardinality

Counter names are fixed strings — no labels with attacker-controlled
values. The only "label-like" field is the bounded `reason` enum, which is
encoded as a separate counter per reason (e.g.
`session_rejected_unknown_token_total`) so any single dashboard panel
stays at a fixed, small cardinality.

---

## Security rules

These rules are enforced by code review and by the
"never logs raw session tokens" test in `src/auth/session.test.ts`:

1. **Raw session tokens are never logged.** Only the SHA-256 hash is
   computed internally, and even that is only ever surfaced as an 8-char
   prefix (`token_hash_prefix`) under `session.revoked`. If you need to
   correlate a log line with a token, look it up by `address` instead.
2. **No signatures, refresh tokens, or one-time nonces are ever logged.**
   `routes/auth.ts` already redacts `session_token` and `signature` from
   the request log; the same redaction applies here.
3. **Addresses are lower-cased and emitted as-is.** Starknet addresses are
   not personally identifying information on their own, but treat them as
   pseudonymous identifiers when correlating across logs.
4. **Family IDs are random UUIDs (`crypto.randomUUID()`)** and are
   safe to log.

---

## Reading the metrics in tests

`src/auth/session-metrics.ts` exports:

```ts
resetSessionMetrics(): void;
getSessionMetricsSnapshot(): { counters: Record<string, number>; gauges: Record<string, number> };
SESSION_METRICS: { /* counter-name constants */ };
SESSION_GAUGES: { /* gauge-name constants */ };
```

Tests should `resetSessionMetrics()` in `beforeEach` and assert on
`getSessionMetricsSnapshot().counters[name]`. See `src/auth/session.test.ts`
for examples.

---

## Edge cases intentionally out of scope

- **No Prometheus / OTLP exporter.** Metrics live in-process; exporting
  them is a separate concern.
- **No `request_id` correlation.** The session module is request-agnostic.
  Wrap calls from route handlers with a request-id if you need to
  correlate a session log line with an HTTP request.
- **No login-rate / brute-force counter.** Existing
  `src/middleware/rate-limit.ts` already protects the auth endpoints;
  session-level rate metrics are not added here.
- **No challenge-nonce observability.** `createChallenge`/`consumeChallenge`
  are in-memory and intentionally cheap; they are not part of this contract.
- **No late-discovery of an already-revoked session.** `requireSession`
  still distinguishes `revoked` vs `expired_sliding` in the log, but it
  does not bubble that distinction up to the caller — the public contract
  stays `boolean`.
- **No batching of large sweeps.** `sweepExpiredSessions` runs as a single
  `DELETE … RETURNING …` against the `sessions` table. At our row volume
  this completes inside the 10-minute cadence; if it ever doesn't, the
  right fix is probably a partitioned sweep or a separate index on
  `expires_at` / `absolute_expires_at`, both of which are out of scope
  for this PR.
- **No cross-session sampling.** Reliability metrics live in-process, so
  each backend replica has its own count of retries / already-revokes.
  Routing through a TSDB / Prometheus exporter is intentionally deferred.

---

## Compatibility

- All public function signatures are unchanged.
- All existing tests in `src/auth/session.test.ts` and
  `src/routes/auth.test.ts` pass without modification.
- The background `setInterval` still runs only when `NODE_ENV !== "test"`.
- The behaviour of `requireSession`, `revokeSession`, `rotateSession`,
  `revokeFamily`, `revokeAllSessionsForAddress`, and `sweepExpiredSessions`
  is identical to the prior version; this PR only adds side channels.

---

# Session Lifecycle Reliability

This section describes the **reliability contract** introduced alongside
the observability contract above. The goal is to make session persistence,
expiration, and invalidation safely retryable on transient DB failure
without changing what callers see on the happy path.

For the structured event / counter names referenced below, see
[Structured log events](#structured-log-events) and
[Metric counters](#metric-counters) above.

## When to read this

- You are designing a new caller that performs bulk token revocation or
  relies on the sweeper, and want to know how many transient blips it
  absorbs before failing.
- You are debugging an alert on `session_revoke_failed_total` or
  `session_sweep_retry_total` and need to know whether the corresponding
  event shows up in the logs.
- You are adding a new session mutation (e.g. a "freeze" or "rename"
  operation) and want to follow the same retry + idempotency pattern.

## What we retry, and what we deliberately do not

Wrapped in `withBoundedRetry` (3 attempts, 50ms backoff, see
`src/auth/session-retry.ts`):

| Operation                                       | Why retry is safe                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `revokeSession` (UPDATE)                        | `SET revokedAt = now()` applied to the same row twice produces the same final state. |
| `revokeFamily` (UPDATE)                         | Same as above; per-family write is idempotent.                             |
| `revokeAllSessionsForAddress` (UPDATE)          | Same as above; per-address write is idempotent.                            |
| `sweepExpiredSessions` (DELETE)                 | Predicate is on `expiresAt` / `revokedAt`; the second attempt simply deletes fewer rows. |

Deliberately **NOT** wrapped (throws on first DB error):

| Operation                                       | Why retry would be unsafe                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `createSession` (INSERT)                        | A retry could leave a duplicate row; the in-memory `crypto.randomBytes` token is already returned to the caller, so a successful retry would issue a second token. |
| `rotateSession` (INSERT + UPDATE)               | Mid-flight retry after a partial commit would either leave a duplicated row or orphan the original session. |
| `requireSession` (SELECT + UPDATE)              | Verifying auth on the hot path; retrying would inflate p99 latency for every authenticated request and produce confusing duplicate `session.validated` events. The caller naturally retries the HTTP request. |

The `isRetryable(error)` predicate treats anything other than
`unique/constraint/permission` text in `error.message` as a candidate for
retry. Deterministic constraint violations always surface immediately so
the caller can react (e.g. surface a 4xx if appropriate).

## Idempotent re-revoke classification

Before the retry loop runs, every revoke-family function performs one
`SELECT` to check whether the row's `revokedAt` is already non-null. If
so, an **additional** `session.revoke_already` info log is emitted and an
**additional** counter is bumped:

| Function                         | "Already revoked" counter                       |
| -------------------------------- | ----------------------------------------------- |
| `revokeSession`                  | `session_revoke_already_total`                  |
| `revokeFamily`                   | `session_family_revoke_already_total`           |
| `revokeAllSessionsForAddress`    | `session_all_revoke_already_total`              |

The pre-existing `session_revoked_total` / `session_family_revoked_total`
/ `session_all_revoked_total` counters are **NOT** double-bumped on a
repeat call. The goal is to keep dashboards stable when a chatty client
or a slow retry path calls the same logout / family-revoke endpoint
twice: `REVOKED_total` reflects "this is how many distinct revocation
events happened" and `REVOKED_ALREADY_total` reflects "of those, how
many were idempotent re-plays".

## Retry events and counters

| Event name               | Level | Bumped counter                    | Emitted by                                  |
| ------------------------ | ----- | --------------------------------- | ------------------------------------------- |
| `session.revoke_retry`   | warn  | `session_revoke_retry_total`      | `withBoundedRetry` between attempts (kind = `single` / `family` / `all`) |
| `session.revoke_failed`  | error | `session_revoke_failed_total`     | After the final retry exhausts in `revokeSession` / `revokeFamily` / `revokeAllSessionsForAddress` |
| `session.sweep_retry`    | warn  | `session_sweep_retry_total`       | `withBoundedRetry` between attempts in `sweepExpiredSessions` |
| `session.revoke_already` | info  | `session_revoke_already_total` (family / all variants) | When a revoke-family call hits a row whose `revokedAt` is already non-null |

`session.revoke_failed` always rethrows the original error so the route
handler can return a 5xx. The pre-existing `session.sweep_failed` path
keeps running unchanged — it still returns `0` from the call side so the
periodic sweeper stays self-healing on the next tick.

## Compatibility with issue #124

The new event names reuse `SessionEventName`'s bounded enum in
`src/auth/session-metrics.ts`, so the JSON / line-based log shape is
unchanged. The new counters appear in `SESSION_METRICS` with stable
string names so dashboards can be migrated in lock-step. No public
function signature changed. All existing tests pass without
modification.

## New reliability helper

`src/auth/session-retry.ts` exposes:

```ts
withBoundedRetry<T>(
  op: () => Promise<T>,
  policy?: Partial<{
    maxAttempts: number;     // default 3
    delayMs: number;         // default 50
    isRetryable: (e) => boolean;  // default: deterministic hints are non-retryable
  }>,
  onRetry?: (info: { attempt; maxAttempts; error; delayMs }) => void,
): Promise<T>
```

It is small enough to be re-used by future session mutations (e.g. an
upcoming "freeze session" / "rename family" feature) so the entire
session module keeps one retry policy.

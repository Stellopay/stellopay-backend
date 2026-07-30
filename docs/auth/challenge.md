# Challenge Nonce Contract

This document is the authoritative contract for `src/auth/challenge.ts`. It describes the
nonce-challenge generation, expiry, and typed-data boundary that `src/routes/auth.ts`
relies on for wallet-ownership proof. Read this before adding or moving an auth route that
touches challenges.

The implementation in `src/auth/challenge.ts` mirrors this contract line for line, and
`src/auth/challenge.test.ts` asserts it case by case. If any of the three disagree, this
document is the source of truth and the other two need fixing.

## Why this exists

The wallet-login flow has three trust-bearing primitives:

1. The server-issued nonce — proves a wallet signed _for this request_, not an old session.
2. The nonce's TTL — closes the window in which a stolen nonce can be replayed.
3. The typed-data payload — must match byte-for-byte what the wallet sees, so the wallet's
   signature verifies against the same payload the backend recorded.

Each is owned by exactly one exported function below.

## Input validation & security contract

### Input requirements & failure behavior

| Operation | Input Requirements | Failure / Validation Behavior |
| --- | --- | --- |
| `createChallenge` | `address`: Non-empty parseable Starknet address string | Throws `Error` ("createChallenge: address is not a parseable Starknet address") on missing, invalid type, empty, or unparseable input. |
| `getChallenge` | `address`: Non-empty parseable Starknet address string | Returns `null` on missing, invalid type, empty, or unparseable input; emits `challenge_miss` / `reason: "invalid_address"`. |
| `clearChallenge` | `address`: Non-empty parseable Starknet address string | Safe no-op on missing, invalid type, empty, or unparseable input. |
| `consumeChallenge` | `address`: Non-empty parseable Starknet address string | Returns `null` on missing, invalid type, empty, or unparseable input; performs atomic read-and-delete on valid challenge. |
| `verifyChallenge` | `address`: Non-empty parseable Starknet address string; `nonce`: Non-empty string | Returns `null` on missing, invalid type, empty, or unparseable input; emits `challenge_verify_miss` / reason code. |
| `restoreChallenge` | `address`: Non-empty parseable Starknet address string; `record`: ChallengeRecord | Returns `false` on missing, invalid type, empty, or unparseable input. |
| `buildTypedChallenge` | `address`, `chainId`, `nonce`: Non-empty strings | Throws `Error` if any parameter is missing, invalid type, empty/whitespace, or unparseable. |

### Security guarantees & replay protection

1. **Atomic Consumption**: `consumeChallenge` reads and deletes the nonce in a single step, preventing concurrent verification race conditions (replay defense).
2. **Fail-Closed Validation**: Invalid, missing, non-string, or malformed inputs are rejected prior to Map lookups or processing.
3. **Early Fail-Fast Verification**: `verifyChallenge` validates the nonce against the store before typed data is built, catching stale/consumed nonces early.
4. **Idempotent Verification**: `verifyChallenge` returns deterministic results for the same inputs — safe for retry in delivery/verification flows.
5. **Entropy & Uniqueness**: Nonces are generated via CSPRNG (`crypto.randomBytes(16)`), providing 128 bits of entropy (formatted as 32 hex characters prefixed with `0x`).
6. **Log Sanitization**: Raw malformed input strings and internal error stack traces are omitted from structured telemetry logs to prevent log injection and memory bloat.

## Address keying

**Every entry is keyed by the canonical Starknet address**, obtained from
`normalizeStarknetAddress` in `src/utils/address.ts` — lowercase, `0x` + 64 hex, redundant
leading zeros stripped, mixed-case checksums verified.

This means `0x1`, `0x0001`, `0x000…001`, and `0xAABB` vs `0xaabb` all address the **same**
challenge slot. A client that writes an address one way when calling `/auth/challenge` and
another way when calling `/auth/verify` still resolves to its own nonce.

Anything that is not a parseable Starknet address is **not** a valid key:

| Function              | Malformed address behaviour                               |
| --------------------- | --------------------------------------------------------- |
| `createChallenge`     | **throws** — the caller asked to store something unusable |
| `getChallenge`        | returns `null`, logs `challenge_miss` / `invalid_address` |
| `clearChallenge`      | silent no-op                                              |
| `consumeChallenge`    | returns `null`, logs `challenge_miss` / `invalid_address` |
| `verifyChallenge`     | returns `null`, logs `challenge_verify_miss` / `invalid_address` |
| `restoreChallenge`    | returns `false`, no metric                                |
| `buildTypedChallenge` | **throws** — never sign a payload for an unusable wallet  |

The read paths degrade rather than throw so a malformed body cannot turn into a 500 on the
auth route. The write paths throw because storing or signing garbage is a caller bug.

## Generation — `createChallenge(address)`

Returns `{ nonce, expires_in_ms }`.

- `nonce` is `0x` + 32 hex characters — 16 bytes from `crypto.randomBytes`.
- `expires_in_ms` is how long the returned nonce remains valid **from now**.

**Idempotent within the active window.** If the address already holds an unexpired
challenge, the existing nonce is returned with its **remaining** TTL, and a
`challenge_replayed` metric is emitted instead of `challenge_created`. Two consequences,
both deliberate:

- A retry **cannot extend** the replay window. `expires_in_ms` shrinks on each retry; it
  never resets to `CHALLENGE_TTL_MS`.
- A retry **cannot invalidate** an in-flight `/auth/verify` for the same address by
  overwriting the nonce underneath it. `POST /auth/challenge` is therefore safe to retry.

Once the previous challenge has expired — or has been consumed by `/auth/verify` — the
slot is free and the next call mints a fresh nonce with the full TTL.

## Expiry

`CHALLENGE_TTL_MS` is **5 minutes**, fixed. Expiry is compared as `now > expiresAtMs`, so
**the exact expiry instant is still valid**; the millisecond after it is not. At that exact
instant `createChallenge` replays the nonce with `expires_in_ms: 0`.

Entries leave the store in three ways:

1. **Consumed** — `consumeChallenge` deletes on read (see below).
2. **Lazily evicted** — `getChallenge` / `consumeChallenge` delete an entry they find
   expired, and report `challenge_expired`.
3. **Swept** — see the next section.

### Bounding memory growth

Three independent bounds guard the in-memory store.

**Paginated opportunistic sweep.** `getChallenge` and `consumeChallenge` only evict an
entry when it is _read_. An address that requests a challenge and never calls
`/auth/verify` (an abandoned login, or an attacker enumerating addresses) would otherwise
sit in the map forever. Every 50th `createChallenge` call therefore initiates a sweep
pass that deletes entries whose TTL has already elapsed.

The sweep is **paginated** to bound synchronous work: each invocation checks at most
`SWEEP_BATCH_SIZE` (500) entries from a stable key snapshot (`sweepKeysSnapshot`) and
advances a cursor (`sweepOffset`) into it. The next sweep continues from where the
previous one stopped, starting a fresh snapshot when the previous cycle is complete.
This means a single sweep call costs O(SWEEP_BATCH_SIZE) regardless of store size.

The snapshot is captured once at the start of each pagination cycle (by copying the
Map's current keys into `sweepKeysSnapshot`). Because the snapshot is immutable for
the duration of the cycle, entries added or deleted between sweeps never shift the
resume position — the cursor is always an index into a fixed array, not a position
tied to the live-ordered Map.

At `SWEEP_BATCH_SIZE = 500` and a full store of 100,000 entries, a complete pass requires
200 sweep invocations. At the sweep interval of 50 `createChallenge` calls, a full pass
completes every 10,000 calls, which at realistic traffic volumes is well within the
5-minute TTL window. The page size (`SWEEP_BATCH_SIZE = 500`) and interval
(`SWEEP_INTERVAL = 50`) are tuned to keep per-invocation latency negligible even under
spike traffic.

**Last-resort full sweep.** When a **new** entry would exceed `MAX_CHALLENGES`,
`createChallenge` runs a full (un-paginated) sweep over the entire store to reclaim
whatever has already expired before throwing. This guarantees all expired entries are
reclaimed when the store is near the cap.

**Hard cap.** `MAX_CHALLENGES` is 100,000 — roughly 8MB at ~80 bytes per entry. If the
last-resort full sweep still leaves the store full, `createChallenge` emits
`challenge_rejected` / `reason: "store_full"` and throws. The route layer surfaces that as
a 5xx rather than silently dropping a security-relevant signal. Replaying an **existing**
challenge is never blocked by the cap — a full store must not break an in-flight login for
an unrelated address.

### Rationale for in-memory retention

Challenges are highly transient. Storing them in-memory avoids DB read/write overhead for
every unauthenticated challenge request. If the server restarts, or a different instance
handles the verification, the wallet client simply requests a new nonce — no negative
security implications and minimal user friction. The cost is that challenges are
per-instance; see "Out of scope".

## Reading — `getChallenge` vs `consumeChallenge`

`consumeChallenge` is the **only** safe way to read a challenge before signature
verification. It reads and deletes in a single synchronous step.

`getChallenge` is read-only. If it is called at the start of an async verification and the
challenge is only cleared afterwards, two concurrent requests can both read the same
still-valid nonce before either one clears it — letting the same challenge be consumed
twice, which is a replay bypass. Deleting at read time closes that gap: the second
concurrent caller sees it already gone.

`clearChallenge` drops a challenge without reading it, and is a no-op (no metric) when
there was nothing to delete.

## Verification — `verifyChallenge(address, nonce)`

Validates a nonce against the challenge store without consuming it. Returns the
`ChallengeRecord` if the nonce is valid and unexpired, otherwise `null`.

**Idempotent.** For the same valid input the function returns the same result
until the challenge expires or is consumed. This makes it safe to call
repeatedly in retry/delivery flows.

| Condition | Return value | Metric emitted |
| --- | --- | --- |
| Valid, unexpired, matching nonce | `ChallengeRecord` | (none) |
| Invalid address | `null` | `challenge_verify_miss` / `invalid_address` |
| Invalid nonce (null, empty, whitespace) | `null` | `challenge_verify_miss` / `invalid_nonce` |
| Address not found in store | `null` | `challenge_verify_miss` / `not_found` |
| Nonce does not match stored value | `null` | `challenge_verify_miss` / `nonce_mismatch` |
| Nonce expired | `null` | `challenge_expired` + lazy eviction |

Use `verifyChallenge` before building typed data to fail fast when the nonce
is already stale or consumed. Use `consumeChallenge` after signature
verification to atomically mark the nonce as used and prevent replay.

## Typed data — `buildTypedChallenge(address, chainId, nonce)`

Builds the SNIP-12 payload the wallet signs:

```json
{
  "primaryType": "Challenge",
  "domain": { "name": "StelloPay", "version": "1", "chainId": "SN_SEPOLIA", "revision": "1" },
  "message": { "action": "LOGIN", "wallet": "0x000…aabb", "nonce": "0x…" }
}
```

- `wallet` is the **canonical** address, matching the store key exactly. Normalising here
  keeps the signature stable no matter how the caller cased or padded the input.
- `chainId` is the decoded label (`SN_SEPOLIA`, `SN_MAIN`), not the raw felt — ArgentX and
  Braavos validate typed data against a JSON schema that expects the plain string.
  starknet.js re-encodes it per the declared `felt` types when hashing.
- `revision: "1"` is required by some wallets (e.g. Ready).
- The decode is memoised per chain ID. `buildTypedChallenge` runs on both
  `/auth/challenge` and `/auth/verify`, and the chain ID is effectively constant for the
  process lifetime, so the key space is one entry in practice.

## Telemetry

Every state transition emits exactly one JSON line on `console.info`, shaped
`{ metric, …fields, timestamp }`. `address` is always the **canonical key**, never a raw
caller-supplied string — so log lines for `0xabc`, `0xABC` and the padded form all
correlate to one login attempt, and log cardinality stays bounded by the address space
rather than by input formatting.

| Metric                  | Emitted when                                      | Fields                         |
| ----------------------- | ------------------------------------------------- | ------------------------------ |
| `challenge_created`     | A new nonce is minted                             | `address`, `expires_in_ms`     |
| `challenge_replayed`    | An active nonce is re-issued on retry             | `address`, `expires_in_ms`     |
| `challenge_rejected`    | The store is full and a new entry was refused     | `reason`, `size`               |
| `challenge_expired`     | A read found an entry past its TTL and evicted it | `address`                      |
| `challenge_miss`        | A read found nothing                              | `reason`, `address` when known |
| `challenge_cleared`     | `clearChallenge` actually deleted something       | `address`                      |
| `challenge_consumed`    | `consumeChallenge` returned a record              | `address`                      |
| `challenge_restored`    | `restoreChallenge` restored a consumed nonce      | `address`, `expires_in_ms`     |
| `challenge_verify_miss` | `verifyChallenge` found an invalid nonce          | `reason`, `address` when known |

`challenge_miss` carries `reason: "not_found" | "invalid_address"`. The
`invalid_address` case deliberately omits `address` — echoing an unparseable
caller-supplied string into logs is what would blow up cardinality.

`challenge_verify_miss` carries `reason: "invalid_address" | "invalid_nonce" | "not_found" | "nonce_mismatch"`.
The `invalid_address` and `invalid_nonce` cases omit `address`.

A successful `getChallenge` emits nothing: the metrics record state _transitions_, not
call volume.

## Compatibility guarantees

These are the promises existing callers — `src/routes/auth.ts` in particular —
already depend on. Each is pinned by a case in the "compatibility guarantees"
block of `src/auth/challenge.test.ts`, so breaking one fails the suite rather
than surfacing in production.

**Export surface.**

1. `createChallenge(address)` returns `{ nonce: string; expires_in_ms: number }`.
   `nonce` is always `0x` + 32 hex characters (16 bytes from `crypto.randomBytes`).
   `expires_in_ms` is the **remaining** TTL, not the fixed constant.
   Adding or removing a key in the return value breaks `/auth/challenge`.
2. `consumeChallenge(address)` returns `ChallengeRecord | null` — the **only**
   safe way to read a challenge before signature verification. `/auth/verify`
   depends on its atomic read-and-delete to close the replay race.
3. `getChallenge(address)` is read-only and returns `ChallengeRecord | null`.
   It never deletes the entry unless it is expired (lazy eviction).
4. `clearChallenge(address)` returns `void` and is always a no-op when there
   was nothing to delete.
5. `verifyChallenge(address, nonce)` returns `ChallengeRecord | null`.
   Idempotent validation that never consumes the nonce. Emits
   `challenge_verify_miss` with a reason code on failure.
6. `restoreChallenge(address, record)` returns `boolean`. Puts a consumed
   nonce back into the store within its TTL if the slot is empty.
7. `buildTypedChallenge(address, chainId, nonce)` returns a `TypedData` (from
   `starknet`). The wallet field inside `message` is the **canonical** Starknet
   address, not the raw caller-supplied string.
8. `CHALLENGE_TTL_MS` is `5 * 60 * 1000` (5 minutes), exported as a `const`.
   Changing it changes when every issued nonce expires.
9. `MAX_CHALLENGES` is `100_000`, exported as a `const`. Changing it changes
   the DoS hardening bound.
10. `challenges` (the `Map`) is exported so tests can assert on store contents
    and drive the size cap directly. Production code outside this module must
    go through the functions above; reading the Map directly couples the caller
    to the internal store type and eviction strategy.
11. `clearChallengesForTesting()` and `clearChainIdCacheForTesting()` are
    exported for test isolation only. Calling either in production invalidates
    every in-flight login or discards a warm cache.

**Nonce behaviour.**

10. A nonce is 16 cryptographic bytes, formatted as `0x` + 32 lower-case hex
    characters. `/auth/challenge` serialises it into `typed_data.message.nonce`
    and the wallet signs that exact string. Changing the byte count or the hex
    encoding changes the wire format of every issued challenge.
11. Nonce expiry is checked as `now > expiresAtMs` (**strictly greater**).
    The exact expiry instant is still valid; the millisecond after it is not.
    At that exact boundary `createChallenge` replays with `expires_in_ms: 0`.
12. The TTL is never extended on retry. A replay returns the **remaining** TTL,
    which shrinks toward zero on each call. A retry cannot push the expiry forward
    and therefore cannot extend the replay window.
13. A retry does **not** overwrite the nonce. A valid in-flight `/auth/verify`
    for the same address cannot be invalidated by a concurrent or subsequent
    `POST /auth/challenge`. The nonce stays stable until expiry or consumption.

**Address keying.**

14. Every entry in the challenge store is keyed by the **canonical** Starknet
    address (lowercase, `0x` + 64 hex, from `normalizeStarknetAddress`).
    `0x1`, `0x0001`, `0x000…001`, and mixed-case checksums for the same
    numeric address all resolve to the same slot.
15. `createChallenge` **throws** on a malformed address — the caller asked to
    store something unusable, and the route layer surfaces the error.
16. `getChallenge`, `clearChallenge`, and `consumeChallenge` **tolerate**
    malformed addresses: they return `null` or no-op without throwing.
    This keeps a malformed request body from turning into a 500 on the auth route.
17. `buildTypedChallenge` **throws** on a malformed address — it must never
    produce a typed-data payload with an unusable wallet field.

**Store lifecycle.**

18. Entries leave the store in exactly three ways: (a) consumed by
    `consumeChallenge`, (b) lazily evicted on read when expired, or
    (c) swept on the write path every 50 `createChallenge` calls.
    No background timer participates.
19. A full store (`MAX_CHALLENGES` entries) refuses new entries from
    **unrecognised** addresses. An address that already holds a slot can still
    replay its active challenge — a full store must not break an unrelated
    in-flight login.
20. The store is per-process and in-memory. A server restart or a different
    instance handling `/auth/verify` sees no active challenge; the client
    retries `/auth/challenge` to recover.

**Telemetry.**

21. Every state transition emits exactly one JSON line on `console.info` with
    the shape `{ metric, …fields, timestamp }`. Silent transitions (e.g. a
    `getChallenge` hit, or a `clearChallenge` no-op) emit nothing.
22. The `address` field in every metric is the **canonical** key, never a raw
    caller-supplied string. Log lines for `0xabc`, `0xABC`, and the padded form
    all correlate to one login attempt.
23. The nine metric names (`challenge_created`, `challenge_replayed`,
    `challenge_rejected`, `challenge_expired`, `challenge_miss`,
    `challenge_cleared`, `challenge_consumed`, `challenge_restored`,
    `challenge_verify_miss`) and their field shapes are
    part of this contract. Operators and dashboards already depend on them;
    renaming one or changing its payload is a breaking change.

**What counts as a breaking change.** Adding a new export, adding an optional
field to the `createChallenge` return value (callers use destructuring and
ignore unknown keys), or relaxing a throw into a return is backward compatible.
Changing any of the points above — including the nonce format, the TTL
value, the expiry comparison operator, the idempotency contract, or a metric
name — is breaking, and needs a coordinated change in `src/routes/auth.ts` and
any dashboard or alert that consumes the metric.

## Test helpers

`clearChallengesForTesting()` empties the store and resets the sweep counter
(`creationsSinceSweep`), the snapshot (`sweepKeysSnapshot`), and the page cursor
(`sweepOffset`); `clearChainIdCacheForTesting()`
empties the chain-ID memo. Both exist for test isolation only — calling either in production
would invalidate every in-flight login, reset pagination mid-pass, or discard a warm cache
for no reason.

The `challenges` Map itself is exported so tests can assert on store contents and drive the
size cap directly without minting 100,000 real nonces. Production code outside this module
must go through the functions above.

## Tests

`src/auth/challenge.test.ts` covers, for each section of this document:

- `buildTypedChallenge`: chain-ID decoding for both networks, primary type and message
  fields, domain fields, canonical wallet normalisation, decode memoisation (including one
  decode per _distinct_ chain ID), and the malformed-address throw.
- `createChallenge`: nonce shape and full TTL on the success path, canonical keying across
  casing/padding, replay inside the window, the remaining-TTL guarantee, the exact-expiry
  boundary in both directions, re-issue after expiry and after consume, isolation between
  addresses, and the malformed-address throw.
- Size cap: refusal at the cap, replay still permitted when full, sweep-then-succeed for a
  full-but-stale store, and recovery after draining.
- Sweep: a valid entry surviving unrelated traffic, an abandoned expired entry being
  evicted without ever being read, and not-yet-expired entries left in place.
- Batch sweep pagination: the per-invocation page limit (`SWEEP_BATCH_SIZE`), cursor
  advancement across multiple sweeps, snapshot completion and restart after a full pass,
  graceful handling of an empty store, cursor stability when entries are added between
  sweeps (drift immunity), and the last-resort full sweep when the store is full.
- `getChallenge` / `clearChallenge` / `consumeChallenge`: success, expiry boundary,
  not-found and invalid-address misses, silent no-ops, the consume-once replay race, and
  cross-format address resolution.
- `verifyChallenge`: valid unexpired nonce, expired nonce (with eviction), consumed nonce,
  wrong nonce on same address, invalid address, invalid nonce type, cross-format address
  resolution.
- `restoreChallenge`: restore within TTL when slot empty, expired record, occupied slot,
  invalid address, non-matching address key.

## Out of scope

Explicitly **not** part of this contract:

- **Shared/persistent storage.** Challenges are per-process. A horizontally scaled
  deployment behind a round-robin load balancer can land `/auth/challenge` and
  `/auth/verify` on different instances, and the second call will report no active
  challenge. Moving the store to Redis or Postgres would fix that at the cost of a
  round-trip on every unauthenticated request; it is a separate decision.
- **Background timer-based cleanup.** Deliberately not used, to avoid a persistent timer
  complicating process shutdown and test isolation.
- **Per-address rate limiting.** `createChallenge` bounds the store globally, not per
  caller. Request-rate limiting lives in `src/middleware/rate-limit.ts`; repeated failed
  verifications are handled by `src/auth/lockout.ts`.
- **HTTP status mapping.** `createChallenge` throwing on a malformed address surfaces
  through `routes/auth.ts`'s error handler as a 5xx, even though a 400 would describe it
  better. The Zod schema on that route accepts any string of length ≥ 3, so the gap is real
  but belongs to the route layer, not to this contract.
- **Nonce entropy tuning.** 16 bytes is fixed. Changing it would change the wire format of
  every issued challenge.

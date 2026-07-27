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

Two independent bounds guard the in-memory store.

**Opportunistic sweep.** `getChallenge` and `consumeChallenge` only evict an entry when it
is _read_. An address that requests a challenge and never calls `/auth/verify` (an
abandoned login, or an attacker enumerating addresses) would otherwise sit in the map
forever. Every 50th `createChallenge` call therefore scans the map and deletes any entry
whose TTL has already elapsed, regardless of whether it was ever read. This bounds
unread/abandoned entries to roughly one sweep interval's worth of traffic instead of the
lifetime of the process, without a background timer (which would complicate shutdown and
test lifecycles).

**Hard cap.** `MAX_CHALLENGES` is 100,000 — roughly 8MB at ~80 bytes per entry. When a
**new** entry would exceed it, `createChallenge` runs one last sweep to reclaim expired
entries, and if the store is still full it emits `challenge_rejected` /
`reason: "store_full"` and throws. The route layer surfaces that as a 5xx rather than
silently dropping a security-relevant signal. Replaying an **existing** challenge is never
blocked by the cap — a full store must not break an in-flight login for an unrelated
address.

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

| Metric               | Emitted when                                      | Fields                         |
| -------------------- | ------------------------------------------------- | ------------------------------ |
| `challenge_created`  | A new nonce is minted                             | `address`, `expires_in_ms`     |
| `challenge_replayed` | An active nonce is re-issued on retry             | `address`, `expires_in_ms`     |
| `challenge_rejected` | The store is full and a new entry was refused     | `reason`, `size`               |
| `challenge_expired`  | A read found an entry past its TTL and evicted it | `address`                      |
| `challenge_miss`     | A read found nothing                              | `reason`, `address` when known |
| `challenge_cleared`  | `clearChallenge` actually deleted something       | `address`                      |
| `challenge_consumed` | `consumeChallenge` returned a record              | `address`                      |

`challenge_miss` carries `reason: "not_found" | "invalid_address"`. The
`invalid_address` case deliberately omits `address` — echoing an unparseable
caller-supplied string into logs is what would blow up cardinality.

A successful `getChallenge` emits nothing: the metrics record state _transitions_, not
call volume.

## Test helpers

`clearChallengesForTesting()` empties the store and resets the sweep counter;
`clearChainIdCacheForTesting()` empties the chain-ID memo. Both exist for test isolation
only — calling either in production would invalidate every in-flight login or discard a
warm cache for no reason.

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
- `getChallenge` / `clearChallenge` / `consumeChallenge`: success, expiry boundary,
  not-found and invalid-address misses, silent no-ops, the consume-once replay race, and
  cross-format address resolution.

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

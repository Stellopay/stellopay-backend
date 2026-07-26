# Challenge Nonce Contract

This document is the authoritative contract for `src/auth/challenge.ts`. It
describes the nonce-challenge generation, expiry, and typed-data boundary
that `src/routes/auth.ts` relies on for wallet-ownership proof. Read this
before adding or moving an auth route that touches challenges.

The implementation in `src/auth/challenge.ts` mirrors this contract line
for line; if the two files ever disagree, this document is the source of
truth and the implementation needs fixing.

## Why this exists

The wallet-login flow has three trust-bearing primitives:

1. The server-issued nonce — proves a wallet signed _for this request_,
   not an old session.
2. The nonce's TTL — closes the window where a stolen nonce can be replayed.
3. The typed-data payload — must match byte-for-byte what the wallet sees
   so the wallet's signature verifies against the same payload the
   backend recorded.

## Rationale for In-Memory Retention
Challenges are highly transient. Storing them in-memory avoids unnecessary database read/write overhead for every unauthenticated challenge request. If the server restarts, the user's wallet client simply requests a new challenge nonce with no negative security implications and minimal friction.

## Bounding memory growth (expired-challenge sweep)

`getChallenge` and `consumeChallenge` only evict an entry when it is *read* —
an address that requests a challenge and never calls `/auth/verify` (an
abandoned login, or an attacker enumerating addresses) would otherwise sit in
the in-memory map forever, growing it without bound.

`createChallenge` guards against this with a lightweight, opportunistic sweep:
every 50th call scans the map and deletes any entry whose TTL has already
elapsed, regardless of whether it was ever read. This bounds unread/abandoned
entries to roughly one sweep interval's worth of traffic instead of the
lifetime of the process, without requiring a background timer (which would
complicate shutdown and test lifecycles).

This is a best-effort bound, not a hard guarantee — growth between sweeps
scales with the volume of `/auth/challenge` traffic in that window. It is out
of scope for this change to replace the sweep with a stricter bound (e.g. a
max map size with eviction) or a background timer; see "Out of scope" below.

## Out of scope
- **Hard upper bound / max-size eviction** — the sweep bounds growth
  opportunistically but does not cap the map at a fixed size. Under sustained,
  very high-volume abuse between sweeps, memory usage could still spike before
  the next sweep runs.
- **Background timer-based cleanup** — deliberately not used, to avoid a
  persistent timer complicating process shutdown and test isolation.
- **Idempotent re-issuance for the same address** — calling `createChallenge`
  again for an address that already has an active, unexpired challenge mints
  and stores a brand-new nonce (overwriting the old one) rather than reusing
  the existing one. This matches the existing lazy-refresh design and is
  unchanged by this update.

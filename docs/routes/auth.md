# Auth route reliability contract

This document describes the behavior of the auth routes in [src/routes/auth.ts](src/routes/auth.ts) so runtime behavior, tests, and callers all describe the same contract.

## Challenge issuance

- `POST /auth/challenge` creates a new short-lived challenge for the supplied wallet address.
- The response includes the wallet address, challenge nonce, TTL in milliseconds, chain ID, and the typed-data payload that the wallet should sign.
- A new challenge replaces any older unexpired challenge for the same address, so callers should treat the returned nonce as the active proof for the current login attempt.

## Signature verification and session issuance

- `POST /auth/verify` requires an existing challenge for the supplied address.
- If the challenge is missing or expired, the route returns `400` with an error that instructs the caller to request a new challenge.
- If the signature is invalid, the route returns `401` and leaves the existing challenge intact so the caller can retry with the same challenge without forcing a fresh login attempt.
- If the signature is valid but the backend cannot issue a session because of a transient session-store failure, the route returns `500` with `Unable to issue session. Please try again.` and creates a fresh challenge so the caller can safely retry.
- If the signature is valid and session issuance succeeds, the route consumes the challenge, issues a session token, and returns the token and expiry metadata.

## Replay protection

- A challenge is consumed exactly once after a successful signature verification.
- A second verification attempt for the same address and same challenge is rejected with `400` because the challenge has already been consumed.
- Concurrent verification attempts share the same guarantee: only one can succeed and the others are rejected.

## Out of scope

- Cross-process or multi-instance challenge sharing.
- Long-term persistence of challenges beyond the in-memory TTL.
- Any change to the session refresh/rotation contract outside this auth route.

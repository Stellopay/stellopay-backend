# Escrow Routes

## Overview

The `src/routes/escrow.ts` file defines the backend API surface for escrow
operations on Starknet. It exposes read-paths (balance, token, employer,
initialization status) and write-paths (initialize, fund, release, refund)
that prepare unsigned Starknet transaction payloads for client-side signing.

All addresses are normalised to canonical 64-hex-character form before use.
Write endpoints require a valid session (`wallet_address` + `session_token`);
the release route additionally enforces idempotency and a pre-execution
balance check.

---

## Balance Resolution Contract

Balance resolution is implemented in `getAgreementBalanceInternal` and shared
by `GET /escrow/:address/get_agreement_balance/:agreement_id` and the release
pre-execution check.

### Strategy: Indexed-first with contract fallback

1. **Indexed-first** — Queries `escrow_events` from the local database,
   filtered by `contractAddress` and `agreementId`, ordered by `blockNumber`.
   - **Deduplication:** Events are deduplicated by their unique `id` (computed
     as `transaction_hash + event_index`). The same Starknet event may appear
     multiple times in the indexer output; deduplication prevents
     double-counting.
   - **Replay math:** `Funded` events add to the balance; `Released` and
     `Refunded` events subtract.
   - **Clamping:** If the computed balance is negative (possible when releases
     are indexed before their corresponding fund events), it is clamped to `0`
     and a structured warning (`escrow_balance_clamped`) is logged.
2. **Contract fallback** — When indexed data is unavailable (empty result set)
   or the database query throws, the function calls `get_agreement_balance`
   directly on the Starknet escrow contract. The returned value is coerced
   from whatever type Starknet.js provides (bigint, number, string, or
   `{ low, high }` U256 object) into a `bigint`.

### Response contract

- **Success:** `{ agreement_id: string, balance: string, source: "indexed" | "contract" }`
- **Balance guarantee:** The returned `balance` is always a non-negative
  decimal string representing a U256 value.

---

## API Endpoints

### `GET /escrow/defaults`

Returns the configured default escrow contract address.

- **Auth:** None.
- **Response:** `{ address: string }`

---

### `GET /escrow/:address/get_token`

Returns the ERC-20 token address the escrow contract was initialised with.

- **Auth:** None.
- **Response:** `{ token: string }`
- **Edge case:** Throws if the escrow contract address is invalid or the
  contract call fails.

---

### `GET /escrow/:address/is_initialized`

Checks whether the escrow contract has been initialised by calling `get_token()`
and testing whether the result is a non-zero address.

- **Auth:** None.
- **Response:** `{ initialized: boolean, token: string | null }`
- **Soft failure:** When the `get_token()` contract call itself fails (e.g.
  network error or uninitialised contract), the response includes
  `initialized: false`, `token: null`, and an `error` field rather than
  throwing. A structured warning (`escrow_initialization_check_failed`)
  is logged.

---

### `GET /escrow/:address/get_agreement_balance/:agreement_id`

Retrieves the current balance for a specific agreement on a given escrow
contract.

- **Auth:** None.
- **Behavior:** Delegates to `getAgreementBalanceInternal` — see
  [Balance Resolution Contract](#balance-resolution-contract) above.
- **Response:** `{ agreement_id: string, balance: string, source: "indexed" | "contract" }`
- **Backward compatibility:** The response shape is stable. Callers always
  receive a non-negative decimal string for `balance`.

---

### `GET /escrow/:address/get_agreement_employer/:agreement_id`

Returns the employer address stored on the escrow contract for the given
agreement.

- **Auth:** None.
- **Response:** `{ agreement_id: string, employer: string }`

---

### `POST /prepare/escrow/:address/initialize`

Prepares an unsigned `initialize` transaction for client-side signing.

- **Auth:** Valid session required (`wallet_address` + `session_token`).
- **Body:** `{ wallet_address, session_token, token, manager }`
- **Response:** `{ call, wallet_address, nonce, chain_id }`
- **Returns 401:** On invalid session.

---

### `POST /prepare/escrow/:address/fund_agreement`

Prepares an unsigned `fund_agreement` transaction for client-side signing.

- **Auth:** Valid session required.
- **Body:** `{ wallet_address, session_token, agreement_id, employer, amount }`
- **Response:** `{ call, wallet_address, nonce, chain_id }`
- **Returns 401:** On invalid session.

---

### `POST /prepare/escrow/:address/release`

Prepares an unsigned `release` transaction for client-side signing.

This is the most heavily guarded write path:

1. **Session validation** — returns `401` on invalid session.
2. **Idempotency** — wrapped with `Idempotency-Key` replay protection (see
   [Idempotency Design Contract](#idempotency-design-contract) below). Retries
   with the same key and body replay the cached response.
3. **Pre-execution balance check** — resolves the current agreement balance
   and returns `400` with `"Insufficient agreement balance"` if the available
   balance is less than the requested amount.
4. **Transaction preparation** — populates the `release` call and fetches a
   fresh nonce and chain ID for the caller's wallet.

- **Auth:** Valid session required.
- **Body:** `{ wallet_address, session_token, agreement_id, to, amount }`
- **Response:** `{ call, wallet_address, nonce, chain_id }`
- **Returns 400:** When the agreement balance is insufficient.
- **Returns 401:** On invalid session.
- **Returns 409:** When the same idempotency key is reused with a different body.

---

### `POST /prepare/escrow/:address/refund_remaining`

Prepares an unsigned `refund_remaining` transaction for client-side signing.

- **Auth:** Valid session required **and** the caller must be the employer of
  the agreement (verified on-chain via `checkAgreementEmployerAuth`).
- **Body:** `{ wallet_address, session_token, agreement_id }`
- **Response:** `{ call, wallet_address, nonce, chain_id }`
- **Returns 401:** On invalid session.
- **Returns 403:** When the caller is not the agreement employer.

---

## Idempotency Design Contract

| Header / Field    | Type   | Required | Description                                                      |
| :---------------- | :----- | :------- | :--------------------------------------------------------------- |
| `Idempotency-Key` | String | Optional | Unique client-provided identifier for request replay protection. |

### What Makes a Request "the Same"?

A request is identified as duplicate if:

1. The HTTP request method is `POST`.
2. The URL matches `/prepare/escrow/:address/release`.
3. The `Idempotency-Key` (or `idempotency-key`) header matches a previously
   cached key for the same contract address.
4. The request body is identical (evaluated using a stable property-sorted
   JSON serialization).

### What's Guaranteed on Retry?

- **Within Cache TTL (24 hours):**
  - If the request succeeds first, retries with the same body return the
    exact same response (same nonce, same payload).
  - If the first transaction has already been signed and submitted to
    Starknet, trying to sign/submit the same payload again will fail on
    Starknet with a "duplicate nonce" error, guaranteeing no double-spend.
  - Retries with a mismatched body fail with `409 Conflict`.
- **After Cache TTL / Without Idempotency Key:**
  - The request is treated as a new prepare request.
  - The pre-execution balance check verifies if the remaining balance is
    sufficient.
  - If the previous release was already executed on-chain, the balance will
    be reduced, and the request will be rejected with `400 Bad Request`
    (unless the agreement was sufficiently funded to allow another release
    of the same amount).

### Edge Cases & Limitations (Intentionally Out of Scope)

- **Horizontal Scaling:** The idempotency cache is in-memory and node-local.
  If scaled horizontally, a shared store (like Redis) should be used.
- **4xx Caching:** Responses with `4xx` status codes are cached alongside
  successful ones. A subsequent replay of a previously-failed request returns
  the same error.
- **Out-of-Order Indexing:** The balance calculation clamps to 0 on database
  sync lags, but final consistency is achieved when events catch up or via
  the contract call fallback.

---

## Observability & Structured Logging

All key operations emit structured log events through `console.log` (info)
and `console.warn` (warning). In JSON log format these appear as parseable
objects; operators should monitor the following event types:

| Event                                 | Level       | Meaning                                                                                                                                              |
| :------------------------------------ | :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escrow_balance_resolved`             | info        | Balance was successfully resolved via indexed data or contract call. Includes `source`, `balance`, `agreement_id`, and `event_count` (indexed only). |
| `escrow_balance_fallback`             | info / warn | Indexed data was unavailable (`reason: "no_indexed_data"`) or the DB query failed (`reason: "db_error"`); falling back to on-chain contract call.    |
| `escrow_balance_clamped`              | warn        | The event-replay balance was negative; clamped to 0. Includes `raw_balance` for diagnostics.                                                         |
| `escrow_release_prepared`             | info        | A release transaction payload was prepared successfully. Includes `amount`, `agreement_id`, `balance`, and `source`.                                 |
| `escrow_release_insufficient_balance` | warn        | Release rejected because the current agreement balance is less than the requested amount. Includes `requested`, `available`, and `source`.           |
| `escrow_auth_failed`                  | warn        | Session validation failed for a write operation. Includes `route` and `wallet_address`.                                                              |
| `escrow_idempotency_cache_hit`        | info        | A previously cached response was replayed from the idempotency store.                                                                                |
| `escrow_idempotency_conflict`         | warn        | A retry with the same idempotency key but a different request body was rejected with 409.                                                            |
| `escrow_initialization_check_failed`  | warn        | The `get_token` contract call failed during initialization check; returning `initialized: false`.                                                    |

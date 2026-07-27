# Escrow Routes

## Overview
The `src/routes/escrow.ts` file defines the backend API surface for handling escrow operations, specifically balances and releasing funds.

---

## API Endpoints

### `GET /escrow/:address/get_agreement_balance/:agreement_id`
Retrieves the balance for a specific agreement on a given escrow contract.

#### Behavior
1. **Deduplicated Event Playback:** It first attempts to resolve the balance using local indexed data from the database (`schema.escrowEvents`). In doing so, it deduplicates database event records by their unique event ID (`id` column, computed as `transaction_hash + event_index`). This prevents duplicate delivery of the same blockchain event from corrupting the balance calculation.
2. **Event Replay Math:** The deduplicated events (`Funded`, `Released`, `Refunded`) are summed:
   - `Funded` adds to the balance.
   - `Released` and `Refunded` subtract from the balance.
3. **Negative Balance Clamping:** If the resulting balance would be negative (due to processing delays or out-of-order event indexing), it is clamped to `0`.
4. **On-Chain Fallback:** If indexed data is not found or the database query fails, it queries the Starknet contract directly via `get_agreement_balance(agreement_id)`.

#### Backward Compatibility
- The response format remains `{ agreement_id: string, balance: string, source: "indexed" | "contract" }`.
- Callers relying on valid `balance` will always receive a non-negative decimal string representing a U256 or BigInt value.

---

### `POST /prepare/escrow/:address/release`
Prepares a transaction payload to release funds from the escrow.

#### Behavior
- **Authentication:** Expects a valid session (`wallet_address` and `session_token`).
- **Idempotency (Request Replay Protection):**
  - Accepts an optional `Idempotency-Key` (or `idempotency-key`) header.
  - When provided, successful preparation responses (status code and body) are cached in memory for 24 hours.
  - Retrying a request with the same `Idempotency-Key` and the same request body will bypass the blockchain network calls and return the cached response (containing the original prepared Starknet transaction payload, nonce, and chain ID).
  - Retrying with the same `Idempotency-Key` but a different body is rejected with `409 Conflict`.
- **Pre-execution Balance Validation:**
  - Before preparing the release call and requesting a nonce, the server checks the current agreement balance (using the deduplicated database/contract lookup).
  - If the current balance is less than the requested `amount`, the route immediately returns `400 Bad Request` with an error message `Insufficient agreement balance`. This protects against preparing invalid transactions that are guaranteed to fail on-chain.
  - If the client retries a previously completed release without an idempotency key (or after the cache expired), the balance check will catch that the funds have already been released and safely return `400 Bad Request`.

#### Backward Compatibility
- Uses the standard session verification shared across routes.
- The `ReleaseBody` requires `agreement_id` (positive bigint), `to` (string min 3 chars), and `amount` (string min 1 char) for proper validation.
- Unchanged response envelope ensuring existing clients parsing `call`, `wallet_address`, `nonce`, and `chain_id` do not break.

---

## Idempotency Design Contract

| Header / Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `Idempotency-Key` | String | Optional | Unique client-provided identifier for request replay protection. |

### What Makes a Request "the Same"?
A request is identified as duplicate if:
1. The HTTP request method is `POST`.
2. The URL matches `/prepare/escrow/:address/release`.
3. The `Idempotency-Key` (or `idempotency-key`) header matches a previously cached key for the same contract address.
4. The request body is identical (evaluated using a stable property-sorted JSON serialization).

### What's Guaranteed on Retry?
- **Within Cache TTL (24 hours):**
  - If the request succeeds first, retries with the same body return the exact same response (same nonce, same payload).
  - If the first transaction has already been signed and submitted to Starknet, trying to sign/submit the same payload again will fail on Starknet with a "duplicate nonce" error, guaranteeing no double-spend.
  - Retries with a mismatched body fail with `409 Conflict`.
- **After Cache TTL / Without Idempotency Key:**
  - The request is treated as a new prepare request.
  - The pre-execution balance check verifies if the remaining balance is sufficient.
  - If the previous release was already executed on-chain, the balance will be reduced, and the request will be rejected with `400 Bad Request` (unless the agreement was sufficiently funded to allow another release of the same amount).

### Edge Cases Out of Scope
- **Horizontal Scaling:** The idempotency cache is in-memory and node-local. If scaled horizontally, a shared store (like Redis) should be used.
- **Pre-auth Cache:** Requests that fail authentication (`401 Unauthorized`) or validation (`400 Bad Request` due to schema issues) are not cached.
- **Out of Order Indexing:** The balance calculation clamps to 0 on database sync lags, but final consistency is achieved when events catch up or via the contract call fallback.

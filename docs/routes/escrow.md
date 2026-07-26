# Escrow Routes

## Overview
The `src/routes/escrow.ts` file defines the backend API surface for handling escrow operations, specifically balances and releasing funds.

## API Endpoints

### `GET /escrow/:address/get_agreement_balance/:agreement_id`
Retrieves the balance for a specific agreement on a given escrow contract.

**Behavior:**
1. It first attempts to resolve the balance using local indexed data from database (`schema.escrowEvents`).
2. If indexed data is found, it replays the events (`Funded`, `Released`, `Refunded`) to compute the balance.
3. If the resulting balance would be negative (due to processing delays or out-of-order events), it is clamped to `0`.
4. If indexed data fails or is completely empty, it gracefully falls back to querying the Starknet contract directly via `get_agreement_balance(agreement_id)`.

**Backward Compatibility:**
- The response format remains `{ agreement_id: string, balance: string, source: "indexed" | "contract" }`.
- Callers relying on valid `balance` will always receive a non-negative string (representing a U256 or BigInt value).

### `POST /prepare/escrow/:address/release`
Prepares a transaction payload to release funds from the escrow.

**Behavior:**
- Expects a valid session (`wallet_address` and `session_token`).
- Returns the calldata required for the `release` entrypoint on the Starknet contract.
- Includes the `nonce` and `chain_id` necessary to sign the payload client-side.

**Backward Compatibility:**
- Uses the standard session verification shared across routes.
- The `ReleaseBody` requires `agreement_id` (positive bigint), `to` (string min 3 chars), and `amount` (string min 1 char) for proper validation.
- Unchanged shape ensures existing clients parsing `call`, `nonce`, `chain_id` do not break.

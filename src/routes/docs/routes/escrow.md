# Escrow & Agreement Lifecycle Architecture

This document describes the lifecycle flow across `agreement`, `escrow`, and `transactions` services, as verified by the end-to-end integration test suite (`src/routes/escrow.lifecycle.test.ts`).

## Lifecycle Sequence

Employer                 API Router                 Indexer / DB
|                         |                           |
|--- 1. Create Agreement ->|                           |
|                         |---- Insert Agreement ---->|
|                         |                           |
|--- 2. Attempt Release ->|                           |
|    (Unfunded)           |-- Rejects (400) --------->| (No State Change)
|                         |                           |
|--- 3. Fund Escrow ----->|                           |
|                         |---- Index Funded Event -->|
|                         |                           |
|--- 4. Activate -------->|                           |
|                         |---- Update Status (1) --->|
|                         |                           |
|--- 5. Release Payment ->|                           |
|                         |---- Index Release Event ->|
|                         |---- Record Payment ------>|
|                         |---- Update Paid / Status->|


## Step-by-Step Breakdown

### 1. Seeding & Agreement Creation
Agreements start in status `0` (`Unfunded`). The database record tracks `employer`, `contributor`, token type, and `totalAmount`.

### 2. Guarded Pre-Execution Balance Checks
Before any transaction call payload is prepared for `release`, the backend queries `getAgreementBalanceInternal`:
- **Indexed-First Calculation**: Sums `Funded` events and subtracts `Released`/`Refunded` events.
- **Security Check**: If available balance is less than requested amount, the API immediately rejects with `400 Insufficient agreement balance` without modifying state.

### 3. Funding
Preparing funding payloads (`/prepare/escrow/:address/fund_agreement`) generates transaction signatures for client execution. Once confirmed on-chain, indexer events update `escrowEvents`, making the agreement balance available.

### 4. Activation & Execution
Agreements transition to active (`status: 1`) once funded. Work events and milestones are recorded.

### 5. Payment Release & Idempotency
- **Idempotency Enforcement**: `POST /prepare/escrow/:address/release` requires an `Idempotency-Key` header to protect against duplicate submissions.
- **Completion**: Once released, a `PaymentSent` record is indexed in `payments`, the agreement `paidAmount` is updated, and status advances to `2` (`Completed`).

## Unified Feed Verification
Querying `GET /transactions/:user_address` aggregates data from `agreements`, `escrowEvents`, `agreementEvents`, `employees`, and `payments` into a single timeline sorted by `createdAt`.
Verification
Run tests to confirm compliance and security guarantees:

Bash
pnpm test
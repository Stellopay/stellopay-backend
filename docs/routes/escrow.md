# Escrow Routes

The escrow routes (`src/routes/escrow.ts`) provide endpoints for querying and performing actions against the payroll escrow.

## Balance and Release Semantics
- **Balance Calculation**: Escrow balance calculations aggregate all valid indexed `Funded`, `Released`, and `Refunded` events. Negative balances resulting from data synchronization delays are safely clamped to `0` with a warning (`escrow_balance_clamped`).
- **Release Checks**: The `/prepare/escrow/:address/release` route computes current balances dynamically and validates limits before proceeding.
- **Resilience Strategy**: Un-indexed contracts or sync anomalies automatically fallback to querying the Starknet contract directly to guarantee consistent release logic.

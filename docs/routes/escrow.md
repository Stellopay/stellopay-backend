# Escrow Routes

The escrow routes (`src/routes/escrow.ts`) provide endpoints for querying and performing actions against the payroll escrow.

## Balance and Release Semantics

- **Balance Calculation**: Escrow balance calculations aggregate all valid indexed `Funded`, `Released`, and `Refunded` events. Negative balances resulting from data synchronization delays are safely clamped to `0` with a warning (`escrow_balance_clamped`).
- **Batched Pagination**: Balance resolution uses offset-based pagination with a fixed batch size (100 events per page) to avoid unbounded memory growth on long-lived agreements with thousands of events. The loop fetches pages until a page returns fewer rows than the batch size, accumulating the balance and deduplicating events across batches.
- **Ordering Stability**: Events are ordered by `(blockNumber, id)` to guarantee deterministic ordering across pages. The tie-breaker on `id` ensures stability when multiple events share the same block number.
- **Contract Fallback**: When no indexed events are found (first page returns empty), the function falls back to a direct Starknet contract call.
- **Release Checks**: The `/prepare/escrow/:address/release` route computes current balances dynamically and validates limits before proceeding.
- **Resilience Strategy**: Un-indexed contracts or sync anomalies automatically fallback to querying the Starknet contract directly to guarantee consistent release logic.

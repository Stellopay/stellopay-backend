# Indexed Routes

The indexed routes (`src/routes/indexed.ts`) expose data derived from the indexer's sync process.

## Freshness and Sync Checkpoints

The indexer sync checkpoint is deterministically derived using `deriveSyncCheckpoint`. It evaluates the maximum block number present in a set of retrieved records.

- The `GET /indexed/freshness` and `GET /indexed/checkpoint` endpoints retrieve this high-water mark.
- **Resilience:** The checkpoint derivation securely filters out missing or non-positive block numbers and provides fallback logging (`indexer_checkpoint_invalid_block`) if any invalid numbers are encountered during derivation.
- A `0` block number signifies an empty or un-synced state.

## Authorization
All checkpoint-related routes require an authenticated administrator session (`requireAuth` + `requireAdmin`) and enforce authorization before any internal database interactions.

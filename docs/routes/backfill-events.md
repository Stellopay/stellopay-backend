# Backfill Events Routes

The backfill routes (`src/routes/backfill-events.ts`) handle synthetic backfilling of indexer events.

## Resume Tokens and Replay Windows
- A resume token (`cursor`) can be passed to resume the backfill from a specific timeframe.
- **Freshness Boundaries**: To prevent unbound table scans or clock synchronization errors, a resume token in the future is subjected to a strict clock-skew tolerance (`CLOCK_SKEW_TOLERANCE_MS`). Tokens exceeding this threshold trigger a structured warning log (`backfill_resume_token_future`) and fail immediately with a 400 validation error.
- **Idempotency**: Providing a token deep in the past is explicitly supported since the deterministic event generation guarantees no duplicate entries.

## Checkpoints
- Batches of entries dynamically update their persisted checkpoints to safely recover from interruptions without reprocessing everything.

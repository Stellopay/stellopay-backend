# Backfill Events Routes

The backfill routes (`src/routes/backfill-events.ts`) handle synthetic backfilling of
indexer events for `EmployeeAdded` and `MilestoneAdded` event types.

## Resume Tokens and Replay Windows

### Input aliases

Three query-parameter names all feed the same replay-window boundary.
Any caller that supplies **one** of them will continue to work unchanged.

| Parameter      | Type   | Description                                      |
|----------------|--------|--------------------------------------------------|
| `before`       | string | ISO-8601 date. Primary parameter name.           |
| `resumeToken`  | string | Alias for `before`.                              |
| `cursor`       | string | Alias for `before`.                              |

If more than one is provided, the resolved value is determined by the
well-defined precedence **`before` → `resumeToken` → `cursor`**.  This is a
tiebreaker, not a validation error — old callers that happen to send both
`before` and `resumeToken` (e.g. a client migrating between parameter names)
always get a deterministic result.

### Output aliases

Every successful response includes three cursor fields that are **always
identical**:

| Field             | Type          | Description                                           |
|-------------------|---------------|-------------------------------------------------------|
| `nextCursor`      | string \| null | Primary cursor name. ISO-8601 `created_at` of the oldest row scanned in this page, or `null` if zero rows were scanned. |
| `nextResumeToken` | string \| null | Identical to `nextCursor`. Compatibility alias.       |
| `cursor`          | string \| null | Identical to `nextCursor`. Compatibility alias.       |

Callers may read whichever field they were written against; all three will
always have the same value.

### Freshness boundaries

- **Future dates** — a resume token more than `CLOCK_SKEW_TOLERANCE_MS`
  (60 seconds) ahead of the server clock are rejected with `400`. A
  structured warning is logged as `backfill_resume_token_future`.
- **Past dates** — accepted without bound. Since synthetic event IDs use
  `ON CONFLICT DO NOTHING`, replaying old tokens is idempotent and harmless.
- **Clock-skew tolerance** — tokens up to 60 s ahead of `Date.now()` are
  accepted, allowing for minor differences between client and server clocks.

### Auto-resume

When `before`, `resumeToken`, and `cursor` are all omitted, the route loads
the persisted checkpoint from `backfill_progress` and uses its `lastCursor`
as the resume boundary. An explicit parameter always takes precedence over
the persisted checkpoint.

## Checkpoints

- Batches of entries dynamically update their persisted checkpoints to safely
  recover from interruptions without reprocessing everything.
- The checkpoint batch size (`BACKFILL_CHECKPOINT_BATCH_SIZE = 100`) matches
  the DB transaction boundary — each batch and its checkpoint commit
  atomically.

## Backward-compatibility contract (Issue #264)

1. **Input alias stability** — `before`, `resumeToken`, and `cursor` are
   frozen parameter names. No existing caller that supplies any one of them
   will break.
2. **Precedence tiebreaker** — when multiple aliases appear, the order
   `before` → `resumeToken` → `cursor` applies deterministically.
3. **Output alias stability** — `nextCursor`, `nextResumeToken`, and `cursor`
   appear on every successful response. They are always identical; callers
   may read whichever field they prefer.
4. **Replay idempotency** — repeated calls with the same or older cursor
   never duplicate rows. The deterministic event-ID format
   (`{txHash}_backfill_{eventType}_{rowId}`) guarantees no collision with
   real on-chain events.
5. **Future-token rejection** — tokens more than 60 s ahead of the server
   clock are rejected, preventing unbounded table scans while tolerating
   normal clock drift.

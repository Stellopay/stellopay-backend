# Backfill Events

**Overview:**
The backfill endpoints allow administrators to synthesize events for employees and milestones that exist in the database but have not yet emitted or indexed their corresponding events (`EmployeeAdded` or `MilestoneAdded`).

These endpoints are used to restore a consistent indexer state safely.

## Endpoints

- `POST /api/v1/backfill/employee-events`
- `POST /api/v1/backfill/milestone-events`
- `GET /api/v1/backfill/status`

### Authentication and Authorization
All three routes require an active admin session (`requireAuth` + `requireAdmin`). `GET /backfill/status` is deliberately gated the same as the write endpoints — checkpoint state (row counts, error messages, timing) is an internal indexing detail, not something to expose publicly.

### Query Parameters

| Parameter     | Type              | Default | Max    | Description                                                     |
| ------------- | ----------------- | ------- | ------ | ----------------------------------------------------------------|
| `limit`       | number            | `1000`  | `5000` | Maximum number of rows to scan.                                 |
| `agreementId` | string            | —       | —      | Restrict backfill to a single agreement.                        |
| `before`      | ISO-8601 datetime | —       | —      | Resume cursor. Only scans rows with `created_at` strictly older than this timestamp. |
| `resumeToken` | ISO-8601 datetime | —       | —      | Alias for `before`.                                             |
| `cursor`      | ISO-8601 datetime | —       | —      | Alias for `before`.                                             |

*The default limit is defined by `DEFAULT_BACKFILL_LIMIT` (1000) and the maximum is defined by `MAX_BACKFILL_LIMIT` (5000).*

An invalid cursor or resume token value (anything that doesn't parse as a valid ISO date) is rejected with a `400 { "error": "<message>" }` response.

Omitting cursor parameters entirely preserves the pre-existing behavior of these endpoints: the newest un-backfilled rows (up to `limit`) are scanned, unbounded by any cursor.

### Performance & Architecture Optimizations

1. **Shared Execution Engine (`performBackfill`)**:
   Both backfill endpoints delegate to a single, unified execution function (`performBackfill`). This eliminates duplicate SQL construction, transaction handling, telemetry logging, and response formatting between route handlers.

2. **Bulk Batch Database Inserts**:
   Instead of performing $N$ sequential single-row insert queries inside a loop, all synthetic event records in a page are inserted in a single bulk `tx.insert(...).values(batchValues).onConflictDoNothing().returning()` query. This reduces database network round-trips from $O(N)$ to $O(1)$.

3. **Performance Telemetry**:
   Execution duration in milliseconds (`durationMs`) is calculated using `performance.now()` and included in both the JSON response and the structured `console.info` operational logs.

### Progress Persistence and Automatic Resumption

Every backfill call is checkpointed to a `backfill_progress` table, one row per job (`employee-events` / `milestone-events`). Rows are inserted in batches of 100 (`BACKFILL_CHECKPOINT_BATCH_SIZE`); each batch commits inside its own database transaction alongside a checkpoint update, so a batch's inserts and its checkpoint are always durable together. If the process crashes mid-request, only the in-flight batch is lost — every previously-committed batch's checkpoint accurately reflects what's actually in `agreement_events`.

**Omitting `before` now auto-resumes from the last checkpoint.** On each call, the effective cursor is the explicit `before` query parameter if provided, otherwise the job's persisted `lastCursor`. This means an operator can simply keep calling the endpoint (e.g. from a cron job or a retry loop) with no query parameters at all, and it will always pick up where the last successful batch left off — including after a crash or restart — instead of rescanning from scratch. Passing `before` explicitly still works exactly as before, for manual paging or reprocessing an older window.

**Accumulating totals on resume:** When a job resumes from a persisted checkpoint (without an explicit `before`), the running `totalScanned` and `totalCreated` counters start from the values persisted in the last checkpoint rather than from zero. This ensures that the final `totalScanned`/`totalCreated` values reported at job completion reflect the cumulative work across all invocations — including batches committed in previous runs.

**Transaction structure per request:**
1. Mark job as `running` (one transaction)
2. For each batch of `BACKFILL_CHECKPOINT_BATCH_SIZE` rows:
   - Insert synthetic events via `ON CONFLICT DO NOTHING`
   - Atomically update the progress checkpoint (totalScanned, totalCreated, lastCursor)
3. Mark job as `completed` (if no more pages) or `idle` (if `hasMore`), one transaction

**Known limitation:** the checkpoint is tracked per job name, not per `agreementId` filter. Running a scoped (`agreementId=...`) backfill still checkpoints and resumes against the same job-level cursor as an unscoped run — see "Known Limitations" below.

### Checking Progress: `GET /backfill/status`

Returns the persisted checkpoint for both jobs, so an operator can tell whether a backfill is running, idle, completed, or failed without guessing:

```json
{
  "jobs": [
    {
      "jobName": "employee-events",
      "status": "completed",
      "lastCursor": "2024-01-01T00:00:00.000Z",
      "totalScanned": 4213,
      "totalCreated": 187,
      "lastError": null,
      "startedAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:04:12.000Z",
      "completedAt": "2024-01-01T00:04:12.000Z"
    },
    {
      "jobName": "milestone-events",
      "status": "idle",
      "lastCursor": null,
      "totalScanned": 0,
      "totalCreated": 0,
      "lastError": null,
      "startedAt": null,
      "updatedAt": null,
      "completedAt": null
    }
  ]
}
```

`status` is one of:
- `idle` — either the job has never run, or its last page committed successfully and more rows may remain (`hasMore` was `true`).
- `running` — a request is actively processing (only observable via a concurrent call, since a single request completes synchronously; a process crash mid-request can also leave a job stuck reporting `running` until the next call overwrites it).
- `completed` — the last page scanned zero or a not-full set of rows: the job is caught up as of `lastCursor`.
- `failed` — the last call errored after at least the checkpoint reflected in `lastCursor`/`totalScanned`/`totalCreated`; `lastError` holds the message. The next call resumes from that checkpoint.

A job that has never run is still reported (`status: "idle"`, zeroed/null fields) so operators always see both job names.

### Resume Tokens and Replay Windows (manual paging)

Both endpoints scan rows ordered by `created_at DESC`, so without a cursor every call rescans starting from the newest un-backfilled row. The `before` (or `resumeToken` / `cursor`) parameter bounds that scan to a **replay window** older than a previously-seen point in time, and each response returns resume tokens so a caller can continue from where it left off:

```json
{
  "message": "Backfilled 3 EmployeeAdded events",
  "totalScanned": 10,
  "created": 3,
  "results": [
    {
      "employeeId": "emp_1",
      "agreementId": "agr_123",
      "status": "created"
    }
  ],
  "nextCursor": "2024-01-01T00:00:00.000Z",
  "nextResumeToken": "2024-01-01T00:00:00.000Z",
  "cursor": "2024-01-01T00:00:00.000Z",
  "hasMore": true,
  "durationMs": 14
}
```

- `nextCursor` / `nextResumeToken` / `cursor` — the ISO-8601 `created_at` timestamp of the oldest (last, since results are ordered newest-first) row in the current page, or `null` if zero rows were scanned.
- `hasMore` — `true` when the number of scanned rows equals the requested `limit` (the page was full and more rows may exist beyond it), `false` otherwise.
- `durationMs` — total time taken to scan candidate rows, batch insert synthetic events, and build response metrics.

**Paging through a large backlog:**

1. Call the endpoint with no cursor parameters.
2. Take the response's `nextCursor` (or `nextResumeToken`) and pass it as `before`, `resumeToken`, or `cursor` on the next call.
3. Repeat, always using the most recent response's `nextCursor` as the next request's cursor parameter.
4. Stop when `hasMore` is `false` or `nextCursor` is `null` — there is nothing older left to scan.

Because each page only requires rows strictly older than the last cursor seen, a caller that crashes or times out mid-backlog can safely restart from the last `nextCursor` it received without re-scanning (or re-processing) rows from completed pages.

### Safe and Idempotent Inserts

To guarantee that synthesized backfill events never collide with genuine on-chain events and that operations are safely repeatable — including replaying the same page more than once:

1. **Synthetic Event IDs**:
   A backfill event uses the format:
   `{transactionHash}_backfill_{eventType}_{rowId}`
   *(Implemented via the `buildBackfillEventId` helper).*
   Because genuine on-chain events use `{txHash}_{eventIndex}`, the `_backfill_` segment ensures collisions are impossible.

2. **Sentinel Event Index**:
   Every backfill row is inserted with an `eventIndex` of `0` (`BACKFILL_EVENT_INDEX`). The `_backfill_` segment in the synthetic event ID is the primary mechanism that distinguishes backfill rows from real on-chain events.

3. **Transaction Safety**:
   The database inserts run within a single transaction using `ON CONFLICT DO NOTHING`, rendering repeat calls completely safe (no-ops for already backfilled events). This guarantee is unaffected by cursor parameters: since the cursor only narrows the candidate row set, re-running any page (with or without a cursor) never creates duplicate events.

### Response Contract

Both endpoints return a `BackfillResponse` with the following shape:

```json
{
  "message": "Backfilled 3 EmployeeAdded events",
  "totalScanned": 10,
  "created": 3,
  "results": [
    {
      "employeeId": "emp_1",
      "agreementId": "agr_123",
      "status": "created"
    }
  ],
  "nextCursor": "2024-01-01T00:00:00.000Z",
  "nextResumeToken": "2024-01-01T00:00:00.000Z",
  "cursor": "2024-01-01T00:00:00.000Z",
  "hasMore": true,
  "durationMs": 14
}
```

The `results` array contains a preview sample limited to a maximum of 10 items (`RESULTS_PREVIEW_SIZE`). For the milestone endpoint, `milestoneId` is returned instead of `employeeId`.

## Known Limitations / Out of Scope

- **No concurrent/parallel worker partitioning**: These endpoints support single-caller sequential resumption only. There is no row-locking, worker-id sharding, or other mechanism to let multiple callers safely split a backlog and process it in parallel. Running two callers against the same backlog concurrently may cause both to scan overlapping rows (harmless, since inserts are idempotent, but wasteful). This is an intentional, documented trade-off — parallel backfill workers are out of scope.
- **Automatic scaling / pagination**: The caller must issue repeated requests, following the resume-token contract above, if the number of missing rows is extremely large.
- **Handling of events missing transaction hashes**: Records inserted through out-of-band means that completely lack an original `transaction_hash` cannot be safely backfilled using these routes, as the synthetic ID heavily relies on the source transaction hash.

## Input Validation

All query parameters are validated by `BackfillQuerySchema` before any database
operation begins:

| Parameter     | Type              | Default | Max    | Validation                                    |
| ------------- | ----------------- | ------- | ------ | --------------------------------------------- |
| `limit`       | number (coerced)  | `1000`  | `5000` | Must be a positive integer ≤ `MAX_BACKFILL_LIMIT`. Non-numeric or floating-point values are rejected. |
| `agreementId` | string            | —       | —      | Passed through as-is when present.            |
| `before`      | ISO-8601 datetime | —       | —      | Must be a parseable date. Invalid values produce the same `400 { "error" }` shape as other validation failures. |

Unknown query parameters are silently ignored.

## Implementation Notes

Both routes delegate to a shared `performBackfill` helper that:

1. **Loads persisted checkpoint** (when `before` is omitted) to auto-resume from the last committed cursor and accumulate totals from prior runs.
2. **LEFT JOINs** the source table (`employees` or `milestones`) with
   `agreement_events` on `transaction_hash` + `event_type` to find rows
   without a matching backfill event.
3. Applies the optional `agreementId` and `before` filters.
4. Orders results by `created_at DESC` so the cursor correctly pages
   backward through newest-first order.
5. **Batches inserts** in groups of `BACKFILL_CHECKPOINT_BATCH_SIZE` (100),
   with each batch running in its own transaction that atomically commits
   both the synthetic events and the progress checkpoint.
6. Marks the job as `completed` when no more pages remain, or `idle` when
   `hasMore` is true.
7. Returns a `BackfillResponse` with `nextCursor` (the oldest `created_at`
   in the page) and `hasMore` (page-full indicator).

Helper functions:
- `upsertBackfillProgress(tx, jobName, fields)` — creates or updates a row
  in `backfill_progress` within the given transaction.
- `getBackfillProgress(jobName)` — reads the current checkpoint for a job,
  used for auto-resume and status checks.

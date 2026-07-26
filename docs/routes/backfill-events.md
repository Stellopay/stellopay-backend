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

*The default limit is defined by `DEFAULT_BACKFILL_LIMIT` (1000) and the maximum is defined by `MAX_BACKFILL_LIMIT` (5000).*

An invalid `before` value (anything that doesn't parse as a date) is rejected with the same `400 { "error": "<message>" }` shape used for every other validation failure on these routes.

Omitting `before` entirely preserves the pre-existing behavior of these endpoints exactly: the newest un-backfilled rows (up to `limit`) are scanned, unbounded by any cursor.

### Progress Persistence and Automatic Resumption

Every backfill call is checkpointed to a `backfill_progress` table, one row per job (`employee-events` / `milestone-events`). Rows are inserted in batches of 100 (`BACKFILL_CHECKPOINT_BATCH_SIZE`); each batch commits inside its own database transaction alongside a checkpoint update, so a batch's inserts and its checkpoint are always durable together. If the process crashes mid-request, only the in-flight batch is lost — every previously-committed batch's checkpoint accurately reflects what's actually in `agreement_events`.

**Omitting `before` now auto-resumes from the last checkpoint.** On each call, the effective cursor is the explicit `before` query parameter if provided, otherwise the job's persisted `lastCursor`. This means an operator can simply keep calling the endpoint (e.g. from a cron job or a retry loop) with no query parameters at all, and it will always pick up where the last successful batch left off — including after a crash or restart — instead of rescanning from scratch. Passing `before` explicitly still works exactly as before, for manual paging or reprocessing an older window.

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

Both endpoints scan rows ordered by `created_at DESC`, so without a cursor every call rescans starting from the newest un-backfilled row. The `before` parameter bounds that scan to a **replay window** older than a previously-seen point in time, and each response returns a **resume token** so a caller can continue from where it left off:

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
  "hasMore": true
}
```

- `nextCursor` — the ISO-8601 `created_at` of the oldest (last, since results are ordered newest-first) row in the current page, or `null` if zero rows were scanned.
- `hasMore` — `true` when the number of scanned rows equals the requested `limit` (the page was full and more rows may exist beyond it), `false` otherwise.

**Paging through a large backlog:**

1. Call the endpoint with no `before` param.
2. Take the response's `nextCursor` and pass it as `before` on the next call.
3. Repeat, always using the most recent response's `nextCursor` as the next request's `before`.
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
   Inserts run in batches of `BACKFILL_CHECKPOINT_BATCH_SIZE` (100) rows, each batch in its own transaction, using `ON CONFLICT DO NOTHING`, rendering repeat calls completely safe (no-ops for already backfilled events). This guarantee is unaffected by `before`: since the cursor only narrows the candidate row set, re-running any page (with or without a cursor) never creates duplicate events.

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
  "hasMore": true
}
```

The `results` array contains a preview sample limited to a maximum of 10 items (`RESULTS_PREVIEW_SIZE`). For the milestone endpoint, `milestoneId` is returned instead of `employeeId`.

## Known Limitations / Out of Scope

- **No concurrent/parallel worker partitioning**: These endpoints support single-caller sequential resumption only. There is no row-locking, worker-id sharding, or other mechanism to let multiple callers safely split a backlog and process it in parallel. Running two callers against the same backlog concurrently may cause both to scan overlapping rows (harmless, since inserts are idempotent, but wasteful). This is an intentional, documented trade-off for this change — parallel backfill workers are out of scope.
- **Automatic scaling / pagination**: The caller must issue repeated requests, following the resume-token contract above, if the number of missing rows is extremely large.
- **Handling of events missing transaction hashes**: Records inserted through out-of-band means that completely lack an original `transaction_hash` cannot be safely backfilled using these routes, as the synthetic ID heavily relies on the source transaction hash.
- **Checkpoint granularity is per job, not per filter**: `backfill_progress` has one row per job name (`employee-events` / `milestone-events`). A scoped run (`agreementId=...`) still reads and writes the same job-level checkpoint as an unscoped run — there's no separate checkpoint per `agreementId`. Mixing scoped and unscoped calls against the same job is safe (inserts stay idempotent) but the persisted `lastCursor` reflects whichever call ran most recently, not a per-scope cursor.

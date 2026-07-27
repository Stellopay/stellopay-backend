# Backfill Events

**Overview:**
The backfill endpoints allow administrators to synthesize events for employees and milestones that exist in the database but have not yet emitted or indexed their corresponding events (`EmployeeAdded` or `MilestoneAdded`).

These endpoints are used to restore a consistent indexer state safely.

## Endpoints

- `POST /api/v1/backfill/employee-events`
- `POST /api/v1/backfill/milestone-events`

### Authentication and Authorization
Both routes require an active admin session (`requireAuth` + `requireAdmin`).

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

### Resume Tokens and Replay Windows

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

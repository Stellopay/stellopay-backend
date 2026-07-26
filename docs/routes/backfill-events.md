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

*The default limit is defined by `DEFAULT_BACKFILL_LIMIT` (1000) and the maximum is defined by `MAX_BACKFILL_LIMIT` (5000).*

An invalid `before` value (anything that doesn't parse as a date) is rejected with the same `400 { "error": "<message>" }` shape used for every other validation failure on these routes.

Omitting `before` entirely preserves the pre-existing behavior of these endpoints exactly: the newest un-backfilled rows (up to `limit`) are scanned, unbounded by any cursor.

### Resume Tokens and Replay Windows

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
   The database inserts run within a single transaction using `ON CONFLICT DO NOTHING`, rendering repeat calls completely safe (no-ops for already backfilled events). This guarantee is unaffected by `before`: since the cursor only narrows the candidate row set, re-running any page (with or without a cursor) never creates duplicate events.

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

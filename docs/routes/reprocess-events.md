# Reprocess Events Routes

Routes for re-decoding and re-processing on-chain events that were previously stored with a generic `AgreementStatusChange` type. These endpoints are owned by `src/routes/reprocess-events.ts` and are the single source of truth for event reprocessing, retry budgets, and quarantine status reporting.

All endpoints require authentication (`requireAuth` + `requireAdmin`).

## Endpoints

### `POST /reprocess-events/tx/:tx_hash`

Reprocess events for a single transaction.

**Validation**
- `:tx_hash` must be a valid Starknet transaction hash (0x-prefixed, 3–66 chars).

**Success response (200)**
```json
{
  "message": "Events reprocessed",
  "result": {
    "txHash": "0x...",
    "status": "processed | no_events | not_found | error",
    "eventsProcessed": 0,
    "eventLabels": [],
    "tokenVerified": true | false | undefined,
    "error": "string (only when status is error)"
  }
}
```

**Failure responses**
- `400` – invalid `tx_hash` format
- `404` – transaction not found on-chain
- `500` – unexpected server error

### `POST /reprocess-events/batch`

Reprocess events for multiple transactions. Per-tx errors never abort the rest of the batch.

**Validation**
- `tx_hashes` must be a non-empty array of valid Starknet tx hashes.
- Maximum of **50** hashes per request (`MAX_BATCH_SIZE`).

**Retry budget**
- Up to **50** transactions per request.
- Each hash is processed independently; failures are captured per result.

**Success response (200)**
```json
{
  "summary": {
    "total": 2,
    "processed": 1,
    "noEvents": 0,
    "notFound": 0,
    "errors": 1,
    "totalEventsProcessed": 1
  },
  "results": [
    {
      "txHash": "0x...",
      "status": "processed | no_events | not_found | error",
      "eventsProcessed": 0,
      "eventLabels": [],
      "tokenVerified": true | false | undefined,
      "error": "string (only when status is error)"
    }
  ]
}
```

**Failure responses**
- `400` – validation failure (empty array, invalid hash format, oversized array)
- `500` – unexpected server error

### `POST /reprocess-events/status-changes`

Reprocess all `AgreementStatusChange` events to decode their actual names. Only events still tagged as `AgreementStatusChange` are processed; already-updated events are automatically skipped. Re-runs are safe no-ops at the database level.

**Validation**
- `limit` (query, optional, default 100, max **1000**)
- `fromBlock` / `toBlock` (query, optional) — filter by block number range

**Retry budget**
- Up to **1000** events per request (`MAX_STATUS_LIMIT`).
- Unrecoverable events are reported in the response instead of failing the whole request.

**Quarantine and retry statuses**

Each event returns a `results` entry. The per-event statuses below act as a quarantine policy — unrecoverable events are surfaced to the caller rather than dropped.

| Status | Meaning | Retry advice |
|--------|---------|--------------|
| `updated` | Event type was successfully decoded and updated in the database. | None. |
| `no_change` | Event remains `AgreementStatusChange` after ABI and selector fallback. | Re-run later or inspect manually. |
| `dedup_skipped` | Duplicate `transaction_hash + event_index` within the same request. | None; dedup is per-request only. |
| `no_receipt` | Provider returned no receipt for the transaction hash. | Retry the single-tx endpoint after RPC recovery. |
| `event_not_found` | Receipt exists but lacks the expected event index. | Inspect receipt manually; likely a chain reorg or indexing lag. |
| `error` | Unexpected error while decoding or persisting the event. | Inspect `error` message and retry if transient. |

**Success response (200)**
```json
{
  "message": "Reprocessed 10 events, updated 8",
  "updated": 8,
  "results": [
    {
      "eventId": "0x..._0",
      "status": "updated",
      "oldType": "AgreementStatusChange",
      "newType": "AgreementActivated"
    },
    {
      "eventId": "0x..._1",
      "status": "no_change",
      "eventType": "AgreementStatusChange"
    }
  ]
}
```

**Failure responses**
- `400` – validation failure (invalid `limit`, negative block numbers)
- `500` – unexpected server error

## Shared Behavior

### Idempotency

All three endpoints delegate to `processTxReceipt` or use `ON CONFLICT DO NOTHING` keys. Re-submitting identical input produces no duplicate rows.

### Error handling

Validation errors now extract the first Zod `issue.message` (Zod v4 compatible) and return it as `{ error: "..." }` with a `400` status. Outer catch-all errors return `500`.

### Repeated-work reduction

`POST /reprocess-events/status-changes` caches `Contract` instances by contract address in a per-request `Map`. When multiple events share the same address, the parser instance is reused instead of re-instantiated per event.

## Edge Cases Out of Scope

- Soft-delete or purge of `AgreementStatusChange` rows is not provided by these routes.
- Cross-contract selector collisions are not validated; the selectors map is best-effort fallback only.
- The `dedup_skipped` quarantine state is per-request only and is not persisted across deployments.

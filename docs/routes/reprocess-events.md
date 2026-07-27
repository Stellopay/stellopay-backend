# Event Reprocessing Routes

Base path: `/api/v1/reprocess-events`

All three routes require the caller to be authenticated (`requireAuth`) and hold an admin role (`requireAdmin`). Unauthenticated or non-admin requests receive a `401`/`403` before any handler logic runs.

---

## In-Flight Idempotency Guard (HTTP 409)

To prevent race conditions, duplicate notification side effects, or redundant RPC processing caused by concurrent calls, an **in-flight reprocessing lock** guards all endpoints in `src/routes/reprocess-events.ts`.

- **Concurrency Rejection**: If a reprocessing request is initiated while another reprocessing job is actively running, the second request is immediately rejected with `HTTP 409 Conflict`:
  ```json
  { "error": "Reprocessing operation already in progress" }
  ```
- **Reliable Release Guarantee**: The lock is acquired at entry and guaranteed to be released in a `finally` block upon completion, failure, or exception, allowing subsequent requests to proceed safely once the current job finishes.

---

## `POST /reprocess-events/tx/:tx_hash`

Reprocess a single transaction's events to (re)decode their event names.

- **Params**: `:tx_hash` — a Starknet transaction hash (0x-prefixed, 3–66 hex characters).
- **Response** `200`:
  ```json
  { "message": "Events reprocessed", "result": { "txHash": "...", "status": "processed", "eventsProcessed": 1, "eventLabels": ["AgreementCreated-123"], "tokenVerified": true } }
  ```
- **Errors**: `400` invalid hash format, `404` transaction not found, `409` concurrent reprocess operation in progress.
- Delegates to the shared `processTxReceipt` (see `src/routes/events.ts`), which persists rows with `ON CONFLICT DO NOTHING` keyed on `transaction_hash + event_index` — re-running the same tx is a safe no-op.

---

## `POST /reprocess-events/batch`

Reprocess events for multiple transactions in one request.

- **Body**: `{ "tx_hashes": string[] }` — 1 to `MAX_BATCH_SIZE` (50) hashes.
- **Response** `200`:
  ```json
  {
    "summary": {
      "total": 2,
      "processed": 1,
      "noEvents": 0,
      "notFound": 0,
      "errors": 0,
      "totalEventsProcessed": 3,
      "duplicates": 1
    },
    "results": [ /* one entry per input hash, same order/length as tx_hashes */ ]
  }
  ```
- **Errors**: `400` on an empty/oversized array or invalid hash format, `409` concurrent reprocess operation in progress.

### Batching contract

- **Max batch size**: at most `MAX_BATCH_SIZE` (50) hashes per request; a larger array is rejected with `400` before any processing starts.
- **Per-tx error isolation**: a failure processing one hash (e.g. an RPC error) is captured into that hash's `results` entry with `status: "error"` and never aborts the rest of the batch.
- **Duplicate-hash dedup**: hashes are deduplicated using their `normalizeTransactionHash` form, so two spellings of the same hash are recognized as the same transaction. Each unique hash is passed to `processTxReceipt` **exactly once**. `summary.duplicates` reports how many entries were duplicates of an earlier hash in the same request.

---

## `POST /reprocess-events/status-changes`

Reprocess all events still tagged `AgreementStatusChange` so their real event name can be decoded from the on-chain receipt.

- **Query params**:
  - `limit` (optional, default `100`, max `1000`)
  - `fromBlock` (optional) — only events at or above this block number
  - `toBlock` (optional) — only events at or below this block number
- **Response** `200`:
  ```json
  {
    "message": "Reprocessed 2 events, updated 1",
    "updated": 1,
    "results": [ { "eventId": "...", "status": "updated", "oldType": "AgreementStatusChange", "newType": "AgreementActivated" } ],
    "hasMore": false
  }
  ```
- **Errors**: `400` on invalid query params, `409` concurrent reprocess operation in progress.

### Pagination contract

- **Deterministic order**: matching rows are ordered by `block_number ASC, event_index ASC`.
- **`hasMore` flag**: `true` whenever the page returned exactly `limit` rows. `false` when fewer than `limit` rows were returned.

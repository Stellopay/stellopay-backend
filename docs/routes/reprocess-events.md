# Event Reprocessing Routes

Base path: `/api/v1/reprocess-events`

All three routes require the caller to be authenticated (`requireAuth`) and
hold an admin role (`requireAdmin`). Unauthenticated or non-admin requests
receive a `401`/`403` before any of the logic below runs.

## `POST /reprocess-events/tx/:tx_hash`

Reprocess a single transaction's events to (re)decode their event names.

- **Params**: `:tx_hash` — a Starknet transaction hash (0x-prefixed, 3–66
  hex characters).
- **Response** `200`:
  ```json
  { "message": "Events reprocessed", "result": { "txHash": "...", "status": "processed", "eventsProcessed": 1, "eventLabels": ["AgreementCreated-123"], "tokenVerified": true } }
  ```
- **Errors**: `400` invalid hash format, `404` transaction not found.
- Delegates to the shared `processTxReceipt` (see `src/routes/events.ts`),
  which persists rows with `ON CONFLICT DO NOTHING` keyed on
  `transaction_hash + event_index` — re-running the same tx is a safe no-op.

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
- **Errors**: `400` on an empty/oversized array or an invalid hash format.

### Batching contract

- **Max batch size**: at most `MAX_BATCH_SIZE` (50) hashes per request; a
  larger array is rejected with `400` before any processing starts.
- **Per-tx error isolation**: a failure processing one hash (e.g. an RPC
  error) is captured into that hash's `results` entry with
  `status: "error"` and never aborts the rest of the batch.
- **Duplicate-hash dedup**: hashes are deduplicated using their
  `normalizeTransactionHash` form, so two spellings of the same hash (e.g.
  a padded 66-char hash vs. an unpadded one) are recognized as the same
  transaction. Each unique hash is passed to `processTxReceipt` **exactly
  once**, regardless of how many times it appears in the request. The
  `results` array still has the same length and index-correspondence as
  the input `tx_hashes` array — duplicate entries reuse the first
  occurrence's result object rather than being recomputed. `summary.total`
  is still `tx_hashes.length`; `summary.duplicates` reports how many
  entries were duplicates of an earlier hash in the same request. This
  keeps `summary.processed`/`totalEventsProcessed` an accurate reflection
  of the RPC calls actually made, while preserving positional
  compatibility for existing callers.

## `POST /reprocess-events/status-changes`

Reprocess all events still tagged `AgreementStatusChange` so their real
event name can be decoded from the on-chain receipt.

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
- **Errors**: `400` on invalid query params.

### Pagination contract

- **Deterministic order**: matching rows are ordered by `block_number ASC,
  event_index ASC`. This makes repeated calls with the same filters
  page through the backlog in a stable, forward-progressing order instead
  of relying on the database's unspecified default row order (which
  Postgres does **not** guarantee without an explicit `ORDER BY`).
- **`hasMore` flag**: `true` whenever the page returned exactly `limit`
  rows, signaling that more matching rows may exist beyond this page.
  `false` when fewer than `limit` rows were returned (the backlog for the
  given filters is exhausted).
- **Paging forward**: since the response only returns event-level
  results (not raw block numbers), a caller that wants to page through a
  large backlog should track the highest `blockNumber` it has seen among
  successfully-updated events (via a side query, or by widening `limit`)
  and re-invoke the endpoint with `fromBlock` set to one past that block.
  Combined with the deterministic ordering above, this guarantees forward
  progress across calls.

### Known limitations / out of scope

There is **no persistent retry-count or quarantine state** for events that
repeatedly fail to update in `/status-changes` (statuses `no_receipt`,
`event_not_found`, or `error`). Because such events never have their
`eventType` changed away from `AgreementStatusChange`, they remain
eligible for reprocessing on **every** subsequent call unless the caller
manually advances `fromBlock` past them.

Adding real retry-count/quarantine tracking would require a schema
migration (a new column on `agreement_events`, e.g. `retry_count` or
`quarantined_at`) and is intentionally **out of scope** for this change.
The deterministic ordering and `hasMore` signal above are a lighter-weight
fix that stabilizes the pagination contract without touching the schema;
operators who need to skip permanently-stuck rows should advance
`fromBlock` past them manually until quarantine tracking is added in a
follow-up.

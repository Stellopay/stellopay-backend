# Event Reprocessing Routes

Base path: `/api/v1/reprocess-events`

All three routes require the caller to be authenticated (`requireAuth`) and hold an admin role
(`requireAdmin`). Unauthenticated or non-admin requests receive a `401`/`403` before any
handler logic runs.

---

## In-Flight Idempotency Guard (HTTP 409)

An **in-flight reprocessing lock** guards all endpoints to prevent race conditions, duplicate
notification side effects, or redundant RPC processing from concurrent calls.

- **Concurrency rejection**: A second request while one is already running gets `HTTP 409`:
  ```json
  { "error": "Reprocessing operation already in progress" }
  ```
- **Reliable release**: The lock is always released in a `finally` block — even on exceptions.

Exported helpers (used by tests and monitoring):

| Export | Description |
|---|---|
| `acquireReprocessLock()` | Returns `true` if acquired, `false` if already held |
| `releaseReprocessLock()` | Unconditionally releases the lock |
| `getReprocessingLockStatus()` | Returns `true` while locked |
| `__resetReprocessLocks()` | Resets to `false`; test isolation only |

---

## Retry Budget and Quarantine

Request-level idempotency via `Idempotency-Key` is **not currently implemented** on this router.
Retry safety relies on the in-flight guard (see above) and the database's `ON CONFLICT DO NOTHING`
in the underlying `processTxReceipt` helper. Clients should wait for a response before retrying;
a locked endpoint returns `409 Conflict`.

## `POST /reprocess-events/tx/:tx_hash`

Reprocess a single transaction's events via the shared `processTxReceipt` helper.

**Auth:** `requireAuth` + `requireAdmin`

**Route param:** `:tx_hash` — 0x-prefixed hex, 3–66 characters (`TxHashSchema`).

**Success `200`:**
```json
{
  "message": "Events reprocessed",
  "result": {
    "txHash": "0x000...abcdef",
    "status": "processed",
    "eventsProcessed": 1,
    "eventLabels": ["AgreementCreated-123"],
    "tokenVerified": true
  }
}
```

**Quarantine `200`** (after exceeding `RETRY_BUDGET` failures):
```json
{
  "message": "Transaction quarantined after repeated failures",
  "attempts": 4,
  "error": "RPC timeout"
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid hash format |
| `404` | Transaction not found on-chain |
| `409` | Concurrent reprocess operation in progress |
| `500` | Processing error below quarantine threshold; body has `{ attempts, error }` |

Re-running the same tx is a safe no-op at the DB level: `processTxReceipt` uses
`ON CONFLICT DO NOTHING` keyed on `transaction_hash + event_index`.

---

## `POST /reprocess-events/batch`

Reprocess events for up to `MAX_BATCH_SIZE` (50) transactions in one call.

**Auth:** `requireAuth` + `requireAdmin`

**Request body:**
```json
{ "tx_hashes": ["0xaaa...", "0xbbb..."] }
```

**Success `200`:**
```json
{
  "summary": {
    "total": 2,
    "processed": 1,
    "noEvents": 0,
    "notFound": 0,
    "errors": 1,
    "totalEventsProcessed": 3,
    "duplicates": 0
  },
  "results": [
    { "txHash": "0x...", "status": "processed", "eventsProcessed": 1, "eventLabels": ["AgreementCreated-123"], "tokenVerified": true },
    { "txHash": "0x...", "status": "error", "attempts": 1, "eventsProcessed": 0, "eventLabels": [], "error": "RPC timeout" }
  ]
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Empty array, >50 hashes, or any hash fails `TxHashSchema` |
| `409` | Concurrent reprocess operation in progress |

**Contract:**

- **Per-tx error isolation**: a failure on one hash captures `status: "error"` in that entry and never aborts the rest of the batch.
- **Retry budget**: failed hashes accumulate a retry counter. After `> RETRY_BUDGET` failures the result is `status: "quarantined"` and a quarantine file is written.
- **Duplicate-hash dedup**: hashes are normalised to `0x` + 64-hex before dedup, so `"0xabc"` and `"0x000…abc"` are the same key. Each unique hash calls `processTxReceipt` **exactly once**. `summary.duplicates` counts entries that were copies of an earlier hash.

---

## `POST /reprocess-events/status-changes`

Re-decode all `agreementEvents` rows still tagged `"AgreementStatusChange"` using the
on-chain receipt, updating their `eventType` to the correct value.

**Auth:** `requireAuth` + `requireAdmin`

**Query parameters:**

- **Deterministic order**: matching rows are ordered by `block_number ASC, event_index ASC`.
- **`hasMore` flag**: `true` whenever the page returned exactly `limit` rows. `false` when fewer than `limit` rows were returned.

### Retry budget and quarantine

Each event gets at most `MAX_RETRIES` (3) attempts per status-changes run. A per-event retry count
is kept in an in-memory `Map` and incremented on each failure. When the count exceeds
`MAX_RETRIES`, that event's ID is added to a `Set`-based quarantine. On subsequent runs within the
same process lifetime, quarantined IDs are skipped at the start of the loop — they are logged as
`"skipping"` events. A failed event result includes both `status: "error"` and an `error` field.

The quarantine and retry maps are in-memory only (not persisted across restarts) and are reset by
the `__resetStatusChangeState()` export (used in tests, not intended for production callers).

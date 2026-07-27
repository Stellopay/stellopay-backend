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

### Per-transaction (tx and batch routes)

Failed transactions accumulate a retry counter keyed on their canonical
`0x` + 64-hex hash (produced by `normalizeTransactionHash`).

| Attempts | Behaviour |
|---|---|
| 1 – `RETRY_BUDGET` | `500` with `{ attempts, error }` |
| `> RETRY_BUDGET` | `200` quarantine response; JSON file written to `QUARANTINE_PATH` |

Quarantine file written to `<QUARANTINE_PATH>/<normalizedHash>.json`:
```json
{ "txHash": "0x000...abc", "error": "RPC timeout" }
```

### Per-event (status-changes route)

The status-changes route tracks failures **per event ID** independently, exported for tests:

```ts
export const statusChangeRetryCounts: Map<string, number>
export const statusChangeQuarantine: Set<string>
```

| Attempts | Behaviour |
|---|---|
| 1 – (`RETRY_BUDGET - 1`) | Result entry: `{ eventId, status: "<reason>" }` |
| `>= RETRY_BUDGET` (first) | Result entry: `{ eventId, status: "quarantined", reason }` — ID added to `statusChangeQuarantine` |
| Any call after quarantine | Result entry: `{ eventId, status: "quarantined" }` — RPC call skipped entirely |

Possible `reason` values: `"no_receipt"`, `"event_not_found"`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `RETRY_BUDGET` | `3` | Max failures before quarantine |
| `QUARANTINE_PATH` | `<cwd>/quarantine` | Directory for quarantine JSON files |

Calling `__resetRetryCounts()` clears both the per-tx `retryCounts` map and the per-event
`statusChangeRetryCounts` / `statusChangeQuarantine` state. For test isolation only.

---

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

| Param | Default | Max | Description |
|---|---|---|---|
| `limit` | `100` | `1000` (`MAX_STATUS_LIMIT`) | Max rows to process per call |
| `fromBlock` | — | — | Only events at or above this block number |
| `toBlock` | — | — | Only events at or below this block number |

**Success `200`:**
```json
{
  "message": "Reprocessed 3 events, updated 1",
  "updated": 1,
  "results": [
    { "eventId": "evt_1", "status": "updated", "oldType": "AgreementStatusChange", "newType": "AgreementActivated" },
    { "eventId": "evt_2", "status": "no_receipt" },
    { "eventId": "evt_3", "status": "quarantined", "reason": "no_receipt" }
  ],
  "hasMore": false
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Non-positive `limit`, non-integer block numbers |
| `409` | Concurrent reprocess operation in progress |

**Result `status` values:**

| `status` | Meaning |
|---|---|
| `"updated"` | `eventType` was corrected; DB row updated |
| `"no_change"` | Decoded as `AgreementStatusChange`; no update needed |
| `"dedup_skipped"` | Same `transactionHash + eventIndex` already processed in this batch |
| `"no_receipt"` | `provider.getTransactionReceipt` returned null (below quarantine threshold) |
| `"event_not_found"` | `receipt.events[eventIndex]` is undefined (below quarantine threshold) |
| `"quarantined"` | Per-event retry budget exceeded; RPC call skipped |
| `"error"` | Unexpected exception; body has `{ eventId, status: "error", error: string }` |

**Decoding strategy (in order):**
1. `workAgreementContract.parseEvent(receiptEvent)` — uses the full work-agreement ABI.
2. On failure: `payrollEscrowContract.parseEvent(receiptEvent)` — uses the escrow ABI.
3. On failure: look up `receiptEvent.keys[0]` in a built-in selector map of known Starknet event signatures.
4. If all three fail: retain `"AgreementStatusChange"` and log a warning.

**Pagination:**
- Rows ordered `block_number ASC, event_index ASC` for deterministic results.
- `hasMore: true` when the page returns exactly `limit` rows.
- `hasMore: false` when fewer than `limit` rows are returned (final page).

---

## Known Limitations / Out of Scope

- **Retry state is in-memory only.** Restarting the server resets all counters and the quarantine set. A persistent quarantine store (e.g. a DB table) is a potential follow-up.
- **Single-process lock.** In a multi-replica deployment two replicas can run concurrently. A distributed lock (e.g. Redis) would be needed for strict single-flight semantics across replicas.
- **Quarantine directory** is created on first use (`fs.mkdirSync({ recursive: true })`). Write failures are logged to `stderr` and do not affect the HTTP response.

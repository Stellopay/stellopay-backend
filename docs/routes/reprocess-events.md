# Reprocess Events API (`/reprocess-events/*`)

The reprocess-events endpoints allow authorized administrators to re-decode
on-chain events whose `eventType` was not resolved during initial indexing.
All three routes share the same idempotency and safety guarantees described
below.

---

## Authentication and Authorization

All routes require an active admin session:

- `requireAuth`: Bearer token in `Authorization` header + `x-user-address` header.
- `requireAdmin`: normalized `x-user-address` must be in the `ADMIN_ADDRESSES` allowlist.

Unauthenticated or non-admin requests receive `401` before any DB or RPC call.

---

## Idempotency Guarantee

Every reprocess operation is safe to retry:

- **`tx/:tx_hash`** and **`batch`** delegate to `processTxReceipt` which uses
  `ON CONFLICT DO NOTHING` keyed on `transaction_hash + event_index`. Re-running
  the same hash produces no duplicate rows.
- **`status-changes`** queries only events still labelled `AgreementStatusChange`.
  Events updated by a previous run are automatically excluded from subsequent runs.
- An in-memory dedup set (keyed on `transactionHash_eventIndex`) prevents
  processing the same event twice within a single `status-changes` request.

---

## Observability / Structured Telemetry

All three routes emit structured JSON log lines via the internal `logReprocess`
helper. Each line contains:

| Field | Description |
| :--- | :--- |
| `level` | `"info"` \| `"warn"` \| `"error"` |
| `module` | Always `"reprocess-events"` — use this for log aggregation queries. |
| `op` | Logical operation: `tx_reprocess`, `batch`, `batch_summary`, `status_changes`, `status_changes_start`, `status_changes_summary`. |
| `txHash` | Transaction hash being processed (when applicable). |
| `eventId` | DB row ID of the event being processed (when applicable). |
| `outcome` | Result label (see table below). |
| `reason` | Short reason string for non-success outcomes. |
| `elapsed_ms` | Wall-clock milliseconds for the operation. |

**Outcome labels and their meanings:**

| `outcome` | Level | Meaning |
| :--- | :--- | :--- |
| `processed` | info | Events were decoded and persisted. |
| `no_events` | info | Transaction found but contained no decodable events. |
| `updated` | info | `AgreementStatusChange` event was re-decoded to its real type. |
| `no_change` | warn | Event could not be decoded; remains `AgreementStatusChange` (quarantine). |
| `dedup_skipped` | info | Event was already processed in the same request batch. |
| `quarantine` | warn | Transaction or event could not be found (`not_found`, `no_receipt`, `event_not_found`). |
| `parse_error_swallowed` | warn | ABI parsing threw but the selector fallback was attempted. |
| `error` | error | Unexpected RPC or DB failure; processing aborted for this event. |

**Example log line (status_changes_summary):**

```json
{
  "level": "info",
  "module": "reprocess-events",
  "op": "status_changes_summary",
  "totalCandidates": 50,
  "updated": 42,
  "noChange": 5,
  "quarantined": 2,
  "errors": 1,
  "elapsed_ms": 1234
}
```

---

## Endpoints

### `POST /api/v1/reprocess-events/tx/:tx_hash`

Re-decode events for a single transaction.

#### Path Parameters

| Parameter | Constraint |
| :--- | :--- |
| `tx_hash` | 0x-prefixed, 3–66 hex characters (`TxHashSchema`). |

#### Responses

| Status | Body | Condition |
| :--- | :--- | :--- |
| `200` | `{ message, result }` | Success. `result` is the `processTxReceipt` output. |
| `400` | `{ error: "Invalid Starknet transaction hash format" }` | Malformed hash. |
| `404` | `{ error: "Transaction not found" }` | RPC returned no receipt. |
| `500` | `{ error: string }` | Unexpected RPC/DB error. |

---

### `POST /api/v1/reprocess-events/batch`

Re-decode events for multiple transactions in one request.

#### Request Body

```json
{ "tx_hashes": ["0xabc...", "0xdef..."] }
```

| Field | Type | Constraint |
| :--- | :--- | :--- |
| `tx_hashes` | string[] | Non-empty, max `MAX_BATCH_SIZE` (50) items. Each must satisfy `TxHashSchema`. |

#### Response (`200 OK`)

```json
{
  "summary": {
    "total": 2,
    "processed": 1,
    "noEvents": 0,
    "notFound": 0,
    "errors": 1,
    "totalEventsProcessed": 3
  },
  "results": [...]
}
```

Per-tx errors are captured in `results` and never abort the rest of the batch.

---

### `POST /api/v1/reprocess-events/status-changes`

Re-decode all events still labelled `AgreementStatusChange`.

#### Query Parameters

| Parameter | Type | Default | Max | Description |
| :--- | :--- | :--- | :--- | :--- |
| `limit` | integer | `100` | `1000` | Max events to process per call. |
| `fromBlock` | integer | — | — | Lower bound on block number (inclusive). |
| `toBlock` | integer | — | — | Upper bound on block number (inclusive). |

#### Decoding strategy (in priority order)

1. Parse via `WorkAgreement` contract ABI at the event's contract address.
2. Parse via `PayrollEscrow` contract ABI at the event's contract address.
3. Resolve the event's first key against the frozen selector map (12 known selectors).
4. If all three fail, the event retains `AgreementStatusChange` and is logged as `no_change`.

#### Response (`200 OK`)

```json
{
  "message": "Reprocessed 50 events, updated 42",
  "updated": 42,
  "results": [
    { "eventId": "...", "status": "updated", "oldType": "AgreementStatusChange", "newType": "AgreementActivated" },
    { "eventId": "...", "status": "no_change", "eventType": "AgreementStatusChange" }
  ]
}
```

---

## Retry Budget and Quarantine Paths

Events that cannot be decoded after all three decoding strategies are
exhausted are **not deleted or moved** — they remain in the database with
`eventType = "AgreementStatusChange"` and are logged at WARN with
`outcome = "no_change"`. Operators can:

1. Re-run `status-changes` after a contract ABI update to pick up newly
   recognizable selectors.
2. Query the DB directly for remaining `AgreementStatusChange` rows to
   investigate manually.
3. Use `fromBlock` / `toBlock` to narrow the retry window to a specific
   block range.

There is no automatic retry loop or exponential backoff. Repeat invocations
are the operator's responsibility.

---

## Out of Scope Edge Cases

- **Automatic quarantine escalation**: events that fail decoding after N retries
  are not automatically moved to a separate quarantine table; they remain in
  place with the `AgreementStatusChange` label.
- **Parallel processing within status-changes**: events are processed serially
  to keep RPC load predictable; parallelism is not currently applied.

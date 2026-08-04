# Event Processing Guide

## Overview

This guide explains how to populate the database with contract events for
transactions, analytics, and notifications.

Both `POST /events/process_tx/:tx_hash` and `POST /events/process_batch` use
the **same** shared decoder (`processTxReceipt`) and are fully idempotent –
re-processing the same transaction(s) will never produce duplicate rows.

---

## Database Connection

If you encounter `"SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"`:

```bash
# Option 1 – environment variable
export POSTGRES_CONNECTION_STRING="postgresql://username:password@localhost:5432/stellopay_indexer"

# Option 2 – .env file in stellopay-backend/
POSTGRES_CONNECTION_STRING=postgresql://username:password@localhost:5432/stellopay_indexer

# No password?
POSTGRES_CONNECTION_STRING=postgresql://username:@localhost:5432/stellopay_indexer
```

---

## Processing Transaction Events

### Method 1 – Single Transaction

```bash
POST /api/v1/events/process_tx/:tx_hash
```

**Example:**

```bash
curl -X POST http://localhost:4002/api/v1/events/process_tx/0x1234...abcd
```

**Behaviour:**

- Fetches the on-chain receipt via the StarkNet RPC provider.
- Decodes every event using the `WorkAgreement` and `PayrollEscrow` ABIs.
- Persists rows to `agreements`, `agreement_events`, `payments`, and
  `escrow_events` with `ON CONFLICT DO NOTHING` (idempotent).
- Returns the list of event labels that were processed.

**Response:**

```json
{
  "message": "Processed 2 events",
  "eventsProcessed": ["AgreementCreated-1", "Funded-1"],
  "transactionHash": "0x000...1234"
}
```

---

### Method 2 – Batch of Transactions

```bash
POST /api/v1/events/process_batch
Content-Type: application/json
```

**Request body:**

```json
{
  "tx_hashes": ["0x1234...abcd", "0x5678...efgh"]
}
```

**Validation rules:**
| Field | Rule |
|---|---|
| `tx_hashes` | Non-empty array; **maximum 50 hashes** per request |
| Each hash | Must match `^0x[0-9a-fA-F]{1,64}$` |

**Behaviour:**

- Each tx hash is processed with `processTxReceipt`, the **same shared logic**
  used by Method 1 – events are fully decoded and persisted.
- A per-tx error (e.g. RPC timeout, bad hash) is captured and reported as
  `status: "error"` without aborting the rest of the batch.
- All writes use `ON CONFLICT DO NOTHING` – the whole batch is safe to replay.

**Response:**

```json
{
  "summary": {
    "total": 2,
    "processed": 2,
    "noEvents": 0,
    "notFound": 0,
    "errors": 0,
    "totalEventsProcessed": 3
  },
  "results": [
    {
      "txHash": "0x000...1234",
      "status": "processed",
      "eventsProcessed": 2,
      "eventLabels": ["AgreementCreated-1", "Funded-1"]
    },
    {
      "txHash": "0x000...5678",
      "status": "processed",
      "eventsProcessed": 1,
      "eventLabels": ["PaymentSent-1"]
    }
  ]
}
```

Per-tx `status` values:

| Value         | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `"processed"` | Receipt fetched, events decoded and stored                           |
| `"no_events"` | Receipt exists but has no decodable events                           |
| `"not_found"` | Provider returned no receipt for this hash                           |
| `"error"`     | Unexpected error (RPC failure, etc.); `error` field contains message |

---

### Method 3 – Auto-process After Contract Calls

```typescript
// After a successful transaction
const txHash = await executeCall(prepared.call);
if (txHash?.transaction_hash) {
  await apiPost(`/events/process_tx/${txHash.transaction_hash}`, {});
}
```

---

## Event Types Stored

| Event                                                                                                   | Table(s) written                 |
| ------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `AgreementCreated`                                                                                      | `agreement_events`, `agreements` |
| `AgreementActivated`, `AgreementPaused`, `AgreementResumed`, `AgreementCancelled`, `AgreementCompleted` | `agreement_events`               |
| `EmployeeAdded`, `MilestoneAdded`, `MilestoneApproved`, `MilestoneClaimed`, `PayrollClaimed`            | `agreement_events`               |
| `DisputeRaised`, `DisputeResolved`                                                                      | `agreement_events`               |
| `PaymentSent`, `PaymentReceived`                                                                        | `payments`                       |
| `Funded`, `Released`, `Refunded`                                                                        | `escrow_events`                  |

---

## Data Flow

```
User executes contract call
        │
        ▼
Transaction mined on StarkNet
        │
        ▼
POST /events/process_tx/:hash   (or include in process_batch)
        │
        ▼
processTxReceipt()  ◄─── shared decoder used by BOTH endpoints
        │
        ├── agreements
        ├── agreement_events
        ├── payments
        └── escrow_events
        │
        ▼
Frontend reads data from:
  /transactions/:user_address
  /notifications/:user_address
  /analytics/:user_address
```

---

## Idempotency

All inserts use `ON CONFLICT DO NOTHING` keyed on `transaction_hash + event_index`.
This means:

- Re-running `process_tx` on the same hash is always safe.
- Re-submitting the same `process_batch` body produces no duplicate rows.
- Batch operations can be safely retried after partial failures.

---

## Troubleshooting

### Events not appearing?

1. Confirm the transaction has been mined (check the block explorer).
2. Verify the tx hash is correct and starts with `0x`.
3. Review backend logs for parsing errors (`[events] ...`).
4. Ensure the database connection is healthy.

### Batch rejected with 400?

- Check that the hash format matches `^0x[0-9a-fA-F]{1,64}$`.
- Ensure the array contains ≤ 50 hashes and at least 1 hash.

---

## Reprocessing Events (Operator)

Reprocessing is a **privileged, resource-intensive** operation gated behind
operator authentication (`requireAuth` + `requireAdmin`). All endpoints are
sized-bounded and idempotent.

### Method 4 – Reprocess Single Transaction

```bash
POST /api/v1/reprocess-events/tx/:tx_hash
```

**Behaviour:**

- Calls the same shared `processTxReceipt` used by Method 1/2.
- Uses `ON CONFLICT DO NOTHING` keyed on `transaction_hash + event_index` —
  re-running the same hash is always safe (no duplicate rows).

**Validation:**

| Field    | Rule                                          |
| -------- | --------------------------------------------- |
| `tx_hash` (path) | Must match `^0x[0-9a-fA-F]{1,64}$`, 3–66 chars |

**Response:**

```json
{
  "message": "Events reprocessed",
  "result": {
    "txHash": "0x000...1234",
    "status": "processed",
    "eventsProcessed": 1,
    "eventLabels": ["AgreementActivated-42"]
  }
}
```

---

### Method 5 – Reprocess Batch of Transactions

```bash
POST /api/v1/reprocess-events/batch
Content-Type: application/json
```

**Request body:**

```json
{
  "tx_hashes": ["0x1234...abcd", "0x5678...efgh"]
}
```

**Validation rules:**

| Field       | Rule                                                  |
| ----------- | ----------------------------------------------------- |
| `tx_hashes` | Non-empty array; **maximum 50 hashes** per request    |
| Each hash   | Must match `^0x[0-9a-fA-F]{1,64}$`                   |

**Behaviour:**

- Each tx hash is processed sequentially via `processTxReceipt`.
- A per-tx error (e.g. RPC timeout) is captured without aborting the batch.
- All writes use `ON CONFLICT DO NOTHING` — the whole batch is safe to replay.

**Response:**

```json
{
  "summary": {
    "total": 2,
    "processed": 2,
    "noEvents": 0,
    "notFound": 0,
    "errors": 0,
    "totalEventsProcessed": 3
  },
  "results": [
    {
      "txHash": "0x000...1234",
      "status": "processed",
      "eventsProcessed": 2,
      "eventLabels": ["AgreementCreated-1", "Funded-1"]
    },
    {
      "txHash": "0x000...5678",
      "status": "processed",
      "eventsProcessed": 1,
      "eventLabels": ["PaymentSent-1"]
    }
  ]
}
```

---

### Method 6 – Reprocess Status-Change Events

```bash
POST /api/v1/reprocess-events/status-changes
```

**Query parameters** (all optional):

| Parameter   | Type   | Default | Max    | Description                              |
| ----------- | ------ | ------- | ------ | ---------------------------------------- |
| `limit`     | number | 100     | 1000   | Maximum events to process                |
| `fromBlock` | number | —       | —      | Minimum block number (inclusive)         |
| `toBlock`   | number | —       | —      | Maximum block number (inclusive)         |

**Behaviour:**

- Queries the `agreement_events` table for rows still tagged as
  `AgreementStatusChange` and attempts to decode each one using on-chain ABIs
  or a built-in selector map.
- Already-updated events are automatically skipped (the query filters by
  `eventType = 'AgreementStatusChange'`).
- An in-memory dedup set keyed on `transaction_hash + event_index` prevents
  processing the same event twice within a single request.
- Re-running the endpoint after a successful run produces zero updated events.

**Response:**

```json
{
  "message": "Reprocessed 10 events, updated 3",
  "updated": 3,
  "results": [
    { "eventId": "evt_1", "status": "updated", "oldType": "AgreementStatusChange", "newType": "AgreementActivated" },
    { "eventId": "evt_2", "status": "no_change", "eventType": "AgreementStatusChange" },
    { "eventId": "evt_3", "status": "no_receipt" }
  ]
}
```

---

## Backfill Events (Operator)

Backfill is a **privileged** operation (admin-only) that synthesises
`EmployeeAdded` and `MilestoneAdded` events for rows in the `employees` and
`milestones` tables that do not yet have a corresponding entry in
`agreement_events`.

Synthetic event rows are fully distinguishable from real on-chain events:
- The event ID follows the pattern `{transactionHash}_backfill_{eventType}_{rowId}`
  — the `_backfill_` segment ensures no collision with real IDs
  (`{txHash}_{eventIndex}`).
- The `eventIndex` column is set to **`-1`**, a value real events can never
  have.

### Method 7 – Backfill Employee-Added Events

```bash
POST /api/v1/backfill/employee-events
```

**Query parameters** (all optional):

| Parameter     | Type   | Default | Max    | Description                                      |
| ------------- | ------ | ------- | ------ | ------------------------------------------------ |
| `limit`       | number | 1000    | 5000   | Maximum number of employee rows to scan          |
| `agreementId` | string | —       | —      | Restrict backfill to a single agreement           |

**Validation rules:**

| Input     | Rule                                          |
| --------- | --------------------------------------------- |
| `limit`   | Positive integer, 1–5000                      |
| `agreementId` | Optional string                           |

**Behaviour:**

- Scans the `employees` table for rows without a matching `EmployeeAdded`
  event in `agreement_events` (matched by `agreement_id` + `transaction_hash`).
- Inserts all missing events inside a **single database transaction** using
  `ON CONFLICT DO NOTHING` — re-runs are safe no-ops.
- Each inserted row carries `eventIndex: -1` and an id of the form
  `{txHash}_backfill_EmployeeAdded_{employeeId}`.

**Response:**

```json
{
  "message": "Backfilled 3 EmployeeAdded events",
  "totalScanned": 10,
  "created": 3,
  "results": [
    { "employeeId": "emp_1", "agreementId": "agr_123", "status": "created" }
  ]
}
```

---

### Method 8 – Backfill Milestone-Added Events

```bash
POST /api/v1/backfill/milestone-events
```

**Query parameters** (all optional — identical schema to Method 7):

| Parameter     | Type   | Default | Max    | Description                                      |
| ------------- | ------ | ------- | ------ | ------------------------------------------------ |
| `limit`       | number | 1000    | 5000   | Maximum number of milestone rows to scan         |
| `agreementId` | string | —       | —      | Restrict backfill to a single agreement           |

**Behaviour:**

- Same logic as the employee backfill, operating against the `milestones`
  table and producing `MilestoneAdded` events.
- Inserts run inside a transaction with `ON CONFLICT DO NOTHING`.
- Synthetic ID format: `{txHash}_backfill_MilestoneAdded_{milestoneId}`,
  `eventIndex: -1`.

**Response:**

```json
{
  "message": "Backfilled 2 MilestoneAdded events",
  "totalScanned": 5,
  "created": 2,
  "results": [
    { "milestoneId": "ms_1", "agreementId": "agr_456", "status": "created" }
  ]
}
```

---

### Security notes

- All reprocess **and backfill** routes are gated behind **both** `requireAuth`
  and `requireAdmin` — regular users cannot trigger these operations.
- Array/list sizes are bounded to prevent excessive RPC or DB load:
  - `tx_hashes`: maximum **50** per batch request.
  - `limit`: maximum **1000** events per status-changes request, **5000**
    rows per backfill request.
- All inputs are validated with Zod schemas and rejected with **400** on
  failure.

---

### Database connection issues?

1. Verify `POSTGRES_CONNECTION_STRING` is set and well-formed.
2. Confirm PostgreSQL is running and the `stellopay_indexer` database exists.
3. Ensure the DB user has `INSERT`, `SELECT`, and `UPDATE` privileges.


---

## Runbook

This section provides operator-facing guidance for the reprocess and backfill
routes. For the detailed API reference, see Methods 4-8 above; for indexer
context, see [INDEXER_INTEGRATION.md](./INDEXER_INTEGRATION.md).

### When to Use Which

| Scenario | Use | Why |
|---|---|---|
| A known transaction's events are missing after the indexer caught up | `POST /reprocess-events/tx/:tx_hash` | Fetches on-chain receipt for a single tx; idempotent |
| Multiple known transactions need re-decoding | `POST /reprocess-events/batch` | Batch variant with per-tx error isolation |
| Status-change events are still tagged as `AgreementStatusChange` | `POST /reprocess-events/status-changes` | Decodes status-change rows that weren't resolved on first pass |
| `employees` or `milestones` rows exist but no `EmployeeAdded`/`MilestoneAdded` event appears | `POST /backfill/employee-events` or `/backfill/milestone-events` | Synthesises missing event rows from existing data |
| You don't know which transactions are affected | `GET /diagnostics/events` first, then decide | Diagnostics give aggregate counts to identify gaps |

**Reprocess vs. Backfill**:

- **Reprocess** re-reads on-chain data from the RPC provider. Use when the
  transaction exists on-chain but wasn't indexed correctly.
- **Backfill** creates synthetic events from the database. Use when the
  indexer missed a historical migration and the raw on-chain data is already
  represented in the `employees`/`milestones` tables.

### How to Trigger Safely

All reprocess and backfill routes require **both** `requireAuth` (valid session
token) and `requireAdmin` (address in `ADMIN_ADDRESSES`).
**These endpoints should never be exposed publicly** -- keep them behind a VPN,
firewall, or internal network.

#### Step 1 -- Authenticate

```bash
# Get a challenge
CHALLENGE=$(curl -sS http://localhost:4000/api/v1/auth/challenge \
  -H 'content-type: application/json' \
  -d '{"address":"0xYOUR_ADMIN_ADDRESS"}')

# Sign the typed_data with your wallet, then verify
SESSION=$(curl -sS http://localhost:4000/api/v1/auth/verify \
  -H 'content-type: application/json' \
  -d '{"address":"0xYOUR_ADMIN_ADDRESS","signature":[...]}')

TOKEN=$(echo "$SESSION" | jq -r '.session_token')
```

#### Step 2 -- Check current state

```bash
# Aggregate diagnostics -- no tx hashes exposed
curl -sS http://localhost:4000/api/v1/diagnostics/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-user-address: 0xYOUR_ADMIN_ADDRESS" | jq .
```

#### Step 3 -- Execute the operation

**Single transaction reprocess:**

```bash
curl -sS -X POST http://localhost:4000/api/v1/reprocess-events/tx/0xTX_HASH \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-user-address: 0xYOUR_ADMIN_ADDRESS" | jq .
```

**Status-change reprocess (small batch first):**

```bash
# Start with a small limit to estimate the scope
curl -sS -X POST 'http://localhost:4000/api/v1/reprocess-events/status-changes?limit=10' \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-user-address: 0xYOUR_ADMIN_ADDRESS" | jq .
```

**Backfill (restricted to one agreement first):**

```bash
curl -sS -X POST 'http://localhost:4000/api/v1/backfill/employee-events?agreementId=agr_123&limit=100' \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-user-address: 0xYOUR_ADMIN_ADDRESS" | jq .
```

> **Always start small** -- use `limit`, `agreementId`, or single-tx endpoints
> before running at full scale. All operations are **idempotent** (`ON CONFLICT
> DO NOTHING`), so you can safely re-run them.

### How to Monitor Progress

1. **Watch backend logs** -- structured JSON logs include `request_id`,
   `tx_hash`, and `events_processed` counts for every operation.

2. **Check diagnostics between batches:**

```bash
# Run before
curl -sS http://localhost:4000/api/v1/diagnostics/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-user-address: 0xYOUR_ADMIN_ADDRESS" | jq '.counts'

# ... run reprocess / backfill ...

# Run after and compare
curl -sS http://localhost:4000/api/v1/diagnostics/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-user-address: 0xYOUR_ADMIN_ADDRESS" | jq '.counts'
```

3. **For large backfill runs**, monitor the response incrementally. Each
   response reports `totalScanned` and `created` counts, so you can track
   progress across successive invocations.

### How to Verify Correctness

1. **Idempotency check**: Re-run the same operation. A correct run produces
   zero new events on the second invocation:

```bash
# First run
curl -sS -X POST 'http://localhost:4000/api/v1/backfill/employee-events?limit=5000' \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-user-address: 0xYOUR_ADMIN_ADDRESS"
# Expected: {"message":"Backfilled 3 EmployeeAdded events","created":3,...}

# Second run -- should be a no-op
curl -sS -X POST 'http://localhost:4000/api/v1/backfill/employee-events?limit=5000' \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-user-address: 0xYOUR_ADMIN_ADDRESS"
# Expected: {"message":"Backfilled 0 EmployeeAdded events","created":0,...}
```

2. **Check the database directly** -- query `agreement_events` for synthetic
   entries (identifiable by `_backfill_` in the event ID):

```sql
-- Verify backfill events exist
SELECT event_id, event_type, transaction_hash, event_index
FROM agreement_events
WHERE event_id LIKE '%_backfill_%'
ORDER BY created_at DESC
LIMIT 20;
```

3. **For reprocess operations**, compare `eventsProcessed` in the response
   against the expected event count.

4. **Cross-reference with the indexer** -- see
   [INDEXER_INTEGRATION.md](./INDEXER_INTEGRATION.md) for checking whether the
   indexer has caught up to the block containing the transaction.

### Common Issues

| Symptom | Likely cause | Action |
|---|---|---|
| `401 Unauthorized` | Missing or expired session token | Re-authenticate via `/auth/challenge` then `/auth/verify` |
| `403 Forbidden` | Address not in `ADMIN_ADDRESSES` | Check `ADMIN_ADDRESSES` env var |
| `not_found` status in response | Transaction not on chain or wrong network | Verify the tx hash on the block explorer |
| `no_events` status in response | Transaction has no events matching the configured ABIs | This is normal for e.g. pure transfers |
| Backfill creates 0 events | All rows already have matching event entries | Expected -- operation is a no-op |
| `429 Too Many Requests` | Rate limit hit | Wait and retry; reduce batch sizes
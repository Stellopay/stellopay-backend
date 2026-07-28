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

## Operational Runbook

This section provides step-by-step procedures for operators handling
real-world event-processing gaps, stuck transactions, and data
inconsistencies.

---

### Pre-flight Checklist

Before running any reprocess or backfill operation:

- [ ] Confirm you are authenticated as an **admin** (both `requireAuth` and
  `requireAdmin` must pass).
- [ ] Verify the database is healthy:
  ```bash
  curl -s http://localhost:4002/health | jq .status
  curl -s http://localhost:4002/ready | jq .ready
  ```
- [ ] Check the last processed block / ledger height to assess the gap size:
  ```bash
  # Recent event count per type
  SELECT event_type, COUNT(*) FROM agreement_events
    WHERE created_at > NOW() - INTERVAL '1 hour'
    GROUP BY event_type;
  ```
- [ ] Ensure no other reprocess or backfill operation is already running
  (these operations are CPU- and RPC-intensive).
- [ ] Review recent application logs for persistent RPC errors:
  ```bash
  grep -i 'rpc\|timeout\|rate limit\|5xx' /var/log/stellopay/events.log
  ```
- [ ] For large backfills (5000+ rows), schedule during **low-traffic hours**.

---

### Scenario A — Single Transaction Missing from Database

**Symptoms:**
- A specific transaction hash exists on-chain but produces no events in the
  application.
- User reports missing notification / analytics data for a known transaction.

**Procedure:**

1. Verify the tx hash on the block explorer to confirm it is mined and
   contains the expected events.
2. Call the single-tx reprocess endpoint:
   ```bash
   curl -X POST http://localhost:4002/api/v1/reprocess-events/tx/0x1234...abcd \
     -H "Authorization: Bearer <admin-token>"
   ```
3. Check the response status:
   - `"processed"`: events were missing and are now stored. ✅
   - `"no_events"`: the tx exists but has no decodable events — may indicate
     an ABI mismatch or a non-contract transaction.
   - `"not_found"`: the RPC provider returned no receipt — possible network
     issue or invalid hash.
   - `"error"`: inspect the error message and review application logs.
4. Verify the data appeared in the expected table:
   ```sql
   SELECT * FROM agreement_events WHERE transaction_hash = '0x1234...abcd';
   ```

**Escalation:** If `"not_found"` persists for a valid hash, check the RPC
provider status and the `STARKNET_RPC_URL` configuration.

---

### Scenario B — Batch of Recent Transactions Missing

**Symptoms:**
- A range of recent transactions (e.g. last hour) are not reflected in the
  database.
- The Apibara indexer may be lagging or down.

**Procedure:**

1. Determine the missing tx hashes from the block explorer or indexer logs.
2. Prepare a batch payload (max 50 hashes per request):
   ```json
   {
     "tx_hashes": ["0x1111...", "0x2222...", "..."]
   }
   ```
3. Submit the batch reprocess:
   ```bash
   curl -X POST http://localhost:4002/api/v1/reprocess-events/batch \
     -H "Authorization: Bearer <admin-token>" \
     -H "Content-Type: application/json" \
     -d @batch.json
   ```
4. Review the per-tx `status` values in the response. Re-submit any hashes
   that returned `"error"` or `"not_found"`.
5. If more than 50 hashes are missing, run multiple batches sequentially.
   Wait for each batch to complete before submitting the next.

**Post-operation:** Verify the event count matches expectations:
```sql
SELECT COUNT(*) FROM agreement_events
  WHERE created_at > NOW() - INTERVAL '2 hours';
```

---

### Scenario C — Stuck AgreementStatusChange Events

**Symptoms:**
- Rows in `agreement_events` with `eventType = 'AgreementStatusChange'` are
  not being decoded into their specific event type (e.g. `AgreementActivated`,
  `AgreementCancelled`).

**Procedure:**

1. Count the stuck events:
   ```sql
   SELECT COUNT(*) FROM agreement_events
     WHERE event_type = 'AgreementStatusChange';
   ```
2. If the count is manageable (< 1000), run status-change reprocess:
   ```bash
   curl -X POST 'http://localhost:4002/api/v1/reprocess-events/status-changes?limit=1000' \
     -H "Authorization: Bearer <admin-token>"
   ```
3. If the count exceeds 1000, process in batches using `limit=1000` and
   `fromBlock`/`toBlock` parameters to narrow each run:
   ```bash
   curl -X POST 'http://localhost:4002/api/v1/reprocess-events/status-changes?fromBlock=50000&toBlock=60000&limit=1000' \
     -H "Authorization: Bearer <admin-token>"
   ```
4. After each batch, verify updated count:
   ```sql
   SELECT event_type, COUNT(*) FROM agreement_events
     WHERE event_type != 'AgreementStatusChange'
       AND created_at > NOW() - INTERVAL '30 minutes'
     GROUP BY event_type;
   ```
5. Repeat until the stuck count approaches zero.

**Troubleshooting:** If events remain stuck after reprocess:
- The on-chain ABI may have changed — verify the contract class hash in
  `src/starknet/abi.ts` matches the deployed contract.
- Check application logs for decoding errors (`ABI decode failure`).

---

### Scenario D — Missing EmployeeAdded or MilestoneAdded Events

**Symptoms:**
- The `employees` or `milestones` table has rows without a corresponding event
  in `agreement_events`.
- Leaderboard or audit queries that depend on events return incomplete data.

**Procedure:**

1. Assess the gap size:
   ```sql
   -- Count employees without events
   SELECT COUNT(*) FROM employees e
     LEFT JOIN agreement_events ae
       ON ae.transaction_hash = e.transaction_hash
       AND ae.event_type = 'EmployeeAdded'
     WHERE ae.id IS NULL;
   ```
2. Run the employee-event backfill:
   ```bash
   curl -X POST 'http://localhost:4002/api/v1/backfill/employee-events?limit=5000' \
     -H "Authorization: Bearer <admin-token>"
   ```
3. If the gap exceeds 5000 rows, run multiple passes. The endpoint is
   idempotent — rows already backfilled are skipped.
4. Repeat the same procedure for milestone events:
   ```bash
   curl -X POST 'http://localhost:4002/api/v1/backfill/milestone-events?limit=5000' \
     -H "Authorization: Bearer <admin-token>"
   ```
5. Verify:
   ```sql
   SELECT COUNT(*) FROM agreement_events WHERE event_type IN ('EmployeeAdded', 'MilestoneAdded');
   ```

**Restoring real events later:** These synthetic events are placeholders. If
the Apibara indexer later processes the original on-chain events, the real
events will be inserted alongside the synthetic ones (idempotent, `ON CONFLICT
DO NOTHING`). To replace synthetic events with real ones, run the
status-changes reprocess, which normalises `AgreementStatusChange` rows.

---

### Scenario E — Indexer Lag / Complete Indexer Outage

**Symptoms:**
- No new events appear in the database for an extended period.
- Indexer health check fails.
- Backend logs show no recent indexer activity.

**Procedure:**

1. Confirm the indexer is down:
   ```bash
   curl -s http://indexer.internal:3000/health
   ```
2. Determine the last indexed block:
   ```sql
   SELECT MAX(ledger) FROM agreement_events;
   ```
3. Fetch missing transactions from the block explorer for the unindexed range.
4. Use batch reprocess (Scenario B) to fill the gap. If the gap spans
   thousands of transactions, prioritise:
   - High-value agreements (check `agreements` table for `reward_pool > 0`).
   - Recently active agreements (those with activity in the last 24 hours).
5. Restore the indexer service. Once back online, the indexer will
   automatically catch up from the last indexed block. The reprocessed events
   will be skipped via `ON CONFLICT DO NOTHING`.
6. After the indexer has caught up, verify parity:
   ```sql
   SELECT COUNT(*) FROM agreement_events
     WHERE created_at > NOW() - INTERVAL '1 hour';
   ```

---

### Scenario F — Duplicate or Corrupt Events

**Symptoms:**
- Unexpected duplicate rows (should not happen with `ON CONFLICT DO NOTHING`
  under normal conditions, but possible with manual INSERTs).
- Events with null or malformed fields.

**Procedure:**

1. Identify anomalies:
   ```sql
   SELECT id, transaction_hash, event_type, event_index, created_at,
     COUNT(*) OVER (PARTITION BY transaction_hash, event_index) AS dup_count
   FROM agreement_events
   ORDER BY created_at DESC
   LIMIT 100;
   ```
2. Remove true duplicates (keep the earliest row):
   ```sql
   DELETE FROM agreement_events
   WHERE id IN (
     SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (
         PARTITION BY transaction_hash, event_index
         ORDER BY created_at ASC
       ) AS rn
       FROM agreement_events
     ) t WHERE t.rn > 1
   );
   ```
3. For corrupt rows (null critical fields), delete and reprocess:
   ```sql
   DELETE FROM agreement_events WHERE event_type IS NULL;
   ```
   Then run the reprocess endpoint for the affected transaction hashes.

---

### Post-Operation Verification

After any reprocess or backfill operation, verify:

1. **Event count sanity check** — compare event counts before and after:
   ```sql
   SELECT event_type, COUNT(*) FROM agreement_events GROUP BY event_type;
   ```
2. **Data consistency** — spot-check a handful of agreement IDs:
   ```sql
   SELECT a.id, a.status, ae.event_type, ae.event_data
   FROM agreements a
   JOIN agreement_events ae ON ae.transaction_hash = a.transaction_hash
   WHERE a.id = '<agreement-id>'
   ORDER BY ae.event_index;
   ```
3. **Application health** — confirm the backend is still serving requests:
   ```bash
   curl -s http://localhost:4002/health
   ```
4. **User-facing verification** — check that impacted users can now see their
   data in the frontend.

---

### Monitoring & Alerting Recommendations

Set up alerts for the following conditions to catch event-processing gaps
early:

| Alert | Trigger | Suggested Threshold |
|-------|---------|---------------------|
| **No new events** | Zero `agreement_events` inserted in the last 15 minutes | Warning after 15m, Critical after 30m |
| **Indexer health** | Indexer `/health` returns non-200 | Immediate critical |
| **Backlog size** | `agreement_events` insert rate drops below 50% of the 7-day rolling average | Warning |
| **High RPC error rate** | More than 10% of process_tx calls return `"not_found"` or `"error"` in a 5-minute window | Warning |
| **Stuck events** | More than 100 rows with `eventType = 'AgreementStatusChange'` persisting for over 1 hour | Warning |
| **Backfill age** | Last backfill operation was more than 7 days ago and gaps exist | Info |

Example Prometheus recording rule for detecting stuck events:
```yaml
record: stellopay:stuck_status_changes:count
expr: |
  count(stellopay_agreement_events{event_type="AgreementStatusChange"})
```

---

### Runbook Quick Reference

| Symptom | Method | Endpoint | Max Batch |
|---------|--------|----------|-----------|
| Single missing tx | 4 — Reprocess single | `POST /reprocess-events/tx/:hash` | 1 tx |
| Missing batch of txs | 5 — Reprocess batch | `POST /reprocess-events/batch` | 50 hashes |
| Stuck status changes | 6 — Reprocess status-changes | `POST /reprocess-events/status-changes` | 1000 events |
| Missing employee events | 7 — Backfill employees | `POST /backfill/employee-events` | 5000 rows |
| Missing milestone events | 8 — Backfill milestones | `POST /backfill/milestone-events` | 5000 rows |
| Indexer outage | 5 + 7 + 8 | As above | As above |
| Duplicate/corrupt data | Manual SQL + 4/5 | SQL + reprocess | — |

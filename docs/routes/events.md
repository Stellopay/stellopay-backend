# Events

**Overview:**
These endpoints handle indexed event querying as well as Starknet transaction receipt ingestion.

Event ingestion endpoints decode `WorkAgreement` and `PayrollEscrow` contract events using the loaded ABIs, and persist the results (agreements, agreement events, payments, escrow events) to the database. Both POST routes delegate to the same internal `processTxReceipt(txHash)` function.

The read endpoint (`GET /api/v1/events`) allows consumers to query indexed events with database-level filtering by event type, time range, agreement ID, contract address, and pagination parameters.

---

## Endpoints

- `GET /api/v1/events`
- `POST /api/v1/events/process_tx/:tx_hash`
- `POST /api/v1/events/process_batch`

---

## `GET /api/v1/events`

Fetch indexed events with event-type and time-range filtering pushed directly down into the database query.

### Query Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `eventType` | `string` or `string[]` | Single event type (`AgreementCreated`), comma-separated types (`AgreementCreated,PaymentSent`), or repeated query params (`?eventType=A&eventType=B`). |
| `from` | `string` or `number` | Bounds start of time range (inclusive: `createdAt >= from`). Accepts ISO 8601 strings or numeric epoch timestamps (seconds or milliseconds). |
| `to` | `string` or `number` | Bounds end of time range (inclusive: `createdAt <= to`). Accepts ISO 8601 strings or numeric epoch timestamps (seconds or milliseconds). |
| `agreement_id` / `agreementId` | `string` | Optional filter by numeric agreement ID. |
| `contract_address` / `contractAddress` | `string` | Optional filter by contract address. |
| `limit` | `number` | Page limit (default 50, maximum 100). |
| `offset` | `number` | Pagination offset (default 0). |

### Validation & Bounds Guarantees

1. **Inclusive Bounds**: Time range bounds are inclusive (`from <= createdAt <= to`).
2. **Strict Range Order Validation**: `from` must be less than or equal to `to` (`from <= to`). If `from > to`, the API rejects the request with HTTP `400 Bad Request` and `details: [{ message: "from timestamp must be less than or equal to to timestamp" }]`.
3. **Malformed Timestamp Rejection**: Malformed or unparseable timestamps return HTTP `400 Bad Request` before hitting the database.

### Query Pushdown Semantics

Filtering by `eventType` and time range (`from`/`to`) is pushed down into the PostgreSQL query using Drizzle SQL operators (`inArray`, `gte`, `lte`), avoiding wasteful in-memory filtering and keeping database scans strictly bounded.

---

## Ingestion Endpoints

### Authentication

Ingestion routes require an authenticated session (`requireAuth`).

---

### `POST /api/v1/events/process_tx/:tx_hash`

Process a single Starknet transaction.

**Path parameter**

| Parameter  | Type   | Description                                                                 |
| ---------- | ------ | ----------------------------------------------------------------------------- |
| `tx_hash`  | string | Starknet transaction hash. Validated against `TxHashSchema` (see below).      |

**Responses**

| Status | Condition                              | Body                                                                                   |
| ------ | --------------------------------------- | --------------------------------------------------------------------------------------- |
| `200`  | Receipt found, events decoded           | `{ message, eventsProcessed: string[], transactionHash, tokenVerified? }`               |
| `200`  | Receipt found, no decodable events      | `{ message: "No events found in transaction", eventsProcessed: 0 }`                     |
| `404`  | No receipt found for the hash           | `{ error: "Transaction not found" }`                                                    |
| `400`  | `tx_hash` fails format validation       | `{ error: "Invalid Starknet transaction hash format" }`                                 |

---

### `POST /api/v1/events/process_batch`

Process multiple Starknet transactions in a single request.

**Body**

```json
{ "tx_hashes": ["0x...", "0x..."] }
```

| Field        | Type       | Constraints                                                             |
| ------------ | ---------- | ------------------------------------------------------------------------ |
| `tx_hashes`  | `string[]` | 1 to `MAX_BATCH_SIZE` (50) entries, each validated by `TxHashSchema`.    |

**Response** (`200`)

```json
{
  "summary": {
    "total": 2,
    "processed": 1,
    "noEvents": 0,
    "notFound": 0,
    "errors": 0,
    "duplicates": 1,
    "totalEventsProcessed": 1
  },
  "results": [
    { "txHash": "0x...aaaa", "status": "processed", "eventsProcessed": 1, "eventLabels": ["AgreementCreated-1"] },
    { "txHash": "0x...aaaa", "status": "processed", "eventsProcessed": 1, "eventLabels": ["AgreementCreated-1"] }
  ]
}
```

`results` always has the same length and index-correspondence as the input `tx_hashes` array — `results[i]` corresponds to `tx_hashes[i]`, even when `tx_hashes[i]` is a duplicate of an earlier entry.

`summary.total` equals `tx_hashes.length`. `summary.processed` / `noEvents` / `notFound` / `errors` are counted over the **unique** (deduplicated) work actually performed, and `summary.duplicates` accounts for the rest, so the following always holds:

```
total === processed + noEvents + notFound + errors + duplicates
```

A per-tx error is captured into that tx's result entry (`status: "error"`) and never aborts the rest of the batch.

---

## Idempotency contract

1. **DB-level idempotency (both endpoints).**
   Every row written by `processTxReceipt` uses a deterministic primary key derived from the transaction hash and event index — `{normalizedTxHash}_{eventIndex}` — and is inserted with `.onConflictDoNothing()` (or, for the `agreements` row itself, `.onConflictDoUpdate()` touching only `updatedAt`). Re-processing the exact same transaction any number of times, via either endpoint, on any number of separate requests, is always a safe no-op after the first successful write — no duplicate rows are ever created.

2. **Within-request duplicate handling (`process_batch` only).**
   Hashes in `tx_hashes` are normalized with the same normalization used internally (`normalizeTransactionHash`, which canonicalizes padding/case) and used as a dedup key *within that single request*. If the same normalized hash appears more than once in one `tx_hashes` array:
   - Only the **first** occurrence triggers an RPC call (`provider.getTransactionReceipt`) and a call to `processTxReceipt`.
   - Subsequent occurrences reuse the result object from the first occurrence (same status, `eventsProcessed`, `eventLabels`, etc.) instead of recomputing it.
   - The batch `summary` reports these reused occurrences via `duplicates`, so the response accurately reflects that only N unique units of work were performed, not `tx_hashes.length`.

## Envelope validation contract

Both endpoints validate transaction hash format identically via the shared `TxHashSchema` (`0x`-prefixed hex, 3–66 characters). Both endpoints return the same `400` shape on malformed input:

```json
{ "error": "Invalid Starknet transaction hash format" }
```

## Known limitations / out of scope

- **No cross-request idempotency-key / response-replay caching.** There is no persistent idempotency-key store (e.g. Redis, a dedup table) in this service. If a caller sends the *same* transaction hash as two **separate** HTTP requests each request still performs its own RPC fetch and call to `processTxReceipt`.

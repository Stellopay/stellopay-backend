# Events

**Overview:**
These endpoints ingest Starknet transaction receipts, decode `WorkAgreement` and `PayrollEscrow` contract events using the loaded ABIs, and persist the results (agreements, agreement events, payments, escrow events) to the database. Both routes delegate to the same internal `processTxReceipt(txHash)` function, so decoding/persistence behavior is identical whether a transaction is processed individually or as part of a batch.

## Endpoints

- `POST /api/v1/events/process_tx/:tx_hash`
- `POST /api/v1/events/process_batch`

### Authentication

Both routes require an authenticated session (`requireAuth`).

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

Both endpoints validate transaction hash format identically via the shared `TxHashSchema` (`0x`-prefixed hex, 3–66 characters). This was previously inconsistent: `process_tx/:tx_hash` accepted any string and let malformed input fall through to the RPC layer, producing a murky downstream error instead of a clean validation failure. Both endpoints now return the same `400` shape on malformed input:

```json
{ "error": "Invalid Starknet transaction hash format" }
```

## Known limitations / out of scope

- **No cross-request idempotency-key / response-replay caching.** There is no persistent idempotency-key store (e.g. Redis, a dedup table) in this service. If a caller (or an upstream retry/fan-out mechanism) sends the *same* transaction hash as two **separate** HTTP requests — rather than twice within one `process_batch` array — each request still performs its own RPC fetch and its own call to `processTxReceipt`. This remains safe at the DB layer (no duplicate rows, thanks to `onConflictDoNothing`), but it is not free: each request pays its own RPC cost, and the two HTTP responses are computed independently rather than one replaying the other's exact response body.
- Adding true cross-request idempotency (an `Idempotency-Key` header with response replay, backed by a persistent store) would require new infrastructure and is intentionally out of scope for this change. The within-request dedup and envelope validation fixes above address the ambiguity that was actually reported without requiring that infrastructure.

# Indexed Routes

The indexed routes (`src/routes/indexed.ts`) expose data derived from the indexer's sync process.

## Freshness and Sync Checkpoints

The indexer sync checkpoint is deterministically derived using `deriveSyncCheckpoint`. It evaluates the maximum block number present in a set of retrieved records.

- The `GET /indexed/freshness` and `GET /indexed/checkpoint` endpoints retrieve this high-water mark.
- **Resilience:** The checkpoint derivation securely filters out missing or non-positive block numbers and provides fallback logging (`indexer_checkpoint_invalid_block`) if any invalid numbers are encountered during derivation.
- A `0` block number signifies an empty or un-synced state.

## Endpoints

| Method | Path | Authorization | Description |
|---|---|---|---|
| GET | `/indexed/freshness` | Admin Auth (`requireAuth`, `requireAdmin`) | Indexer sync checkpoint block number and freshness state |
| GET | `/indexed/checkpoint` | Admin Auth (`requireAuth`, `requireAdmin`) | Indexer high-water mark sync checkpoint (no freshness) |
| GET | `/indexed/agreements/:contract_address/user/:user_address` | Public / Standard Read | Agreements where the user is employer, contributor, or a payroll employee |
| GET | `/indexed/agreement/:contract_address/:agreement_id` | Public / Standard Read | Full detail for one agreement (events, payments, milestones, employees, escrow events) |
| GET | `/indexed/payments/user/:user_address` | Public / Standard Read | Payments where the user is sender or recipient |
| GET | `/indexed/escrow/:contract_address/balance/:agreement_id` | Public / Standard Read | Escrow balance, computed by folding `Funded`/`Released`/`Refunded` events |

All `:contract_address`/`:user_address` params are validated with
`StarknetAddress`; `:agreement_id` with `AgreementId`. Pagination (`limit`,
`offset`) goes through the shared `parsePagination` helper.

---

## Structured Logging

Every request through `indexed.ts` emits exactly **one structured log line**
via the `logIndexedEvent()` helper.

### Log entry shape

```jsonc
{
  "timestamp": "2026-07-28T12:00:00.000Z",
  "level": "info",            // "info" for success, "error" for 5xx
  "op": "indexed.agreement_detail",
  "durationMs": 42,
  "syncCheckpoint": 12345,    // highest block number in returned rows
  "httpStatus": 200,
  // Plus route-specific fields (count, eventsCount, agreementId, etc.)
}
```

### Format selection

| `LOG_FORMAT` env var | Output |
|---|---|
| `"json"` (default) | Single JSON object per request to stdout |
| anything else | Human-readable text: `[indexed] <timestamp> INFO <op> key=value ...` |

### Operation names

Exported as `INDEXED_OPS` for stable referencing in dashboards and log queries:

| Constant | Operation name |
|---|---|
| `INDEXED_OPS.FRESHNESS` | `indexed.freshness` |
| `INDEXED_OPS.CHECKPOINT` | `indexed.checkpoint` |
| `INDEXED_OPS.AGREEMENTS_FOR_USER` | `indexed.agreements_for_user` |
| `INDEXED_OPS.AGREEMENT_DETAIL` | `indexed.agreement_detail` |
| `INDEXED_OPS.PAYMENTS_FOR_USER` | `indexed.payments_for_user` |
| `INDEXED_OPS.ESCROW_BALANCE` | `indexed.escrow_balance` |

---

## Metric Counters

Process-local, monotonically increasing counters — no external metrics library
is introduced.  Snapshot via `getIndexedMetricsSnapshot()` for diagnostics or
an admin endpoint.  Reset via `resetIndexedMetrics()` (tests only).

| Counter name (`INDEXED_METRICS`) | Meaning |
|---|---|
| `indexed_requests_total` | Total requests received per route |
| `indexed_rows_found_total` | Requests that returned at least one row |
| `indexed_sync_checkpoint_observed_total` | Requests that observed a non-zero sync checkpoint |
| `indexed_errors_total` | Server errors (5xx) — **404s do NOT increment this** |

**Increment semantics:** `incIndexedMetric(name, by = 1)` creates the counter
on first write.  Every route handler calls `incIndexedMetric(INDEXED_METRICS.REQUESTS)`
on entry, and conditionally increments `ROWS_FOUND` and `SYNC_CHECKPOINT_OBSERVED`
based on the response.  `ERRORS` is only incremented in the `catch` block (5xx path).

---

## Authorization

All checkpoint-related routes require an authenticated administrator session (`requireAuth` + `requireAdmin`) and enforce authorization before any internal database interactions.

### Authorization Contract & Security Boundary

`src/routes/indexed.ts` enforces a centralized authorization boundary around indexer freshness and sync checkpoint operations:

#### 1. Authorization Requirements
- **Freshness & Sync Checkpoints (`/indexed/freshness`, `/indexed/checkpoint`)**:
  - Requires session authentication (`requireAuth`) via `x-user-address` and `Authorization: Bearer <token>` headers.
  - Requires admin role authorization (`requireAdmin`).
  - Access control is centralized using `authorizeIndexedFreshness` (`[requireAuth, requireAdmin]`).
  - Permission checks are evaluated **strictly before** any database query, state lookup, or sensitive processing occurs.

#### 2. Expected Success Responses
- `GET /indexed/freshness`:
  ```json
  {
    "source": "indexed",
    "checkpointBlock": 12345,
    "freshness": "synced"
  }
  ```
- `GET /indexed/checkpoint`:
  ```json
  {
    "source": "indexed",
    "checkpointBlock": 12345
  }
  ```
  Note: `/indexed/checkpoint` intentionally omits the `freshness` field — it is a narrower contract returning only the high-water mark.

#### 3. Expected Authorization Failure Responses
- **401 Unauthorized**:
  - Returned when `x-user-address` or `Authorization` headers are missing or invalid.
  - Payload: `{ "error": "Unauthorized" }`
- **403 Forbidden**:
  - Returned when the caller is authenticated but lacks admin privileges.
  - Payload: `{ "error": "Forbidden" }`
- **Security & Privacy Guarantee**:
  - Failed requests receive no database state, high-water mark metrics, or internal execution details, preventing state inference or probing by unauthorized callers.

---

## Indexer Freshness & Sync Checkpoint Contract

`src/routes/indexed.ts` owns the indexer data access contract for read operations:

### 1. Snapshot Read Semantics & Data Freshness
- Endpoints in `indexed.ts` query local PostgreSQL tables populated by the Apibara indexer.
- Reads represent a point-in-time snapshot of indexed state up to the latest block stored in the database.
- Every response from `/indexed/agreements/...` identifies its data origin with `source: "indexed"` (exported as `INDEXED_DATA_SOURCE`).

### 2. Sync Checkpoints (`deriveSyncCheckpoint`)
- The indexer sync progress across indexed tables (`agreements`, `agreement_events`, `payments`, `escrow_events`, `milestones`, `employees`) is marked by the `block_number` stored with each event or entity.
- The `deriveSyncCheckpoint(records)` helper calculates the highest block number (high-water mark) across a set of retrieved records.
- If a query returns an empty result set or records without block numbers, `deriveSyncCheckpoint` returns `0`.
- This function is **pure and deterministic**: repeated calls with the same input always return the same output.
- **`x-indexer-sync-checkpoint` Header**: Every successful response from the admin endpoints (`GET /indexed/freshness`, `GET /indexed/checkpoint`) and the read endpoints that return indexed records (`GET /indexed/agreements/...`, `GET /indexed/agreement/...`, `GET /indexed/payments/...`, `GET /indexed/escrow/...`) includes the `x-indexer-sync-checkpoint` HTTP header with the derived high-water mark block number.

---

## Idempotency Contract

All GET endpoints in `src/routes/indexed.ts` are **idempotent**:

### Guarantees
1. **No side effects**: Every endpoint is read-only. No writes, no state mutations, no cache updates.
2. **Deterministic responses**: For the same underlying database state, repeated requests produce identical response bodies and headers.
3. **Deterministic sync checkpoint**: `deriveSyncCheckpoint` is a pure function — same input always yields the same output.

### What this means for callers
- **Safe retry**: Callers may retry any failed GET request without risk of data corruption or ambiguous outcomes.
- **Safe caching**: The `Cache-Control` and `ETag` headers on public read endpoints enable CDN and browser caching without coordination.
- **Observable idempotency**: The `x-indexer-sync-checkpoint` header is stable for a given database state, so callers can verify they are seeing consistent results.

### Scope
This contract applies to all routes in `src/routes/indexed.ts`. Routes in other files (e.g. `src/routes/reprocess-events.ts`, `src/routes/backfill-events.ts`) are outside this contract.

---

## Constants

| Export | Value | Purpose |
|---|---|---|
| `INDEXED_DATA_SOURCE` | `"indexed"` | Tag in responses indicating data origin |
| `MAX_INTERNAL_LIMIT` | `200` | Hard cap on sub-resource queries in agreement detail |
| `MAX_ESCROW_EVENTS_LIMIT` | `500` | Hard cap on escrow events in balance calculation |

---

## Concurrent queries and hard bounding

Several endpoints need more than one independent read to answer a single
request. Where two queries don't depend on each other's result, they are
issued concurrently with `Promise.all` rather than one `await` after another,
so the request pays for the *slowest* query instead of the *sum* of both:

- **`/indexed/agreements/:contract_address/user/:user_address`** — the
  direct-agreements query (employer/contributor match) and the
  employee-agreements query (payroll join) don't depend on each other and run
  concurrently. Results are merged and deduplicated by agreement `id` in
  application code, then bounded to `limit`.
- **`/indexed/agreement/:contract_address/:agreement_id`** — events, payments,
  milestones, employees, and escrow events for the agreement are all fetched
  concurrently via a single `Promise.all`. Detail sub-resources are hard-capped
  at `MAX_INTERNAL_LIMIT = 200` to prevent unbounded database scans.

This is a correctness-neutral performance property: the merged/deduplicated
result is identical regardless of which query happens to finish first, since
combination only happens after both have resolved.

---

## Deduplication on the agreements-for-user endpoint

A user can match the direct-agreements query and the employee-agreements
query for the same agreement (e.g. an employer who is also listed as an
employee). Results from both queries are deduplicated by `id` using a `Map`
before the `limit` is applied, so the same agreement is never returned twice
and the response never exceeds the requested page size.

---

## Escrow balance calculation

`/indexed/escrow/:contract_address/balance/:agreement_id` computes balance by
folding over every escrow event for the agreement, in ascending block order
(bounded to `MAX_ESCROW_EVENTS_LIMIT = 500` events):

- `Funded` adds `amount`
- `Released` and `Refunded` subtract `amount`
- any other `eventType` is ignored

Amounts are handled as `BigInt` throughout and the final balance is returned
as a decimal string to avoid precision loss over the wire.

---

## Backward Compatibility & Callers

- **Top-level JSON response keys remain unchanged** across all read endpoints.
- **`source: "indexed"`** is preserved in `/indexed/agreements/:contract_address/user/:user_address`.
- **Error formats and status codes** (`400` validation/contract mismatch, `404` agreement not found, `500` server error) remain identical for existing callers.
- **`/indexed/checkpoint`** previously returned the same body as `/indexed/freshness`, including `freshness`. It now returns only `{ source, checkpointBlock }`. The `freshness` field is still available from `/indexed/freshness`.
- **All new observability (logging, metrics) is additive** — no existing response shapes or status codes change.
- **Assumptions About Existing Callers**:
  - Callers accessing indexer operational status/freshness must supply valid admin authentication headers (`x-user-address` + Bearer token).

---

## Edge Cases Intentionally Out of Scope

- **Real-time chain head comparison / staleness signaling** — these endpoints do not report how far behind the indexer is relative to chain head. That is exposed separately by `/indexer/status` (`src/routes/indexer-status.ts`), not by this file.
- **Manual re-indexing / event reprocessing** — event reprocessing and backfilling are owned by `src/routes/reprocess-events.ts` and `src/routes/backfill-events.ts`.
- **Cursor-based pagination** — these endpoints use offset/limit (`parsePagination`), not the cursor pattern documented in [`docs/routes/read.md`](./read.md).
- **Cross-request caching** — every request re-reads from Postgres; there is no in-process or shared cache in front of these queries.
- **Cache headers on `/indexed/payments` and `/indexed/escrow` endpoints** — these are public read endpoints but intentionally lack cache headers because response content could vary per-user address. Cache headers are applied only where response content is independent of the caller.

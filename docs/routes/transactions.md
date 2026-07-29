# Transactions Route

This document defines the backwards-compatible behavior for transaction filtering, export, and
reconciliation endpoints in `src/routes/transactions.ts`.

## Exported contracts

The backend guarantees the following response shapes for its existing callers. Future
modifications to fetching, filtering, or aggregating logic must preserve these structures.
Shapes are enforced at runtime via Zod (`TransactionExportSchema`, `TransactionRecordSchema`).

### `TransactionRecord`

Represents a single transaction item across any event type (payments, escrow funding/releases,
agreement events, milestone additions, employee additions).

```typescript
interface TransactionRecord {
  id: string;          // First 10 chars of transactionHash
  type: string;        // Human-readable label (e.g. "Payment Sent", "Agreement Funded")
  address: string;     // Counterparty address, truncated to "0x1234...5678"
  date: string;        // "Mon DD, YYYY" (e.g. "Jun 15, 2025")
  time: string;        // "h:MM AM/PM" without space (e.g. "10:30AM")
  token: string;       // Token symbol (e.g. "USDC", "STRK") or "-" when not applicable
  amount: string;      // Formatted amount with +/- prefix, or "-" when not applicable
  status: "Completed"; // Always "Completed"
  tokenIcon: string;   // Token icon URL, or "" when not applicable
  txHash: string;      // Full original transaction hash
  createdAt: Date;     // Event creation timestamp — used for sorting and reconciliation
}
```

### `TransactionExport`

The paginated envelope returned by both endpoints.

```typescript
interface TransactionExport {
  transactions: TransactionRecord[];
  total: number;    // See "total count and deduplication" below
  hasMore: boolean; // true when total > offset + limit
  limit: number;    // Clamped requested limit
  offset: number;   // Requested offset
}
```

## Endpoints

1. **Pagination Defaults:** Limit defaults to `50` (capped at `100`). Offset defaults to `0`.
2. **Filtering Defaults:** Without an explicit `startDate` or `endDate`, the `/filtered` endpoint defaults to bounding all time. If `eventTypes` is provided to the standard endpoint, it acts as an explicit inclusion list.
3. **Sorting Contract:** Records are primarily sorted by `createdAt` in descending order (newest first). A secondary sort on the literal `transactionHash` is used to break ties predictably.

## Error Handling

To ensure strict contract enforcement, the endpoints return `400 Bad Request` for malformed query inputs instead of bubbling up generic server errors (`500`):
- **Pagination:** Requests with non-positive `limit` (e.g. `0`, `-5`) or negative `offset` return `400`.
- **Date Filters:** Unrecognized date strings for `startDate`, `endDate`, `from`, or `to` return `400`. Providing a `startDate` that occurs strictly after `endDate` also returns `400`.
- **Event Types:** Requests containing an unrecognised or invalid event type in the `eventTypes` list return `400`.
- **Sorting:** Providing a `sortBy` value that is not explicitly in the allowlist (i.e. not `date` or `amount`) returns `400`.
### `GET /transactions/:user_address`

Returns the merged transaction feed for `user_address`.

| Parameter    | Type                        | Default | Notes |
|--------------|-----------------------------|---------|-------|
| `limit`      | integer, 1–100              | 50      | Clamped to 100 |
| `offset`     | integer ≥ 0                 | 0       | |
| `eventTypes` | comma-separated string      | —       | Inclusion list; see allowlist below |
| `sortBy`     | `"date"` \| `"amount"`      | —       | See sort contract below |
| `sortDir`    | `"asc"` \| `"desc"`         | `"desc"` | |
| `from`       | ISO 8601 date string        | —       | Lower bound on `createdAt` |
| `to`         | ISO 8601 date string        | —       | Upper bound on `createdAt` |

**Specifics:**
- Agreement events are deduplicated by `id` before merging.
- Employee rows are matched where the user is **either** the employer or the employee.

### `GET /transactions/:user_address/filtered`

Returns the filtered transaction feed for `user_address`.

| Parameter    | Type                        | Default | Notes |
|--------------|-----------------------------|---------|-------|
| `limit`      | integer, 1–100              | 50      | Clamped to 100 |
| `offset`     | integer ≥ 0                 | 0       | |
| `startDate`  | ISO 8601 date string        | —       | Lower bound on `createdAt` |
| `endDate`    | ISO 8601 date string        | —       | Upper bound on `createdAt` |
| `sortBy`     | `"date"` \| `"amount"`      | —       | |
| `sortDir`    | `"asc"` \| `"desc"`         | `"desc"` | |

**Specifics:**
- Agreement events are **not** deduplicated.
- Employee rows are matched only where the user **is** the employee (`employee-only` mode).
- `eventTypes` is not supported on this endpoint.

## Idempotency contract

All endpoints are safe to retry with the same parameters. The idempotency guarantee holds
because:

1. **Read-only** — `GET` requests do not mutate state, so retrying never produces a side-effect.

2. **Deterministic date validation** — invalid or inverted date ranges are rejected with
   `400 { success: false, error: "..." }` before any DB query is issued. Retrying the same
   malformed request always receives the same error response.

   - A date string that does not parse to a valid `Date` (e.g. `"not-a-date"`) → `400`.
   - A range where `from`/`startDate` is strictly after `to`/`endDate` → `400`.
   - Absent date params → no filter applied (all time, idempotent).

3. **Stable sort** — the merged array is sorted by `createdAt` descending with `txHash`
   ascending as a stable tiebreak, so the same input data always produces the same order.

4. **Deterministic pagination** — `limit` and `offset` are validated and clamped before use,
   so `hasMore` is always a pure function of `total`, `offset`, and `limit`.

### total count and deduplication

`total` is the **raw sum** of `COUNT(*)` across all five source tables for the matching
conditions. It does **not** account for the in-memory agreement-event deduplication applied
by the main endpoint. This means:

- `total` is a ceiling: `transactions.length ≤ limit ≤ total` in the deduplicated case.
- Reconciliation callers should page through results until `hasMore === false` rather than
  relying on `total` as an exact row count.

## Pagination

- `limit` defaults to 50 and is clamped to the range `[1, 100]`.
- `offset` defaults to 0 and must be non-negative.
- `hasMore` is `true` when `total > offset + limit`.

## Sort contract

`sortBy` must be one of `"date"` or `"amount"`. Any other value is rejected with `400` before
reaching any SQL construction — the value is never interpolated into a query.

- `"date"` sorts by `createdAt`.
- `"amount"` sorts by the numeric magnitude parsed from the formatted `amount` string.
- Omitting `sortBy` preserves the default ordering: `createdAt` descending + `txHash`
  ascending for stable tiebreaking.
- An invalid `sortDir` silently defaults to `"desc"`.

## Event-type allowlist

The `eventTypes` parameter accepts only the following values (comma-separated):

```
AgreementCreated, AgreementActivated, AgreementPaused, AgreementResumed,
AgreementCancelled, AgreementCompleted, AgreementStatusChange,
PaymentSent, PaymentReceived,
MilestoneAdded, MilestoneApproved, MilestoneClaimed,
EmployeeAdded, PayrollClaimed,
DisputeRaised, DisputeResolved,
Funded, Released, Refunded
```

Values outside this set are rejected before any DB call.

## Error responses

| Status | Condition |
|--------|-----------|
| 400    | `limit` ≤ 0 or `offset` < 0 |
| 400    | `sortBy` not in allowlist |
| 400    | `from`/`startDate` or `to`/`endDate` is not a valid ISO 8601 date |
| 400    | `from`/`startDate` is after `to`/`endDate` |
| 500    | Unexpected database or network error |

Date-validation errors use the body shape `{ success: false, error: "<description>" }`.
All other 400 errors use `{ error: "<description>" }`.

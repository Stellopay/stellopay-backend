# Transactions Route Documentation

This document explicitly defines the backwards-compatible behavior for transaction filtering, export, and reconciliation endpoints in `src/routes/transactions.ts`.

## Exported Contracts

The backend guarantees the following response shapes for its existing callers. Any future modifications to the transaction fetching, filtering, or aggregating logic must preserve these structures to ensure safe maintenance. These contracts are strictly enforced at runtime using Zod schemas (`TransactionExportSchema` and `TransactionRecordSchema`) to prevent regressions.

### `TransactionRecord`

Represents a single transaction item across any event type (payments, escrow funding/releases, agreement creation, milestone additions, employee additions).

```typescript
export interface TransactionRecord {
  id: string; // Truncated transaction hash (first 10 chars)
  type: string; // Formatted event type (e.g., "Payment Sent", "Agreement Funded")
  address: string; // The relevant counterparty's formatted address (truncated to 6...4 characters)
  date: string; // Formatted date string (e.g., "Jan 1, 2024")
  time: string; // Formatted time string (e.g., "12:00PM")
  token: string; // Token symbol (e.g., "USDC", "STRK") or "-" if not applicable
  amount: string; // Formatted amount with +/- sign (e.g., "+100.00") or "-" if not applicable
  status: "Completed"; // Hardcoded to Completed for now
  tokenIcon: string; // Token icon URL or empty string
  txHash: string; // The full original transaction hash
  createdAt: Date; // The underlying event creation timestamp for sorting and reconciliation
}
```

### `TransactionExport`

The standard paginated response object returned by both the standard and filtered transaction endpoints.

```typescript
export interface TransactionExport {
  transactions: TransactionRecord[]; // Array of backwards-compatible transaction items
  total: number; // The total number of records matching the query parameters
  hasMore: boolean; // Indicates if there are more records beyond the current limit/offset
  limit: number; // The maximum number of records requested/returned
  offset: number; // The pagination offset used for the request
}
```

## Backward-Compatible Filtering and Pagination

1. **Pagination Defaults:** Limit defaults to `50` (capped at `100`). Offset defaults to `0`.
2. **Filtering Defaults:** Without an explicit `startDate` or `endDate`, the `/filtered` endpoint defaults to bounding all time. If `eventTypes` is provided to the standard endpoint, it acts as an explicit inclusion list.
3. **Sorting Contract:** Records are primarily sorted by `createdAt` in descending order (newest first). A secondary sort on the literal `transactionHash` is used to break ties predictably.

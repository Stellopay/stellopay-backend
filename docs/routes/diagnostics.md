# Diagnostics Routes — Backward-Compatible Contract

> Source: `src/routes/diagnostics.ts`  
> Tests:  `src/routes/diagnostics.test.ts`  
> Access: Admin only (`requireAuth` + `requireAdmin`)

---

## Overview

The diagnostics surface exposes internal data shapes and table volumes for
operator use. Every route in this router requires **both** a valid session token
and a caller address present in the `ADMIN_ADDRESSES` config list. All requests
that fail either check receive `401` — no database query is executed.

There is currently one endpoint:

```
GET /api/v1/diagnostics/events
```

---

## Auth Contract

| Check | Middleware | Failure |
|---|---|---|
| Valid session token | `requireAuth` | `401 Unauthorized` |
| Address in `ADMIN_ADDRESSES` | `requireAdmin` | `401 Unauthorized` |

Both checks run on every request before any handler logic. No DB query is
executed for unauthorized callers. This gating is **frozen** — loosening it is
a security change and requires explicit review.

---

## `GET /api/v1/diagnostics/events`

Returns aggregate event counts, table volumes, connection-pool stats, and a
redacted recent-activity feed.

All five SQL queries are **static and parameter-free** — no request input ever
reaches a query. This is intentional; the endpoint is a read-only snapshot.

### Success `200`

```jsonc
{
  "eventTypeCounts": [
    { "event_type": "AgreementCreated", "count": "5" }
    // … one row per distinct event_type in agreement_events
  ],
  "escrowEventCounts": [
    { "event_type": "Funded", "count": "2" }
    // … one row per distinct event_type in escrow_events
  ],
  "paymentEventCounts": [
    { "event_type": "PaymentSent", "count": "3" }
    // … one row per distinct event_type in payments
  ],
  "tableCounts": {
    "agreement_events_count": "5",
    "escrow_events_count":    "2",
    "payments_count":         "3",
    "employees_count":        "1",
    "milestones_count":       "4",
    "agreements_count":       "3",
    "latest_block":           "100"
  },
  "latestEvents": [
    // REDACTED — see policy below
    { "event_type": "AgreementCreated", "created_at": "2026-01-01T00:00:00Z" }
  ],
  "poolStats": { "total": 8, "idle": 3, "active": 5, "waiting": 2 },
  "summary": {
    "totalAgreementEvents": "5",
    "totalEscrowEvents":    "2",
    "totalPayments":        "3",
    "totalEmployees":       "1",
    "totalMilestones":      "4",
    "latestBlock":          "100"
  }
}
```

This shape is **frozen**. Changing any key name or removing a field is a
breaking change for existing operator tooling.

### Errors

| Status | Condition |
|--------|-----------|
| `401`  | Missing session token or non-admin address |
| `500`  | Unexpected database error (forwarded via Express error handler) |

---

## Redaction Policy — `latestEvents`

`latestEvents` contains up to 20 of the most recent rows from `agreement_events`,
ordered by `created_at DESC`.

**Only `event_type` and `created_at` are included.** `transaction_hash` and
`agreement_id` are **never** present in any `latestEvents` row. They are
excluded both from the SQL `SELECT` and from the application-level mapping.

This invariant is load-bearing and enforced by tests. Raw identifiers are a
reconnaissance vector — do not add them back without a security review.

```
// ✅ safe — always present
{ "event_type": "AgreementCreated", "created_at": "…" }

// ❌ never present — redacted
{ "transaction_hash": "…", "agreement_id": "…" }
```

---

## Empty Database Behaviour

When any table is empty the endpoint still returns `200`. The `summary` fields
fall back to `0` via `?? 0` guards, and `latestEvents` is an empty array `[]`.
`tableCounts` is `{}` when the aggregate query returns no rows.

| Field | Empty-DB value |
|---|---|
| `summary.*` | `0` |
| `latestEvents` | `[]` |
| `tableCounts` | `{}` |
| `eventTypeCounts` | `[]` |
| `escrowEventCounts` | `[]` |
| `paymentEventCounts` | `[]` |

---

## `poolStats` Shape

Sourced from `getPoolStats()` in `src/db/index.ts`. Shape is:

```jsonc
{ "total": number, "idle": number, "active": number, "waiting": number }
```

---

## Query Inventory

Five static queries are executed per request, in order:

| # | Table | Purpose |
|---|---|---|
| 1 | `agreement_events` | `COUNT(*) GROUP BY event_type` |
| 2 | `escrow_events` | `COUNT(*) GROUP BY event_type` |
| 3 | `payments` | `COUNT(*) GROUP BY event_type` |
| 4 | All tables | Aggregate row counts + `MAX(block_number)` |
| 5 | `agreement_events` | Last 20 rows — `event_type, created_at` only |

---

## Out of Scope (issue #279)

The following are intentionally not covered by this surface:

- **Write operations** — no `POST`/`PATCH`/`DELETE` endpoints exist; this is
  a read-only diagnostic surface.
- **Per-agreement or per-address drill-down** — all data is aggregate only.
- **Pagination** — `latestEvents` is capped at 20 rows; pagination is a
  follow-up concern.
- **Escrow/payment recent-activity feeds** — only `agreement_events` has a
  recent-activity list; escrow and payment feeds are out of scope.
- **Fine-grained admin roles** — all admin addresses share identical access;
  role-based access control is a future concern.

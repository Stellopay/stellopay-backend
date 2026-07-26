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
reaches a query.

### Success `200`

```jsonc
{
  "eventTypeCounts": [
    { "event_type": "AgreementCreated", "count": "5" }
  ],
  "escrowEventCounts": [
    { "event_type": "Funded", "count": "2" }
  ],
  "paymentEventCounts": [
    { "event_type": "PaymentSent", "count": "3" }
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
excluded from both the SQL `SELECT` and the application-level map.

```
// ✅ always present
{ "event_type": "AgreementCreated", "created_at": "…" }

// ❌ never present — redacted
{ "transaction_hash": "…", "agreement_id": "…" }
```

This invariant is load-bearing and enforced by tests.

---

## Empty Database Behaviour

When any table is empty the endpoint still returns `200`. The `summary` fields
fall back to `0` via `|| 0` guards, and `latestEvents` is an empty array `[]`.

| Field | Empty-DB value |
|---|---|
| `summary.*` | `0` |
| `latestEvents` | `[]` |
| `eventTypeCounts` | `[]` |
| `escrowEventCounts` | `[]` |
| `paymentEventCounts` | `[]` |

---

## Query Inventory

Five static queries execute per request, in order:

| # | Table | Purpose |
|---|---|---|
| 1 | `agreement_events` | `COUNT(*) GROUP BY event_type` |
| 2 | `escrow_events` | `COUNT(*) GROUP BY event_type` |
| 3 | `payments` | `COUNT(*) GROUP BY event_type` |
| 4 | All tables | Aggregate row counts + `MAX(block_number)` |
| 5 | `agreement_events` | Last 20 rows — `event_type, created_at` only |

---

## Out of Scope (issue #279)

- **Write operations** — read-only surface; no `POST`/`PATCH`/`DELETE`.
- **Per-agreement or per-address drill-down** — all data is aggregate only.
- **Pagination** — `latestEvents` is capped at 20 rows.
- **Escrow/payment recent-activity feeds** — only `agreement_events` has a recent-activity list.
- **Fine-grained admin roles** — all admin addresses share identical access.

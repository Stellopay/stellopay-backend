# Notifications Route

**File:** `src/routes/notifications.ts`  
**Mounted at:** `/api/v1`

---

## Overview

The notifications route aggregates on-chain activity (payments, agreement
lifecycle events, and escrow events) into a unified, paginated feed for a
given Starknet address.  All data is public on-chain; the route is currently
unauthenticated.  If per-user write state (e.g. persistent read flags) is
added in the future, a `requireAuth` guard **must** be added at that point.

---

## Endpoints

### `GET /api/v1/notifications/:user_address`

Returns a paginated list of important events for the supplied Starknet address.

#### Path parameters

| Parameter      | Type   | Description                                              |
|----------------|--------|----------------------------------------------------------|
| `user_address` | string | Starknet address (hex, with or without `0x` prefix).     |

The address is validated by `StarknetAddress.parse` and canonicalized to
`0x` + 64 lower-case hex characters before use as a DB filter.  Malformed
addresses (non-hex, too long, invalid checksum) are rejected with **400**.

#### Query parameters

| Parameter | Type    | Default | Maximum | Description                                                  |
|-----------|---------|---------|---------|--------------------------------------------------------------|
| `limit`   | integer | `10`    | `50`    | Number of items per page. Out-of-range values return **400**.|
| `offset`  | integer | `0`     | —       | Zero-based item offset. Negative values return **400**.      |

Both defaults and the maximum are frozen — see
[Pagination contract](#pagination-contract) below.

#### Response `200 OK`

```json
{
  "notifications": [
    {
      "id":      "string",
      "title":   "string",
      "message": "string",
      "read":    false,
      "date":    "2026-07-28T12:00:00.000Z",
      "type":    "string",
      "txHash":  "string"
    }
  ],
  "total":       1,
  "unreadCount": 1,
  "limit":       10,
  "offset":      0,
  "hasMore":     false
}
```

#### Response `400 Bad Request`

Returned when:
- `user_address` is not a valid Starknet hex string.
- `limit` is 0, negative, non-numeric, or greater than 50.
- `offset` is negative or non-numeric.

```json
{ "error": "Validation failed", "details": [...] }
```

---

## Response shape contract (stable)

The following fields are **frozen**.  Existing callers depend on their names
and types; they cannot be removed or renamed.

### `NotificationItem`

| Field     | Type      | Notes                                              |
|-----------|-----------|----------------------------------------------------|
| `id`      | `string`  | Unique row identifier from the source table.       |
| `title`   | `string`  | Human-readable title (see title map below).        |
| `message` | `string`  | Detail sentence (format stable per event type).    |
| `read`    | `boolean` | Always `false`; server-side read state not yet persisted. |
| `date`    | `string`  | ISO 8601 UTC timestamp of the underlying event.    |
| `type`    | `string`  | Raw on-chain `eventType` string.                   |
| `txHash`  | `string`  | Transaction hash of the event.                     |

### `NotificationsResponse` envelope

| Field           | Type                  | Notes                                                   |
|-----------------|-----------------------|---------------------------------------------------------|
| `notifications` | `NotificationItem[]`  | Up to `limit` items, sorted newest-first by `date`.     |
| `total`         | `number`              | Length of the `notifications` array after slicing.      |
| `unreadCount`   | `number`              | Count of items where `read === false` (≡ `total` today).|
| `limit`         | `number`              | Echoed from request (or default 10).                    |
| `offset`        | `number`              | Echoed from request (or 0).                             |
| `hasMore`       | `boolean`             | `true` when items exist beyond the current page.        |

---

## Notification preferences contract (stable)

`getDefaultNotificationPreferences()` returns a fresh object on every call —
never a shared singleton.  All four category fields default to `true`.

```ts
interface NotificationPreferences {
  payments:   boolean;  // PaymentSent, PaymentReceived
  agreements: boolean;  // AgreementCreated, AgreementActivated, AgreementCancelled
  escrow:     boolean;  // Funded, Released, Refunded
  disputes:   boolean;  // DisputeRaised, DisputeResolved
}
```

**Backward-compatibility rules:**
- Existing fields cannot be removed or renamed.
- New optional fields may be added in the future.
- Default values (all `true`) are frozen.

---

## Unread count contract (stable)

`calculateUnreadCount(notifications)` is exported so callers can recompute
unread counts independently of the HTTP handler.

**Guarantees:**
- Deduplicates by `id` when present — the same `id` is counted at most once.
- Notifications without an `id` are counted individually (no deduplication key).
- Supports both `string` and `number` id types, including `0`.
- Only counts items where `read === false`.
- Missing or malformed `read` values are treated as read items, which keeps
  partially hydrated or replayed records from inflating the unread count.
- Returns `0` for an empty array.

**Invariant in the HTTP response:** because every emitted notification has
`read: false`, `unreadCount` always equals `total` in the current
implementation.  Both fields are included in the response so callers can use
whichever is more convenient.

---

## Pagination contract

| Constant                    | Value | Notes                                      |
|-----------------------------|-------|--------------------------------------------|
| `NOTIFICATIONS_DEFAULT_LIMIT` | `10` | Intentionally smaller than the project-wide default of 50. |
| `NOTIFICATIONS_MAX_LIMIT`     | `50` | Requests above this are rejected with 400. |

`hasMore` uses strict greater-than (`merged.length > offset + limit`): a
page that fills exactly to the limit returns `hasMore: false` because there
are no items beyond the current boundary.

`queryLimit = limit + offset` is passed to each data-source query so the
merged pool always contains enough rows to serve any page within the
documented range without a second round-trip.

---

## Event types and titles

### Payments (`payments` table)

| `eventType`       | `title`            | `message` pattern                                     |
|-------------------|--------------------|-------------------------------------------------------|
| `PaymentSent`     | `Payment Sent`     | `#<txHash[0:10]> · You sent <amount> tokens`          |
| `PaymentReceived` | `Payment Received` | `#<txHash[0:10]> · You received <amount> tokens`      |

### Agreement events (`agreementEvents` table)

Titles are produced by inserting a space before each capital letter:
`AgreementCreated` → `Agreement Created`.

| `eventType`            | `title`                 | `message` pattern                              |
|------------------------|-------------------------|------------------------------------------------|
| `AgreementCreated`     | `Agreement Created`     | `Agreement #<id> has been created`             |
| `AgreementActivated`   | `Agreement Activated`   | `Agreement <id>: AgreementActivated`           |
| `AgreementCancelled`   | `Agreement Cancelled`   | `Agreement <id>: AgreementCancelled`           |
| `DisputeRaised`        | `Dispute Raised`        | `Agreement <id>: DisputeRaised`                |
| `DisputeResolved`      | `Dispute Resolved`      | `Agreement <id>: DisputeResolved`              |

### Escrow events (`escrowEvents` table)

| `eventType` | `title`            | `message` pattern                                      |
|-------------|--------------------|--------------------------------------------------------|
| `Funded`    | `Agreement Funded` | `Agreement <id>: Funded of <amount> tokens`            |
| `Released`  | `Funds Released`   | `Agreement <id>: Released of <amount> tokens`          |
| `Refunded`  | `Funds Refunded`   | `Agreement <id>: Refunded of <amount> tokens`          |

Token amounts are formatted using the agreement's token decimals (STRK = 18,
USDC/USDT = 6). When the escrow event references an agreement not in the
user's agreement list, the amount is formatted with 0 decimals (integer
count).

---

## Telemetry

Every request emits a `notification_preferences_and_unread_count` metric via
`logNotificationsTelemetry`.  The log entry never includes the user address
or notification content — only low-cardinality counters.

| Field                | Type     | Notes                                              |
|----------------------|----------|----------------------------------------------------|
| `operation`          | `string` | Always `"notification_feed"`.                      |
| `status`             | `string` | `"success"` or `"error"`.                          |
| `duration_ms`        | `number` | Wall-clock time for the full handler.              |
| `notification_count` | `number` | Length of the returned page (success only).        |
| `unread_count`       | `number` | `calculateUnreadCount` result (success only).      |
| `preferences_enabled`| `number` | Count of `true` fields in default prefs (always 4).|
| `error`              | `string` | Error message (error path only).                   |

---

## Authorization

The route is **unauthenticated**.  Each DB query is filtered to the
`user_address` path parameter so a caller cannot read another address's
notifications by modifying the path.  The address is canonicalized before use
as a query filter, preventing lookup-key injection.

---

## Out of scope

The following are intentionally not implemented by this route:

- **Per-user read state** — `read` is always `false`; no server-side
  persistence exists yet.  A `requireAuth` guard and a write endpoint are
  required before this can be added safely.
- **Preference-filtered feeds** — `getDefaultNotificationPreferences()`
  returns the defaults but the route does not filter the DB queries by
  category.  Preference-aware filtering is a future extension.
- **`/unread-count` sub-resource** — there is no separate unread-count
  endpoint; callers use the `unreadCount` field in the main response.
- **`PATCH /preferences`** — there is no preference-update endpoint; the
  preferences object describes the default shape only.

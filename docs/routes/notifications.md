# User Notifications API (`/notifications/*`)

The notifications endpoint aggregates key on-chain activities (payments,
agreement status transitions, escrow state changes, disputes) for a specified
Starknet user address.

---

## Backward-Compatibility Contract

The response shape is **stable**. The fields and behaviors described in this
document MUST be preserved across future changes so that existing callers
continue to work without modification.

Additive fields (`limit`, `offset`, `hasMore`) were introduced alongside the
existing `notifications`, `total`, and `unreadCount` fields. Callers that
ignore unknown fields are unaffected; callers that want pagination should
use the new fields.

---

## Authorization Boundary

The route queries data strictly scoped to the address supplied in the URL path:

- All three DB queries (payments, agreement events, escrow events) filter on the
  supplied `user_address`.
- The address is validated by `StarknetAddress.parse` before being used as a
  filter, preventing lookup-key injection.
- Callers can only read notifications for the exact address they supply;
  cross-user data access is structurally impossible from this route.

**Current auth state**: This route is unauthenticated — it returns aggregated
public on-chain data and does not expose any private state. If per-user write
state (e.g. persistent read/unread) is added in the future, a `requireAuth`
guard MUST be added at that point.

---

## Endpoint Contract

### `GET /api/v1/notifications/:user_address`

Returns a chronological list of recent notifications, total items, and unread
count for a user. Supports offset-based pagination.

#### Path Parameters

| Parameter | Type | Description | Required |
| :--- | :--- | :--- | :--- |
| `user_address` | String | Valid Starknet address (0x-prefixed or hex string). Automatically validated & normalized via `StarknetAddress.parse`. | Yes |

#### Query Parameters

| Parameter | Type | Default | Constraint | Description |
| :--- | :--- | :--- | :--- | :--- |
| `limit` | Integer | `10` | positive integer, max `50` | Maximum number of notifications to return per page. Out-of-range values are rejected with `400 Validation failed` before any database call. |
| `offset` | Integer | `0` | non-negative integer | Number of notifications to skip before the returned page. Negative values are rejected with `400 Validation failed`. |

---

#### Success Response (`200 OK`)

```json
{
  "notifications": [
    {
      "id": "event-101",
      "title": "Agreement Created",
      "message": "Agreement #ag-123 has been created",
      "read": false,
      "date": "2026-07-26T18:00:00.000Z",
      "type": "AgreementCreated",
      "txHash": "0x0123456789abcdef..."
    },
    {
      "id": "payment-202",
      "title": "Payment Received",
      "message": "#0x01234567 · You received 10.5 tokens",
      "read": false,
      "date": "2026-07-26T17:30:00.000Z",
      "type": "PaymentReceived",
      "txHash": "0x0123456789abcdef..."
    }
  ],
  "total": 2,
  "unreadCount": 2,
  "limit": 10,
  "offset": 0,
  "hasMore": false
}
```

**Frozen fields (must not change):**

| Field | Type | Notes |
| :--- | :--- | :--- |
| `notifications` | array | Up to `limit` items, sorted newest-first by `date`. |
| `notifications[].id` | string | DB row identifier. |
| `notifications[].title` | string | Human-readable title (see frozen title set below). |
| `notifications[].message` | string | Detail sentence; format is stable per event type. |
| `notifications[].read` | boolean | Always `false` (no server-side read state). |
| `notifications[].date` | string | ISO 8601 timestamp. |
| `notifications[].type` | string | Raw on-chain `eventType` string. |
| `notifications[].txHash` | string | Transaction hash. |
| `total` | integer | Length of the `notifications` array (post-slice). |
| `unreadCount` | integer | Count of items where `read === false` (always equals `total`). |

**Additive pagination fields (present in all responses):**

| Field | Type | Notes |
| :--- | :--- | :--- |
| `limit` | integer | Echoed request limit (or the default of 10). |
| `offset` | integer | Echoed request offset (or 0 when omitted). |
| `hasMore` | boolean | `true` when additional notifications exist beyond this page. Clients should re-request with `offset += limit` to fetch the next page. |

**Frozen event-type → title mapping:**

| `type` | `title` |
| :--- | :--- |
| `PaymentSent` | `"Payment Sent"` |
| `PaymentReceived` | `"Payment Received"` |
| `DisputeRaised` | `"Dispute Raised"` |
| `DisputeResolved` | `"Dispute Resolved"` |
| `AgreementActivated` | `"Agreement Activated"` |
| `AgreementCreated` | `"Agreement Created"` |
| `AgreementCancelled` | `"Agreement Cancelled"` |
| `Funded` | `"Agreement Funded"` |
| `Released` | `"Funds Released"` |
| `Refunded` | `"Funds Refunded"` |

---

## Pagination Model

The endpoint uses offset-based pagination. The merged pool of all three data
sources is sorted newest-first and then sliced:

```
page = sorted_pool[ offset : offset + limit ]
```

To iterate all notifications, callers advance the offset by `limit` until
`hasMore` is `false`:

```
GET /api/v1/notifications/<addr>?limit=10&offset=0   → page 1, hasMore: true
GET /api/v1/notifications/<addr>?limit=10&offset=10  → page 2, hasMore: true
GET /api/v1/notifications/<addr>?limit=10&offset=20  → page 3, hasMore: false
```

If `offset` is beyond the available pool, an empty `notifications` array is
returned with `hasMore: false` — this is not an error.

---

## Backend Behavior

### Data Sources

The route reads from four tables and combines them into a single ordered feed
of notifications:

| Source | `eventType` filter | Notes |
| :--- | :--- | :--- |
| `payments` | (none) | Includes `PaymentSent` and `PaymentReceived`. Matched when the user is `from` or `to`. |
| `agreementEvents` | `DisputeRaised`, `DisputeResolved`, `AgreementActivated`, `AgreementCancelled`, `AgreementCreated` | Only fetched when the user owns at least one agreement; an empty `agreementIds` set short-circuits the query entirely. |
| `escrowEvents` | (none) | Matches when the user is `employer` or `to`. The token used for amount formatting is read from the joined `agreements.token`. |

The merged array is sorted by `date` descending and sliced to the requested
page (`[offset, offset+limit]`). The response's `total` and
`notifications.length` always equal the post-slice length; `unreadCount` is
computed from the same array via the exported `calculateUnreadCount` helper.

### Batching Contract

Each data-source query receives a `queryLimit` of `limit + offset` rows.
This ensures the merged pool always contains enough rows to satisfy the
requested page:

```
queryLimit = limit + offset
page       = sorted_pool.slice(offset, offset + limit)
hasMore    = sorted_pool.length > offset + limit
```

Because `NOTIFICATIONS_MAX_LIMIT = 50`, `queryLimit` is bounded to at most
100 rows per source per request (when `limit=50` and `offset=50`).

### Query Execution Order

The three queries that depend only on `userAddress` (`payments`,
`agreements`, `escrowEvents`) are fired through `Promise.all` so a slow
payment lookup does not serialize in front of the escrow or agreements
lookups. The dependent `agreementEvents` query runs as a single follow-up
because its `inArray(.., agreementIds)` filter needs `agreements.id`
values. When the user has no agreements, the dependent query is fully
skipped (`agreementIds.length > 0` short-circuit).

### Per-Request Memoization

Two helpers are bound to the route handler so their caches are scoped to a
single request:

- `getTokenInfoCache` — key on the normalized token address. The escrow-event
  mapping resolves token info once per unique token, so 10 escrow events on
  the same agreement produce one `getTokenInfo` call, not ten.
- `formatTitleCache` — key on `eventType`. Surfacing the same `eventType`
  ten times re-runs the regex once.

Both caches live inside the route handler and are discarded at the end of
each request; they cannot carry stale config across env reloads or leak
state across simultaneous requests.

---

## Notification Preferences Contract

User notification preferences are exposed as a typed contract on
`src/routes/notifications.ts`:

```typescript
export interface NotificationPreferences {
  payments: boolean;   // PaymentSent, PaymentReceived
  agreements: boolean; // AgreementCreated, AgreementActivated, AgreementCancelled
  escrow: boolean;     // Funded, Released, Refunded
  disputes: boolean;   // DisputeRaised, DisputeResolved
}
```

- **`getDefaultNotificationPreferences()`** — Returns a fresh
  `{ payments: true, agreements: true, escrow: true, disputes: true }`
  object on every call. Callers can mutate the returned object without
  poisoning other callers.
- **`calculateUnreadCount(notifications)`** — Single source of truth for
  the unread-count field; counts items where `read === false`. The
  notifications route invokes this helper on its outgoing payload rather
  than reaching for `Array.length` directly, so the response stays in
  lockstep with the helper's semantics.

Both helpers are exported for unit-testing and future preference-filtering logic without making HTTP requests.

---

## Amount Formatting

Token amounts in notification messages are formatted by `formatTokenAmount` with
the token's decimal precision. Token lookup is by contract address:

| Token | Decimals |
| :--- | :--- |
| STRK | 18 |
| USDC | 6 |
| USDT | 6 |
| unknown / null | 6 (default) |

Formatting uses BigInt arithmetic so u256 amounts are never truncated through
`Number` before display.

---

## Error Handling

| Status | Error Message | Description |
| :--- | :--- | :--- |
| `400 Bad Request` | `Validation failed` | Returned when `user_address` is not a valid Starknet address, `limit` is non-numeric / non-positive / above `50`, or `offset` is non-numeric / negative. |

Errors propagate through the central error handler with structured Zod
`details` so misbehaving clients see which field failed, identical to the
other `/api/v1/*` routes.

---

## Compatibility Notes

- The response envelope is `{ notifications, total, unreadCount, limit, offset, hasMore }`.
  The original three fields (`notifications`, `total`, `unreadCount`) are
  frozen; the pagination fields are additive. Callers that ignore unknown
  fields are unaffected.
- The default `limit` is intentionally `10` (not `50` like the project's
  shared `parsePagination`) for backward compatibility with callers that
  rely on the smaller default; out-of-range `limit` values are still
  rejected with `400` rather than silently clamped.
- The exported constants `NOTIFICATIONS_DEFAULT_LIMIT` (10) and
  `NOTIFICATIONS_MAX_LIMIT` (50) are the single source of truth for the
  documented pagination bounds. Tests import them directly so constant and
  behavior cannot drift.

---

## Out of Scope Edge Cases

- **Persistent Preference Database Storage**: Custom per-user preference
  overrides stored in DB tables are out of scope for this route. The
  `NotificationPreferences` contract is exported for future work; the
  current handler does not yet filter the merged feed against it.
- **Push Notification Transport**: Delivery via Web Push, APNs, or
  email webhooks is managed out-of-band.
- **Read State Persistence**: Every emitted notification has `read: false`
  hardcoded. `calculateUnreadCount` therefore currently matches
  `notifications.length`; the helper exists so that future read-state
  storage can plumb through without changing the response shape.
- **Cursor-based pagination**: Offset pagination is sufficient for the
  current feed size. Cursor-based pagination (stable under concurrent
  inserts) is out of scope for this issue.

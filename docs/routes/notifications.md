# User Notifications API (`/notifications/*`)

The notifications endpoint aggregates key on-chain activities (payments,
agreement status transitions, escrow state changes, disputes) for a specified
Starknet user address.

---

## Endpoint Contract

### `GET /api/v1/notifications/:user_address`

Returns a chronological list of recent notifications, total items, and unread
count for a user.

#### Path Parameters

| Parameter | Type | Description | Required |
| :--- | :--- | :--- | :--- |
| `user_address` | String | Valid Starknet address (0x-prefixed or hex string). Automatically validated & normalized via `StarknetAddress.parse`. | Yes |

#### Query Parameters

| Parameter | Type | Default | Constraint | Description |
| :--- | :--- | :--- | :--- | :--- |
| `limit` | Integer | `10` | positive integer, max `50` | Maximum number of notifications to return. Out-of-range values are rejected with `400 Validation failed` before any database call. |

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
  "unreadCount": 2
}
```

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

The merged array is sorted by `date` descending and sliced to `limit`. The
response's `total` and `notifications.length` always equal the post-slice
length; `unreadCount` is computed from the same array via the exported
`calculateUnreadCount` helper.

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

---

## Error Handling

| Status | Error Message | Description |
| :--- | :--- | :--- |
| `400 Bad Request` | `Validation failed` | Returned when `user_address` is not a valid Starknet address, or `limit` is non-numeric, non-positive, or above `50`. |

Errors propagate through the central error handler with structured Zod
`details` so misbehaving clients see which field failed, identical to the
other `/api/v1/*` routes.

---

## Compatibility Notes

- The response envelope is `{ notifications, total, unreadCount }` with the
  same keys and types documented in the success-response block above. Older
  callers depend on this shape; any additively-new field can be added later
  without breaking them.
- The default `limit` is intentionally `10` (not `50` like the project's
  shared `parsePagination`) for backward compatibility with callers that
  rely on the smaller default; out-of-range `limit` values are still
  rejected with `400` rather than silently clamped.

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

# User Notifications API (`/notifications/*`)

The notifications endpoint aggregates key on-chain activities (payments, agreement status transitions, escrow state changes, disputes) for a specified Starknet user address.

---

## Backward-Compatibility Contract

The response shape is **stable**. The fields and behaviors described in this
document MUST be preserved across future changes so that existing callers
continue to work without modification.

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

Returns a chronological list of recent notifications, total items, and unread count for a user.

#### Path Parameters

| Parameter | Type | Description | Required |
| :--- | :--- | :--- | :--- |
| `user_address` | String | Valid Starknet address (0x-prefixed or hex string). Automatically validated & normalized via `StarknetAddress.parse`. | Yes |

#### Query Parameters

| Parameter | Type | Default | Constraint | Description |
| :--- | :--- | :--- | :--- | :--- |
| `limit` | Integer | `10` | `1` to `50` | Maximum number of notifications to return. |

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
| `total` | integer | Length of `notifications` array. |
| `unreadCount` | integer | Count of items where `read === false` (always equals `total`). |

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

## Notification Preferences Contract

User notification preference defaults are defined by the `NotificationPreferences` contract exported from `src/routes/notifications.ts`:

```typescript
export interface NotificationPreferences {
  payments: boolean;   // PaymentSent, PaymentReceived
  agreements: boolean; // AgreementCreated, AgreementActivated, AgreementCancelled
  escrow: boolean;     // Funded, Released, Refunded
  disputes: boolean;   // DisputeRaised, DisputeResolved
}
```

- **Default Preferences (`getDefaultNotificationPreferences`)**: All notification categories (`payments`, `agreements`, `escrow`, `disputes`) default to `true`.
- **Unread Count (`calculateUnreadCount`)**: Computed dynamically based on items where `read === false`.

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
| `400 Bad Request` | `Validation failed` | Returned if `user_address` is not a valid Starknet address, or `limit` is outside `1`–`50`. |

---

## Out of Scope Edge Cases

- **Persistent Preference Database Storage**: Custom per-user preference overrides in DB tables are out of scope for this route.
- **Push Notification Transport**: Delivery via Web Push, APNs, or email webhooks is managed out-of-band.
- **Server-side read state**: Marking notifications as read is not persisted; `read` is always `false`.

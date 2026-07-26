# User Notifications API (`/notifications/*`)

The notifications endpoint aggregates key on-chain activities (payments, agreement status transitions, escrow state changes, disputes) for a specified Starknet user address.

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
- **Unread Count (`calculateUnreadCount`)**: Computed dynamically based on items where `read === false`, ignoring duplicates by ID.

### `PATCH /api/v1/notifications/:user_address/preferences`

Updates a user's notification preferences. This endpoint is idempotent and validates the input using the `NotificationPreferences` contract. Only provided keys are updated (partial update), and applying the same partial preferences repeatedly yields the same result.

#### Request Body
```json
{
  "payments": false,
  "escrow": true
}
```

#### Success Response (`200 OK`)
```json
{
  "preferences": {
    "payments": false,
    "agreements": true,
    "escrow": true,
    "disputes": true
  }
}
```

### `GET /api/v1/notifications/:user_address/unread-count`

Returns the total unread count for a user idempotently.

#### Success Response (`200 OK`)
```json
{
  "unreadCount": 0
}
```


---

## Error Handling

| Status | Error Message | Description |
| :--- | :--- | :--- |
| `400 Bad Request` | `Validation failed` | Returned if `user_address` is not a valid Starknet address, or `limit` is outside `1`–`50`. |

---

## Out of Scope Edge Cases

- **Persistent Preference Database Storage**: Custom per-user preference overrides in DB tables are out of scope for this route.
- **Push Notification Transport**: Delivery via Web Push, APNs, or email webhooks is managed out-of-band.

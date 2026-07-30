# Notifications route — inline reference

> **Full documentation:** `docs/routes/notifications.md`

## Implemented endpoints

### `GET /api/v1/notifications/:user_address`

Returns a paginated feed of payments, agreement events, and escrow events for
the supplied Starknet address.  Response shape:

```json
{
  "notifications": [...],
  "total":         0,
  "unreadCount":   0,
  "limit":         10,
  "offset":        0,
  "hasMore":       false
}
```

- Default page size: **10** (`NOTIFICATIONS_DEFAULT_LIMIT`)
- Maximum page size: **50** (`NOTIFICATIONS_MAX_LIMIT`); out-of-range values
  return **400**.
- `read` is always `false` on every item — server-side read state is not yet
  persisted.
- `unreadCount` always equals `total` in the current implementation.
- The unread-count helper only counts explicit `read: false` values; missing
  or malformed `read` fields are ignored instead of being treated as unread.

## Not implemented

The following endpoints do **not** exist in this route and must not be added
without a separate design review:

- `GET /api/v1/notifications/:user_address/unread-count` — use the
  `unreadCount` field from the main response instead.
- `PATCH /api/v1/notifications/:user_address/preferences` — no preference
  persistence exists; `getDefaultNotificationPreferences()` returns the
  read-only default shape.

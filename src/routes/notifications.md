# Notifications API

## GET /api/v1/notifications/:user_address
Returns a list of notifications (payments, agreement events, and escrow events).
- **Hardening**: The output is validated against a strict schema. Any malformed database records are caught at runtime to prevent broken JSON responses.

## GET /api/v1/notifications/:user_address/unread-count
Returns the count of unread notifications.
- **Guarantee**: The `count` is always an integer `>= 0`.
- **Response**: `{ "count": number }`

## PATCH /api/v1/notifications/:user_address/preferences
Updates notification settings.
- **Strict Validation**: Only `email`, `push`, and `marketing` (booleans) are accepted. 
- **Error Handling**: Providing unknown keys or invalid types results in a `400 Validation failed` error.

# Notifications API

## GET /api/v1/notifications/:user_address/unread-count
Returns the count of unread notifications.
- **Guarantee**: The `count` is always an integer >= 0.

## PATCH /api/v1/notifications/:user_address/preferences
Updates notification settings.
- **Strict Validation**: Only `email`, `push`, and `marketing` (booleans) are accepted. 
- **Error Handling**: Providing unknown keys results in a 400 Validation failed error.
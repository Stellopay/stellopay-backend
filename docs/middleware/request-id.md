# Request-ID Middleware

Source: [`src/middleware/request-id.ts`](../../src/middleware/request-id.ts)

## Overview

The `requestIdMiddleware` correlation middleware reads inbound `X-Request-Id` headers sent by clients, load balancers, or API gateways, validates and sanitises the values, and propagates the correlation ID across logger context (`AsyncLocalStorage`), downstream Express `res.locals`, and response headers.

---

## Behavior & Contract

1. **Inbound Header Reuse**: If a valid `X-Request-Id` header is present in the request, it is reused as the correlation ID.
2. **Fallback Generation**: If the header is absent or invalid (empty, overlong, or containing non-printable characters), a fresh UUID v4 is server-generated via `crypto.randomUUID()`.
3. **Response Header Echo**: The resolved request ID is always returned in the `X-Request-Id` response header.
4. **Context Propagation**: The ID is attached to `res.locals.requestId` and set as the store in `requestIdContext` (`AsyncLocalStorage`) so log messages carry the correlation ID automatically.

---

## Sanitisation & Security Limits

To prevent log injection, header smuggling, and memory consumption attacks:

- **Length Limit**: Client-supplied IDs are capped at `MAX_REQUEST_ID_LENGTH` (128 characters).
- **Character Whitelist**: Only printable ASCII characters (`0x20`–`0x7E`) are permitted. Control characters, carriage returns (`\r`), and newlines (`\n`) are rejected.
- **Silent Replacement**: Invalid client IDs are replaced with a server-generated UUID without exposing internal errors to the client.

---

## Exports

| Export | Type | Description |
| --- | --- | --- |
| `requestIdMiddleware` | `RequestHandler` | Express middleware function for request ID correlation. |
| `MAX_REQUEST_ID_LENGTH` | `number` | Maximum allowed length for inbound request IDs (`128`). |
| `sanitiseClientId(raw)` | `function` | Sanitises raw string input; returns `string` or `null`. |

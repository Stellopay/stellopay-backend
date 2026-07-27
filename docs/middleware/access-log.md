# Access-log middleware

Source: [`src/middleware/access-log.ts`](../../src/middleware/access-log.ts)

## Overview

Every HTTP request (except `/health` and `/ready`) produces a single structured
log line with the method, sanitised path, response status, duration, and a
correlation ID. The middleware is mounted early in the Express pipeline so all
downstream handlers and errors are covered.

---

## Public API

### `accessLogMiddleware(req, res, next)`

Express middleware function. No configuration is needed — the middleware reads
`env.LOG_FORMAT` and `env.LOG_LEVEL` from the application config at runtime.

```ts
import { accessLogMiddleware } from "./middleware/access-log.js";

app.use(accessLogMiddleware);
```

**Prerequisite:** `requestIdMiddleware` should be mounted first so
`res.locals.requestId` is available. When mounted standalone (without the
request-ID middleware), the `request_id` field falls back to `"unknown"`.

---

## Log entry contract

Every log entry has the following shape:

```json
{
  "timestamp": "2026-07-27T12:34:56.789Z",
  "level": "info",
  "method": "GET",
  "path": "/api/v1/transactions",
  "status": 200,
  "duration_ms": 12.34,
  "request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Default fields

| Field | Type | Always present | Description |
|---|---|---|---|
| `timestamp` | `string` | yes | ISO 8601 UTC timestamp of the response |
| `level` | `string` | yes | Always `"info"` |
| `method` | `string` | yes | HTTP method, sanitised and truncated to 16 chars |
| `path` | `string` | yes | `req.originalUrl` or `req.path`, sanitised and truncated to 2048 chars |
| `status` | `number` | yes | HTTP response status code |
| `duration_ms` | `number` | yes | Response time in milliseconds, rounded to 2 decimal places |
| `request_id` | `string` | yes | Correlation ID from `res.locals.requestId`, or `"unknown"` |

### Debug-only field: `redacted_headers`

When `LOG_LEVEL` is set to `debug` or `trace`, a `redacted_headers` object is
included in the log entry. This mirrors the request headers with all sensitive
values replaced by `"[REDACTED]"`.

**Sensitive headers** (always redacted):

- `authorization`
- `cookie`
- `set-cookie`
- `x-api-key`
- `proxy-authorization`
- `x-auth-token`
- `x-csrf-token`

All other header values pass through unchanged.

```json
{
  "redacted_headers": {
    "authorization": "[REDACTED]",
    "x-api-key": "[REDACTED]",
    "accept": "application/json",
    "user-agent": "curl/8.0"
  }
}
```

At the default `LOG_LEVEL` (`info`) the `redacted_headers` field is **absent**
from the log entry.

---

## Security guarantees

### No PII in default fields

The log entry never contains request bodies, query strings, or raw headers by
default. The `redacted_headers` field is only present at `debug`/`trace` log
level, and every known sensitive header is replaced with `"[REDACTED]"`.

### Log-injection prevention

Every string field (method, path, URL) is passed through `sanitiseForLog`
which:

- Strips all ASCII control characters (0x00–0x1F) except TAB (0x09), plus DEL
  (0x7F). This removes injected newlines (`\n`), carriage returns (`\r`), and
  other control characters that could forge fake log lines.
- Replaces any remaining Unicode control characters with a safe `<\x??>`
  placeholder.

### Length limits

| Field | Maximum length | Behaviour when exceeded |
|---|---|---|
| `method` | 16 characters | Truncated with no suffix |
| `path` / URL | 2048 characters | Truncated and appended with `"..."` |

These limits prevent unbounded log entries from extremely long or pathological
input.

### Health-check exemption

Requests to `/health` and `/ready` are skipped immediately and never produce a
log line. This keeps health-monitoring noise out of the access logs.

---

## Output format

Controlled by `env.LOG_FORMAT`:

| Value | Output |
|---|---|
| `"json"` (default) | `console.info(JSON.stringify(logEntry))` — one JSON object per line |
| any other value | Human-readable format: `[timestamp] INFO method path status duration_msms [request_id]` |

---

## Caller expectations

- The middleware must be mounted **before** any route handlers so it can
  observe every response via the `res.on("finish")` event.
- `requestIdMiddleware` must be mounted **before** `accessLogMiddleware` for
  correlation IDs to work. When mounted standalone, `request_id` falls back to
  `"unknown"`.
- The middleware does **not** catch errors; it delegates to `next()` and lets
  Express error handlers process them.

### Example: Correct mounting order in `src/index.ts`

```ts
app.use(requestIdMiddleware);       // 1. Set up correlation IDs
app.use(accessLogMiddleware);        // 2. Log every request
app.use(helmet());                   // 3. Security headers
app.use(cors());                     // 4. CORS
app.use("/api/", globalLimiter);     // 5. Rate limiting
app.use("/api/v1", routes);          // 6. Route handlers
```

---

## Edge cases

### Request-ID middleware not mounted

When `accessLogMiddleware` is used standalone, `res.locals.requestId` is
`undefined` and the `request_id` field in the log entry is `"unknown"`.

### Extremely long path / URL

The path is truncated to 2048 characters. The suffix `"..."` is appended when
truncation occurs so operators can distinguish a truncated value from a
naturally bounded one.

### Path with control characters

Control characters (newlines, carriage returns, etc.) are silently stripped
from the logged path. The remaining printable characters are logged as a
single line, preventing an attacker from forging fake log entries via a
crafted URL.

### Query strings in the path

`req.originalUrl` preserves the query string, so `/path?foo=bar` is logged as
`/path?foo=bar`. The query string is **not** redacted (it is not PII by
default), but it is sanitised — all control characters are stripped.

---

## Out of scope

- **Request body logging** — bodies are never logged by this middleware.
  Downstream handlers may log their own payloads as needed.
- **Per-route log level overrides** — the log level is global (`env.LOG_LEVEL`).
  Per-route tuning is not implemented.
- **Custom redaction patterns** — the sensitive-header list is hardcoded.
  For custom patterns, extend `SENSITIVE_HEADERS` in the source file.
- **Log shipping / transport** — this middleware only writes to `console.info`.
  Log shipping (file, stdout forwarding, external aggregator) is handled by the
  runtime environment.

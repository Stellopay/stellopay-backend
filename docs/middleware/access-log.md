# Access-log middleware

Source: [`src/middleware/access-log.ts`](../../src/middleware/access-log.ts)  
Tests: [`src/middleware/access-log.test.ts`](../../src/middleware/access-log.test.ts)

---

## Overview

`accessLogMiddleware` emits **exactly one** structured log line per request
after the response finishes. It records the HTTP method, sanitised path,
status code, duration, and the correlation ID from `requestIdMiddleware`.
Bodies, headers, and auth material are **never** logged.

---

## Public API

### `accessLogMiddleware`

Standard Express middleware. Mount it after `requestIdMiddleware`:

```ts
import { requestIdMiddleware } from "./middleware/request-id.js";
import { accessLogMiddleware } from "./middleware/access-log.js";

app.use(requestIdMiddleware);  // must come first
app.use(accessLogMiddleware);
```

Works without `requestIdMiddleware` too — falls back to `crypto.randomUUID()`
so every log line always carries a valid correlation ID.

---

### `redactSensitiveParams(rawUrl)`

Exported pure helper that strips sensitive query-parameter values before the
URL is written to the log.

```ts
import { redactSensitiveParams } from "./middleware/access-log.js";

redactSensitiveParams("/api/v1/balance?address=0xDEAD&page=1");
// → "/api/v1/balance?address=%5Bredacted%5D&page=1"
```

- Parameters whose names match the redaction list (case-insensitive) have their
  values replaced with the exported `REDACTED_VALUE` constant (`"[redacted]"`).
- All other parameters pass through unchanged.
- Malformed URLs that cannot be parsed return the path portion only — the
  function **never throws** and **never leaks data**.
- The function is **pure and stateless**: the same input always produces the
  same output. It processes one URL per call with no internal buffer or cache.

### `REDACTED_VALUE`

The string written into the log for redacted param values. Exported so tests
and any downstream code can assert against the same constant rather than
hard-coding the string.

```ts
import { REDACTED_VALUE } from "./middleware/access-log.js";
// REDACTED_VALUE === "[redacted]"
```

---

## Redacted query-parameter names

| Name |
|---|
| `token`, `access_token` |
| `auth`, `authorization` |
| `secret`, `password` |
| `api_key`, `apikey`, `key` |
| `signature`, `sig` |
| `private_key` |
| `wallet`, `address`, `account` |

To add a name: extend `REDACTED_PARAM_NAMES` in `access-log.ts` and add a
test case in `access-log.test.ts`.

---

## Log-entry shape

```ts
interface AccessLogEntry {
  timestamp: string;   // ISO-8601
  level: "info";
  method: string;      // "GET", "POST", …
  path: string;        // req.originalUrl with sensitive params redacted
  status: number;      // HTTP status code
  duration_ms: number; // wall-clock ms from middleware mount to finish (2 dp)
  request_id: string;  // correlation ID or a fresh UUID fallback
}
```

---

## Batching / pagination contract

The middleware registers **one** `finish` listener per request. There is
**no internal buffer, queue, or batch accumulation**. Each HTTP request
produces exactly one `AccessLogEntry` when the response finishes. Concurrent
requests each get their own independent listener and their own log line — they
do not interfere with each other.

Pagination-related query parameters (`page`, `limit`, `offset`, etc.) are
**never redacted**; only the names in the redaction list above are replaced.

---

## Log formats

Controlled by `LOG_FORMAT` env var (default `"json"`).

**json**
```
{"timestamp":"…","level":"info","method":"GET","path":"/api/v1/users","status":200,"duration_ms":4.72,"request_id":"…"}
```

**text** (any value other than `"json"`)
```
[2025-06-01T12:00:00.000Z] INFO GET /api/v1/users 200 4.72ms [<request_id>]
```

---

## Reliability contract

| Concern | Behaviour |
|---|---|
| Missing `requestIdMiddleware` | Falls back to `crypto.randomUUID()` — never emits `"unknown"` |
| Error inside `finish` handler | Caught, written to `console.error("[access-log] failed to emit log entry …")`, never re-thrown |
| Malformed request URL | `redactSensitiveParams` returns the path portion — never throws |
| `/health` requests | Always skipped — no log noise from liveness probes |
| Multiple sequential requests | Each produces exactly one log line — no batching |
| Concurrent requests | Each gets an independent `finish` listener — no cross-request interference |

---

## Out of scope

- **Response / request body logging** — never included; increases memory
  pressure and PII risk.
- **Header logging** — headers can carry credentials; none are ever written.
- **Per-route suppression** beyond `/health` — treat as a separate concern.
- **Log sampling / rate-limiting** — out of scope for this middleware layer.
- **Shared-store rate-limiting for the logger** — handled at the infrastructure
  layer (e.g. log aggregator), not in this middleware.

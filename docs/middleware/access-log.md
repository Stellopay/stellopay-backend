# Access-log middleware

Source: [`src/middleware/access-log.ts`](../../src/middleware/access-log.ts)

## Overview

`accessLogMiddleware` emits one structured log line per request after the
response is sent. It records the HTTP method, sanitised path, status code,
duration, and the correlation ID from `requestIdMiddleware`. Bodies, headers,
and auth material are never logged.

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

Exported helper that strips sensitive query-parameter values before the URL
is written to the log.

```ts
import { redactSensitiveParams } from "./middleware/access-log.js";

redactSensitiveParams("/api/v1/balance?address=0xDEAD&page=1");
// → "/api/v1/balance?address=%5Bredacted%5D&page=1"
```

Parameters whose names match the redaction list (case-insensitive) have their
values replaced with `[redacted]`. All other parameters pass through unchanged.
Malformed URLs that cannot be parsed return the path portion only — the
function never throws and never leaks data.

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

---

## Compatibility guarantees

Each guarantee is pinned by a test case in the `"compatibility guarantees"`
block of `src/middleware/access-log.test.ts`. Changes that violate any of
these guarantees must be treated as breaking.

### Export surface

1. `accessLogMiddleware` is an Express middleware function (signature
   `(req, res, next) => void`).
2. `redactSensitiveParams` is exported and accepts a `string`, returning a
   `string` — it never throws.
3. `AccessLogEntry` is an exported TypeScript interface with exactly six
   fields: `timestamp`, `level`, `method`, `path`, `status`, `duration_ms`,
   `request_id`.

### Middleware behaviour

4. Requests to `/health` are silently skipped — `next()` is called without
   registering a `finish` listener and without emitting any log line.
5. Non-`/health` requests always register a `res.on("finish", …)` listener
   and emit exactly one log line when the response ends.
6. The correlation ID is captured at middleware-entry time from
   `res.locals.requestId`. It is NOT re-read inside the `finish` handler —
   a single snapshot avoids redundant property access and ensures the same
   ID appears in every log line for a given request.
7. When `res.locals.requestId` is absent or empty, the fallback is
   `crypto.randomUUID()` — the log line never contains `"unknown"` or an
   empty string for `request_id`.

### Redaction (`redactSensitiveParams`)

8. The redaction list is the 15 hardcoded names in `REDACTED_PARAM_NAMES`:
   `token`, `access_token`, `auth`, `authorization`, `secret`, `password`,
   `api_key`, `apikey`, `key`, `signature`, `sig`, `private_key`, `wallet`,
   `address`, `account`.
9. Matching is case-insensitive.
10. Redacted values are replaced with the literal string `[redacted]`
    (lowercase), which appears URI-encoded as `%5Bredacted%5D` in the
    output query string.
11. Non-sensitive params pass through with their values unchanged.
12. URLs with no query string are returned as-is (fast path — no parsing).
13. Malformed URLs that cannot be parsed never throw; the function returns
    only the path portion (everything before `?`).

### Error isolation

14. All logic inside the `finish` listener is wrapped in `try/catch`.
15. A caught error is written to `console.error` with the prefix
    `"[access-log] failed to emit log entry"` and never re-thrown.
16. A logging failure does not affect the HTTP response — the status code,
    headers, and body are already sent before the `finish` event fires.

### Log formats

17. When `LOG_FORMAT` is `"json"` (default), the log line is
    `JSON.stringify(entry)` — one line of valid JSON.
18. When `LOG_FORMAT` is anything other than `"json"`, the log line is the
    human-readable template
    `[<timestamp>] INFO <method> <path> <status> <duration_ms>ms [<request_id>]`.
19. `duration_ms` is rounded to 2 decimal places.

### Performance (no repeated work)

20. `requestId` is read from `res.locals` exactly once per request, at
    middleware-entry time. The `finish` handler reuses the captured value
    without re-reading `res.locals`.
21. `process.hrtime.bigint()` is called exactly twice per logged request:
    once to capture the start time and once inside `finish` to compute
    duration. No redundant time-snapshot calls.
22. `redactSensitiveParams` is called exactly once per logged request,
    inside the `finish` handler. This is structurally enforced — there is a
    single call site and a single `finish` handler per request (no direct
    test pins this because the call is a lexical binding inside the module,
    but the single-call-site layout is verifiable in code review).
    inside the `finish` handler.

### What counts as a breaking change

- Removing or renaming `accessLogMiddleware`, `redactSensitiveParams`, or
  `AccessLogEntry`.
- Changing the `AccessLogEntry` field names, types, or cardinality (adding a
  field is a minor addition; removing or renaming one is breaking).
- Removing a name from `REDACTED_PARAM_NAMES` so a previously-redacted param
  leaks into logs.
- Changing the redaction replacement string so log-based alerting or dashboards
  that match on `[redacted]` break.
- Skipping `/health` via a different mechanism (e.g. a configurable path
  list) — the hardcoded `/health` skip is part of the contract.
- Re-reading `res.locals.requestId` inside `finish` or calling
  `process.hrtime` more times than documented
  above — callers and operators rely on the documented performance profile.
- Logging request or response bodies, headers (including `Authorization`),
  or any field not defined in `AccessLogEntry`.

---

## Out of scope

- **Response / request body logging** — never included; increases memory
  pressure and PII risk.
- **Header logging** — headers can carry credentials; none are ever written.
- **Per-route suppression** beyond `/health` — treat as a separate concern.
- **Log sampling / rate-limiting** — out of scope for this middleware layer.

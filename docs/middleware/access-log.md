# Access-log middleware

Source: [`src/middleware/access-log.ts`](../../src/middleware/access-log.ts)

## Overview

`accessLogMiddleware` emits one structured log line per request after the
response is sent. It records the HTTP method, sanitised path, status code,
duration, correlation ID, and optional `content-length`. Bodies, headers,
and auth material are never logged.

The middleware also maintains in-memory request metrics that can be consumed
for health/observability endpoints.

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
values replaced with `[redacted]` (URL-encoded as `%5Bredacted%5D`). All other
parameters pass through unchanged. Malformed URLs that cannot be parsed return
the path portion only — the function never throws and never leaks data.

---

### `getMetrics()`

Return a snapshot of the in-memory metrics counters:

```ts
import { getMetrics } from "./middleware/access-log.js";

const metrics = getMetrics();
console.log(metrics.totalRequests);       // total non-/health requests
console.log(metrics.requestsByStatus);    // { 200: 5, 404: 1, … }
console.log(metrics.requestsByPath);      // { "/api/v1/users": 3, … }
console.log(metrics.totalDurationMs);     // cumulative wall-clock ms
```

### `resetMetrics()`

Reset all counters to zero. Intended for use in tests.

```ts
import { resetMetrics } from "./middleware/access-log.js";
resetMetrics();
```

---

### `seenRequestIds`

Exported singleton (`SeenRequestIds` instance) that tracks recently-seen
correlation IDs for idempotency. Exposed for diagnostics and test resets.

```ts
import { seenRequestIds } from "./middleware/access-log.js";

seenRequestIds.isNew("req-abc-123");  // true  (first sighting)
seenRequestIds.isNew("req-abc-123");  // false (duplicate within TTL)
seenRequestIds.size;                  // 1
seenRequestIds.reset();               // clears all tracked IDs
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
  timestamp: string;       // ISO-8601
  level: "info";
  method: string;          // "GET", "POST", …
  path: string;            // req.originalUrl with sensitive params redacted
  status: number;          // HTTP status code
  duration_ms: number;     // wall-clock ms from middleware mount to finish (2 dp)
  request_id: string;      // correlation ID or a fresh UUID fallback
  content_length?: number; // response Content-Length header if set
}
```

---

## Log formats

Controlled by `LOG_FORMAT` env var (default `"json"`).

**json**
```
{"timestamp":"…","level":"info","method":"GET","path":"/api/v1/users","status":200,"duration_ms":4.72,"request_id":"…","content_length":42}
```

**text** (any value other than `"json"`)
```
[2025-06-01T12:00:00.000Z] INFO GET /api/v1/users 200 4.72ms [<request_id>]
```

---

## Idempotency / duplicate-request protection

Repeated delivery or retrying the same request (same correlation ID) must
not produce duplicate log lines. The middleware uses an in-process,
TTL-based deduplication set (`SeenRequestIds`) to enforce this:

| Concern | Behaviour |
|---|---|
| First sighting of an ID | Logged normally; ID recorded |
| Same ID seen again within TTL (60 s) | Log line suppressed entirely |
| ID seen after TTL expiry | Treated as new — logged again |
| Memory bound | Capped at 10 000 entries; oldest half evicted when full |
| Expired entries | Lazily evicted on each insertion |
| Process restart | Set is cleared — duplicates after restart are harmless (new log stream) |
| No `requestIdMiddleware` mounted | Each request gets a fresh `crypto.randomUUID()` — always unique, so idempotency is never triggered unintentionally |

### Design rationale

- **Best-effort**: the dedup set is process-local and does not survive
  restarts. It prevents the most common cause of duplicate log lines — a
  client retrying the same request with the same `X-Request-Id` within a
  few seconds — without adding a shared persistence layer.
- **Bounded memory**: the 10 000-entry cap and lazy TTL eviction keep the
  footprint negligible even under high throughput.
- **Not a durability guarantee**: cross-instance deduplication and
  long-term idempotency archives are the responsibility of the log
  aggregation layer (e.g. OpenSearch, Loki).

---

## Reliability contract

| Concern | Behaviour |
|---|---|
| Missing `requestIdMiddleware` | Falls back to `crypto.randomUUID()` — never emits `"unknown"` |
| Duplicate request ID within TTL | Suppressed — at most one log line |
| Error inside `finish` handler | Caught, written to `console.error("[access-log] failed to emit log entry …")`, never re-thrown |
| Malformed request URL | `redactSensitiveParams` returns the path portion — never throws |
| `/health` requests | Always skipped — no log noise from liveness probes |

---

## Metrics contract

| Field | Description |
|---|---|
| `totalRequests` | Count of all non-/health requests processed |
| `requestsByStatus` | Map of HTTP status code → count |
| `requestsByPath` | Map of route path → count |
| `totalDurationMs` | Cumulative wall-clock duration of all requests |

Metrics are updated atomically inside the `finish` handler. `/health` requests
are excluded from all counters.

---

## Out of scope

- **Response / request body logging** — never included; increases memory
  pressure and PII risk.
- **Header logging** — headers can carry credentials; none are ever written.
- **Per-route suppression** beyond `/health` — treat as a separate concern.
- **Log sampling / rate-limiting** — out of scope for this middleware layer.
- **Persistent metrics export** (e.g. Prometheus) — `getMetrics()` provides an
  in-memory snapshot; a separate adapter can scrape it for external systems.

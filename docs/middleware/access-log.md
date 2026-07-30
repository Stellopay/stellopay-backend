# Access Log Middleware

The `accessLogMiddleware` is a core Express middleware in `src/middleware/access-log.ts` responsible for generating a single, structured log entry for every HTTP request.

## Security boundary

The middleware enforces two explicit security gates:

1. **Path-skip list** (`/health`, `/ready`) — requests to these paths are excluded from logging *before* any correlation ID is read or any timer is started. This is the sole authorization gate; any future endpoint that must never be logged must be added here.

2. **Correlation-ID validation** (`validateCorrelationId`) — only UUID v4-formatted strings from `res.locals.requestId` are trusted. Non-UUID values (including overlong strings that could cause memory pressure) are silently replaced with a freshly-generated `crypto.randomUUID()`. This prevents log-line forgery, cache poisoning, and memory-exhaustion attacks through the `x-request-id` header.

## Contract

- **Idempotency & Correlation IDs**: Logs are deduplicated based on correlation ID (typically `res.locals.requestId`). The same request ID is only logged once within a 60-second window. This ensures that accidental duplicate calls or retries passing the same ID only produce at most one log line. A random fallback ID (`crypto.randomUUID()`) is generated if no correlation ID is found, so every log line always carries a valid, non-empty request ID.

- **PII Redaction**: Sensitive query parameters such as tokens, API keys, passwords, wallet addresses, and signatures are safely redacted. The redaction logic guarantees that malformed URLs never throw errors or leak sensitive data — on parse failure, only the path portion is returned.

- **Log Emission**: Emits exactly one log line per request on the `res.finish` event. Health check endpoints (`/health`, `/ready`) are explicitly excluded to reduce noise from liveness probes.

- **Header Security**: The middleware never logs request/response bodies, `Authorization` headers, `Cookie` headers, or any other HTTP header. Only the whitelisted fields in `AccessLogEntry` are emitted:
  - `timestamp` — ISO 8601 timestamp
  - `level` — always `"info"`
  - `method` — HTTP method (`GET`, `POST`, etc.)
  - `path` — URL with sensitive query-parameter values redacted
  - `status` — HTTP status code
  - `duration_ms` — wall-clock duration in milliseconds
  - `request_id` — correlation ID or UUID fallback
  - `content_length` — response body length (when available)

- **Security Boundary**: The following guarantees are enforced:
  1. **No header logging** — `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, and `X-Auth-Token` headers are never written to the log.
  2. **No body logging** — request and response bodies are never read or logged.
  3. **PII redaction** — sensitive query-parameter values are redacted via `redactSensitiveParams`.
  4. **Safe fallback** — `redactSensitiveParams` never throws and returns only the path portion when URL parsing fails.
  5. **Graceful failure** — a `try/catch` around the finish handler ensures logging failures never crash the process.
  6. **Audit trail** — every log line carries a valid, traceable `request_id`.

- **Resilience**: The middleware catches any errors during the log-writing phase so they never interfere with the HTTP response cycle. Errors are reported via `console.error`.

## Usage

```typescript
import { accessLogMiddleware } from "./middleware/access-log.js";
app.use(accessLogMiddleware);
```

The middleware formats the logs as either machine-parseable JSON or human-readable text depending on the `LOG_FORMAT` environment variable.

## Log Formats

### JSON format (default)
When `LOG_FORMAT=json`, each log entry is written as a single `JSON.stringify` line:

```json
{"timestamp":"2026-07-28T12:00:00.000Z","level":"info","method":"GET","path":"/api/users?page=1","status":200,"duration_ms":42.12,"request_id":"abc-123","content_length":256}
```

### Text format
When `LOG_FORMAT` is anything other than `"json"`, logs are human-readable:

```
[2026-07-28T12:00:00.000Z] INFO GET /api/users?page=1 200 42.12ms [abc-123]
```

## Security Considerations

- The redaction set includes: `token`, `access_token`, `auth`, `authorization`, `secret`, `password`, `api_key`, `apikey`, `key`, `signature`, `sig`, `private_key`, `wallet`, `address`, `account`. All matches are case-insensitive.
- Malformed URLs are handled safely — only the path portion is logged when parsing fails.
- The deduplication cache prevents a single request ID from being logged more than once in a 60-second window, reducing log noise from retries.

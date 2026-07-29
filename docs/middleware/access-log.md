# Access Log Middleware

The `accessLogMiddleware` is a core Express middleware in `src/middleware/access-log.ts` responsible for generating a single, structured log entry for every HTTP request.

## Security boundary

The middleware enforces two explicit security gates:

1. **Path-skip list** (`/health`, `/ready`) — requests to these paths are excluded from logging *before* any correlation ID is read or any timer is started. This is the sole authorization gate; any future endpoint that must never be logged must be added here.

2. **Correlation-ID validation** (`validateCorrelationId`) — only UUID v4-formatted strings from `res.locals.requestId` are trusted. Non-UUID values (including overlong strings that could cause memory pressure) are silently replaced with a freshly-generated `crypto.randomUUID()`. This prevents log-line forgery, cache poisoning, and memory-exhaustion attacks through the `x-request-id` header.

## Contract

- **Idempotency & Correlation IDs**: Logs are deduplicated based on validated correlation IDs (see `validateCorrelationId`). The same request ID is only logged once within a 60-second window. The dedup cache is bounded at `MAX_CACHE_SIZE` (10,000 entries) — once full, new IDs are still logged but not inserted, preventing memory exhaustion from a flood of unique IDs. A random fallback ID is generated if no valid correlation ID is found.
- **PII Redaction**: Sensitive query parameters such as tokens, API keys, passwords, and wallet addresses are safely redacted. The logic guarantees that malformed URLs never throw errors or leak sensitive data.
- **Log Emission**: Emits exactly one log line per request on the `res.finish` event. Health check endpoints (`/health`, `/ready`) are explicitly excluded to reduce noise.
- **Resilience**: The middleware catches any errors during the log-writing phase so they never interfere with the HTTP response cycle.

## Usage

```typescript
import { accessLogMiddleware } from "./middleware/access-log.js";
app.use(accessLogMiddleware);
```

The middleware formats the logs as either machine-parseable JSON or human-readable text depending on the `LOG_FORMAT` environment variable.

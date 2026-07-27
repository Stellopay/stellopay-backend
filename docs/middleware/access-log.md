# Access Log Middleware

The `accessLogMiddleware` is a core Express middleware in `src/middleware/access-log.ts` responsible for generating a single, structured log entry for every HTTP request.

## Contract

- **Idempotency & Correlation IDs**: Logs are deduplicated based on correlation ID (typically `res.locals.requestId`). The same request ID is only logged once within a 60-second window. This ensures that accidental duplicate calls or retries passing the same ID only produce at most one log line. A random fallback ID is generated if no correlation ID is found.
- **PII Redaction**: Sensitive query parameters such as tokens, API keys, passwords, and wallet addresses are safely redacted. The logic guarantees that malformed URLs never throw errors or leak sensitive data.
- **Log Emission**: Emits exactly one log line per request on the `res.finish` event. Health check endpoints (`/health`) are explicitly excluded to reduce noise.
- **Resilience**: The middleware catches any errors during the log-writing phase so they never interfere with the HTTP response cycle.

## Usage

```typescript
import { accessLogMiddleware } from "./middleware/access-log.js";
app.use(accessLogMiddleware);
```

The middleware formats the logs as either machine-parseable JSON or human-readable text depending on the `LOG_FORMAT` environment variable.

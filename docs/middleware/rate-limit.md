# Rate‑Limit Middleware

This document describes the contract and behavior of the **rate‑limit** middleware located at `src/middleware/rate-limit.ts`.

## Headers
| Header | Purpose | Accepted Value |
|--------|---------|----------------|
| **Idempotency‑Key** (`Idempotency-Key`) | Allows request deduplication when the same client repeats an operation. | **Regex**: `^[A-Za-z0-9_-]{1,255}$` – alphanumerics, hyphen, underscore, length 1‑255. Any header not matching this pattern is ignored (treated as absent).
| **Retry‑After** | Indicates how many whole seconds the client should wait before retrying after a `429 Too Many Requests`. | Positive integer (minimum `1`). Added automatically on every throttled response.
| **X‑Idempotent‑Replayed** | Signals that the response is a replay of a prior request with the same Idempotency‑Key. | `"true"` when a cached replay occurs.

## Error Response (429)
```json
{ "error": "<message>" }
```
- `<message>` defaults to `"Too many requests, please try again later."` unless overridden via options or `RATE_LIMIT_<NAME>_MESSAGE` env var.

## Environment‑Variable Overrides
| Variable | Overrides | Example |
|----------|-----------|---------|
| `RATE_LIMIT_<NAME>_MAX` | `max` (allowed requests per window) | `RATE_LIMIT_GLOBAL_MAX=50` |
| `RATE_LIMIT_<NAME>_WINDOW_MS` | `windowMs` (window length in ms) | `RATE_LIMIT_STRICT_WINDOW_MS=120000` |
| `RATE_LIMIT_<NAME>_MESSAGE` | `message` (429 body) | `RATE_LIMIT_CONTACT_MESSAGE="Slow down"` |

`<NAME>` is the limiter name, upper‑cased with non‑alphanumerics replaced by `_`.

## Idempotency‑Key Validation
- The middleware extracts the header case‑insensitively.
- Keys must match the regex `^[A-Za-z0-9_-]{1,255}$`.
- Invalid, empty, or overly long keys are ignored, meaning the request is processed without deduplication.

## Retry‑After Calculation
`Retry‑After` is computed as `Math.max(1, Math.ceil(windowMs / 1000))` and is constant for the lifetime of a limiter.

## Distributed Store
- By default an in‑memory store is used (process‑local). For multi‑instance deployments provide a shared `store` (e.g., Redis via `rate-limit-redis`).
- Errors from the store are **fail‑open** (`passOnStoreError: true`).

## Usage Example
```ts
import { makeLimiter } from './middleware/rate-limit';

const apiLimiter = makeLimiter({
  name: 'api',
  windowMs: 60_000,
  max: 100,
  idempotent: true,
});

app.use('/api', apiLimiter);
```

---
*Generated on 2026‑07‑28.*

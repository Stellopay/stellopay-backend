# Rate‑Limit Middleware

This document describes the contract and behavior of the **rate‑limit** middleware located at `src/middleware/rate-limit.ts`.

## Backward-Compatible Contract

To ensure future changes do not break existing callers, the rate limit middleware adheres to an explicit compatibility contract. Any modifications to this middleware **must** preserve the following:

1. **Public API Surface**: The exported members (`makeLimiter`, `IDEMPOTENCY_KEY_HEADER`, `RETRY_AFTER_HEADER`, `X_IDEMPOTENT_REPLAYED_HEADER`) must remain available and backward-compatible.
2. **Error Response Shape**: Throttled requests (429) must consistently return a JSON body matching `{ "error": "<message>" }`. Existing callers and clients depend on this shape.
3. **Retry-After Header**: Throttled responses must always include the `Retry-After` header indicating the whole seconds remaining.
4. **Idempotency Headers**: Idempotency features must use the defined canonical header names (`Idempotency-Key` for request, `X-Idempotent-Replayed` for response).

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

## Batching or Pagination Contract
When exposing endpoints that accept batches of items or paginated requests, the rate limiter must scale appropriately to prevent a single request from performing unbounded work.

By default, the rate limiter consumes 1 token per request. For batching or pagination, you must define a `cost` function in the limiter options.

### How it works
The `cost` function evaluates the weight of the request (e.g., the number of items in a batch). The limiter enforces this weight by scaling the window's effective maximum requests inversely to the cost.

For example, if `max` is 100, and a request has a cost of 10, the effective limit for that request becomes `10` (since `100 / 10 = 10`). This guarantees that a client exclusively sending requests of cost `C` cannot process more than `max` total items in a window.

### Boundaries and Failures
1. **Cost Exceeds Max**: If a single request's cost is strictly greater than the limiter's `max`, it is immediately throttled (returns 429) without further processing. This guarantees oversized batches are rejected outright.
2. **Zero or Negative Cost**: If the cost function evaluates to zero or a negative value, the limiter defaults back to the base `max` (effectively treating the cost as 1).
3. **Mixed Traffic**: Because the underlying token bucket natively tracks requests rather than items, a client mixing high-cost and low-cost requests might exceed the exact item count slightly. This proportional-limit approach remains an approximation, but strictly bounds the maximum workload and remains safe for growth.

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

# Rate-limit middleware

Source: [`src/middleware/rate-limit.ts`](../../src/middleware/rate-limit.ts)

## Overview

All rate limiting is built through the `makeLimiter` factory. This keeps the
key generator, 429 response envelope, `Retry-After` header, and observability
hooks in one place so per-route tuning stays small and consistent.

---

## Public API

### `makeLimiter(options)`

Returns a configured Express `RateLimitRequestHandler`.

```ts
import { makeLimiter } from "./middleware/rate-limit.js";

const adminLimiter = makeLimiter({
  name: "admin",
  windowMs: 60_000,
  max: 20,
  message: "Too many admin requests.",
});
app.use("/api/v1/admin", adminLimiter);
```

**Options**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Identifier used in log output (e.g. `"global"`, `"strict"`) |
| `windowMs` | `number` | yes | Sliding window length in milliseconds |
| `max` | `number` | yes | Max requests per window per key |
| `message` | `string` | no | Body of the 429 `error` field. Defaults to `"Too many requests, please try again later."` |
| `skip` | `(req) => boolean` | no | Return `true` to bypass counting (e.g. health checks) |
| `store` | `Store` | no | Shared backing store for distributed deployments — see below |

---

### `keyByIp(req)`

The shared key generator used by every limiter. Returns `req.ip`, which
Express resolves from `X-Forwarded-For` when `trust proxy` is set. Falls back
to `"unknown"` and emits a `console.warn` when `req.ip` is undefined, making
proxy misconfiguration visible in logs.

---

### `retryAfterSeconds(windowMs)`

Converts a window length in milliseconds to the number of whole seconds to
put in the `Retry-After` header. Returns at least `1` to avoid sending
`Retry-After: 0`.

```ts
retryAfterSeconds(60_000)  // → 60
retryAfterSeconds(1_500)   // → 2  (ceiling)
retryAfterSeconds(500)     // → 1  (minimum)
```

---

## 429 response contract

When a client exceeds the limit, every limiter returns:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: <seconds>

{ "error": "<message>" }
```

- **`Retry-After`** — always present on 429 responses. Value is
  `ceil(windowMs / 1000)`, clamped to a minimum of `1`. Clients and
  intermediate infrastructure (CDNs, API gateways, SDK retry logic) can use
  this to back off without polling.
- **`error`** — matches the global API error envelope so clients can handle
  rate-limit errors with the same code path as other errors.

Standard (`RateLimit-*`) and legacy (`X-RateLimit-*`) headers are **off** on
all responses. `Retry-After` on 429 is the only rate-limit signal sent to
clients.

---

## Observability

When a limiter fires it logs:

```
[rate-limit] limit reached for limiter="<name>"
```

This is emitted at `warn` level via `console.warn` (permitted globally for
`src/**/*.ts`, unlike `no-console` rules that apply to `src/index.ts`). Pair
it with a log-based alert to detect abuse patterns or mis-tuned limits.

When `req.ip` cannot be resolved:

```
[rate-limit] req.ip is undefined — all unresolved clients share the 'unknown' bucket. Check your TRUST_PROXY setting.
```

---

## Store / distributed deployments

### Default: in-memory

The in-memory store (default when `store` is omitted) keeps counters in the
Node.js process heap.

**Implications:**
- Counts are **not shared** across replicas — each instance enforces its own
  window independently. The effective limit for a single client is
  `max × number_of_replicas` across a load-balanced fleet.
- Counters **reset on process restart**, briefly relaxing enforcement.

This is acceptable for single-instance deployments and development. In
production behind a load balancer, use a shared store.

### Shared store (Redis)

Pass a `store` to share counters across all replicas:

```ts
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const globalLimiter = makeLimiter({
  name: "global",
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  store: new RedisStore({ sendCommand: (...args) => redis.sendCommand(args) }),
});
```

### Fail-open on store errors

`makeLimiter` sets `passOnStoreError: true` explicitly, so when the backing
store throws (e.g. a Redis outage) the request is allowed through rather than
rejected. Without this, `express-rate-limit`'s own default
(`passOnStoreError: false`) propagates the error to Express's error handling
and fails **closed** — the opposite of the intended trade-off. Failing open is
the right choice for availability (a Redis outage should not take down the
API), but it means distributed enforcement silently degrades to no
enforcement while the store is unavailable. The error is logged via
`express-rate-limit`'s default logger (`console.error`). Monitor your store
health independently and alert on store errors or on the
`[rate-limit] limit reached` log line going silent during high traffic.

---

## Production limiters

Configured in `src/index.ts` from environment variables:

| Limiter | Routes | `windowMs` env var | `max` env var | Default window | Default max |
|---|---|---|---|---|---|
| `global` | `POST /api/*` (except `/health`) | `RATE_LIMIT_WINDOW_MS` | `RATE_LIMIT_MAX` | 15 min | 100 |
| `strict` | `/api/v1/auth`, `/api/v1/contact` | `RATE_LIMIT_STRICT_WINDOW_MS` | `RATE_LIMIT_STRICT_MAX` | 5 min | 10 |

---

## Out of scope

- **Per-user / authenticated rate limiting** — all current limiters key by IP.
  Keying by session or wallet address would require passing the auth context
  into `keyGenerator`; that is tracked separately.
- **Dynamic limit adjustment** — limits are fixed at process startup from env
  vars. Runtime reconfiguration (e.g. via feature flags) is not implemented.
- **Request cost weights** — all requests count as 1. Weighted counting
  (e.g. expensive queries count as 5) is not implemented.
- **Store-level retries/backoff** — `passOnStoreError: true` fails open on the
  *first* store error rather than retrying the operation. Adding retry logic
  belongs in the `Store` implementation (e.g. `rate-limit-redis`'s own client
  options), not in `makeLimiter`.

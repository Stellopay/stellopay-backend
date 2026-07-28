# Rate-Limit Middleware — Backward-Compatible Contract

> Source: `src/middleware/rate-limit.ts`  
> Tests:  `src/middleware/rate-limit.test.ts`

---

## Overview

All rate limiting in the app is built through a single factory: `makeLimiter()`.
This centralises key generation, the 429 response envelope, and header policy so
there is one place to tune per-route limits and one seam to swap the backing store.

---

## Exports

| Export | Type | Purpose |
|---|---|---|
| `makeLimiter(options)` | `(MakeLimiterOptions) => RateLimitRequestHandler` | Factory — builds a named limiter |
| `keyByIp(req)` | `(Request) => string` | Shared key generator |
| `DEFAULT_RATE_LIMIT_MESSAGE` | `string` | Canonical fallback 429 message |
| `MakeLimiterOptions` | interface | Options type for `makeLimiter` |

---

## `makeLimiter(options)`

### Options

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `name` | `string` | ✅ | — | Debug label; no runtime effect |
| `windowMs` | `number` | ✅ | — | Sliding window length in ms |
| `max` | `number` | ✅ | — | Max requests per window per key |
| `message` | `string` | ❌ | `DEFAULT_RATE_LIMIT_MESSAGE` | Text in 429 body |
| `skip` | `(req) => boolean` | ❌ | — | Return `true` to exempt a request |

### Frozen contracts (issue #338)

**429 response envelope**
```jsonc
{ "error": "<message>" }   // Content-Type: application/json
```
Shape is frozen — exactly one key (`error`). No extra fields are ever added.
`message` defaults to `DEFAULT_RATE_LIMIT_MESSAGE` when not supplied.

**Rate-limit headers**  
`standardHeaders: false` and `legacyHeaders: false` — neither `RateLimit-*`
nor `X-RateLimit-*` headers are emitted on any response (allowed or blocked).
This is intentional to avoid leaking internal quota state. Do not change
without a security review.

**Key generator**  
Always `keyByIp` — `req.ip` falling back to `"unknown"`. Honoured by Express
`trust proxy` setting. Never swapped per-limiter.

**Counter isolation**  
Each `makeLimiter()` call produces an independent in-memory store. Two limiters
with the same `name` do not share counters unless an explicit shared `store` is
wired (see distributed deployments below).

**skip predicate**  
When `skip(req) === true`, the request passes through unconditionally — no
counter increment, no 429. Skipped requests are completely transparent.

**Exact boundary**  
- Request #`max`: allowed (200 from upstream handler)  
- Request #`max + 1`: blocked (429)

---

## `keyByIp(req)`

```
keyByIp(req) → req.ip || "unknown"
```

- Returns `req.ip` when truthy.
- Returns `"unknown"` when `req.ip` is `undefined` or empty string.
- Two requests with different IPs are keyed independently — exhausting one IP
  never affects another.
- IPs differing by a single octet are treated as distinct keys.

---

## Distributed Deployments

The default store is **in-memory**, meaning:

- Counters are **not shared** across replicas — each instance enforces its own counts.
- Counters **reset on restart/redeploy**, briefly relaxing enforcement.

To share limits across instances, wire a shared store at the `store` seam inside
`makeLimiter`:

```ts
// Example — replace with your Redis client
import { RedisStore } from "rate-limit-redis";
// Pass `store: new RedisStore({ sendCommand })` to rateLimit(...)
```

This is intentionally the **only place** to make that change.

---

## Out of Scope (issue #338)

- Distributed shared-store implementation — the seam exists but wiring it is a
  separate infrastructure concern.
- Per-user or per-token rate limiting — current key is IP only.
- Dynamic limit adjustment at runtime.
- Rate-limit header emission — intentionally disabled; enabling requires a
  security review.

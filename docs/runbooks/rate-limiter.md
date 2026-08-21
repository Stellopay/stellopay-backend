# Runbook: Rate Limiter

**Owner:** Backend / Platform  
**Severity when triggered:** Low–Medium (legitimate traffic shed when misconfigured)

---

## Overview

The rate limiter (`src/middleware/rate-limit.ts`) enforces per-IP request
limits using `express-rate-limit` with a shared key generator.  Named
limiters protect different route groups:

| Limiter      | Scope                         |
| ------------ | ----------------------------- |
| `global`     | All routes not covered by a more specific limiter |
| `strict`     | Auth endpoints (`/auth/*`)    |
| `contact`    | Contact form (`/contact`)     |
| `analytics`  | Analytics routes              |

Each limiter uses an in-memory store by default; a shared Redis store is
available when `REDIS_URL` is set.

---

## Symptoms

| Symptom                                                         | Likely Cause                               |
| --------------------------------------------------------------- | ------------------------------------------ |
| `[rate-limit] limit reached for limiter="<name>"` in logs       | A client or IP exceeded its window limit   |
| HTTP 429 responses with `Retry-After` header                    | Normal rate enforcement                    |
| Spike in 429 responses across many IPs                          | Global limit too low for traffic volume    |
| `[rate-limit] req.ip is undefined` warning                      | `TRUST_PROXY` misconfigured — all clients share `"unknown"` bucket |
| Rate limiting not enforced after restart/redeploy               | Expected: in-memory store resets on restart |
| Legitimate traffic being throttled during Redis outage          | `passOnStoreError: true` fails open — enforcement silently degrades |
| `[rate-limit] limiter="..." has an absurdly high max` warning   | Config error — rate limit effectively disabled |

---

## Relevant Environment Variables

### Per-limiter defaults (set in `src/config.ts`)

| Variable                          | Default     | Limiter    | Description                 |
| --------------------------------- | ----------- | ---------- | --------------------------- |
| `RATE_LIMIT_WINDOW_MS`            | `900000`    | global     | Window: 15 min              |
| `RATE_LIMIT_MAX`                  | `100`       | global     | Max requests per window     |
| `RATE_LIMIT_STRICT_WINDOW_MS`     | `300000`    | strict     | Window: 5 min               |
| `RATE_LIMIT_STRICT_MAX`           | `10`        | strict     | Max requests per window     |
| `RATE_LIMIT_CONTACT_WINDOW_MS`    | `3600000`   | contact    | Window: 1 hour              |
| `RATE_LIMIT_CONTACT_MAX`          | `3`         | contact    | Max requests per window     |
| `RATE_LIMIT_ANALYTICS_WINDOW_MS`  | `900000`    | analytics  | Window: 15 min              |
| `RATE_LIMIT_ANALYTICS_MAX`        | `200`       | analytics  | Max requests per window     |

### Runtime overrides (per `makeLimiter`)

Any limiter can be overridden at runtime via the pattern
`RATE_LIMIT_<NAME>_<OPTION>`:

| Variable                            | Overrides    | Example                                   |
| ----------------------------------- | ------------ | ----------------------------------------- |
| `RATE_LIMIT_<NAME>_MAX`             | `max`        | `RATE_LIMIT_GLOBAL_MAX=50`                |
| `RATE_LIMIT_<NAME>_WINDOW_MS`       | `windowMs`   | `RATE_LIMIT_STRICT_WINDOW_MS=120000`      |
| `RATE_LIMIT_<NAME>_MESSAGE`         | `message`    | `RATE_LIMIT_CONTACT_MESSAGE="Slow down"`  |

`<NAME>` is the limiter name uppercased with non-alphanumeric characters
replaced by `_`.  These overrides are read once at construction time.

### Infrastructure

| Variable       | Description                                      |
| -------------- | ------------------------------------------------ |
| `REDIS_URL`    | Optional shared Redis for distributed counters   |
| `TRUST_PROXY`  | Express `trust proxy` setting (default: `"1"`)   |

---

## Diagnostics Endpoints to Check First

### 1. Application logs

Search for `[rate-limit]` prefixed log lines:

```
[rate-limit] limit reached for limiter="strict"
[rate-limit] req.ip is undefined — all unresolved clients share the 'unknown' bucket
[rate-limit] limiter="global" has an absurdly high max of 10000
```

### 2. `GET /api/v1/system/ready`

If Redis is configured and the readiness probe shows database issues,
check whether `passOnStoreError: true` is masking a Redis outage — rate
limits silently degrade to no enforcement.

### 3. Redis (if configured)

```bash
redis-cli -u "$REDIS_URL" PING
redis-cli -u "$REDIS_URL" DBSIZE
redis-cli -u "$REDIS_URL" --scan --pattern "rate_limit:*" | head -20
```

---

## Step-by-Step Response

### 1. Legitimate traffic being throttled

1. Identify which limiter is triggering from the `[rate-limit] limit reached`
   log line.
2. Check the config values for that limiter:
   ```bash
   # For the global limiter
   echo $RATE_LIMIT_MAX          # default: 100
   echo $RATE_LIMIT_WINDOW_MS    # default: 900000 (15 min)
   ```
3. If the limits are too low for current traffic patterns:
   - Increase `RATE_LIMIT_MAX` for the affected limiter.
   - Consider increasing `RATE_LIMIT_WINDOW_MS` to allow more requests over
     a longer period.
4. If a specific IP or service is being throttled (legitimate API consumer),
   consider adding a `skip` predicate for known IPs/ranges or using the
   `cost` function for weighted rate limiting.

### 2. All clients hitting rate limits immediately

This usually indicates the `"unknown"` bucket is shared:

1. Check for `req.ip is undefined` warnings.
2. Verify `TRUST_PROXY` matches your proxy/load-balancer configuration:
   - Single reverse proxy → `TRUST_PROXY=1`
   - Multiple proxies → set `TRUST_PROXY` to the number of trusted hops
   - No proxy → `TRUST_PROXY` should not be set (or set to `"0"`)
3. After fixing `TRUST_PROXY`, all clients will have individual rate-limit
   buckets again.

### 3. Redis outage (distributed mode)

When `REDIS_URL` is configured but Redis is down:

1. The `passOnStoreError: true` setting allows all requests through —
   rate limits are **not enforced**.
2. `express-rate-limit` logs store errors to `console.error`.  Configure
   alerting on these errors.
3. To restore enforcement:
   - Fix the Redis connection.
   - Or temporarily remove `REDIS_URL` to fall back to per-instance
     in-memory stores (limits scale with instance count).

### 4. Rate limits not effective enough

1. Verify the limiter is actually applied to the target route.
2. Check that the `max` value is not absurdly high (warning threshold:
   > 1000).
3. For the contact form, ensure `RATE_LIMIT_CONTACT_MAX` is not set above
   the intended limit (default: 3 per hour).
4. Consider deploying a shared Redis store if running multiple backend
   instances — per-instance in-memory stores multiply the effective limit
   by the number of instances.

---

## Idempotency-Key Deduplication

When a limiter is configured with `idempotent: true`, requests carrying an
`Idempotency-Key` header are deduplicated against the shared
`idempotency_keys` Postgres table (`src/middleware/idempotency-store.ts`).
Because the table is shared by every application process, the same key is
recognised across instances/replicas — a duplicate request is never
re-processed by a second process.

Contract:

- **Identity** — the deduplication scope is `limiter name + client IP + key`;
  requests without an `Idempotency-Key` header bypass idempotency entirely.
- **First request** — atomically claims the key (the `(route, key)` primary
  key decides the single winner under concurrency) and runs the downstream
  operation exactly once.
- **Identical retry** — replays the stored response (status code + JSON body)
  and sets `X-Idempotent-Replayed: true`. Replays do not count against the
  rate limit.
- **Different body, same key** — deterministic `409 Conflict`
  (`"Idempotency key already used with a different request body"`).
- **In-flight duplicate** — deterministic `409 Conflict`
  (`"Request with this idempotency key is already being processed"`).
- **Downstream 5xx** — the record is marked failed and the key becomes
  retryable, so a transient failure never poisons a retry.
- **Retention** — records expire after 24 hours (enforced on access and by a
  periodic sweep); an expired key becomes eligible again.
- **Fail-closed** — if the database is unreachable the request is rejected
  with `503` rather than proceeding without idempotency protection. This is
  separate from the rate limiter's own fail-open `passOnStoreError`
  behaviour, which is unchanged.

If retried requests are unexpectedly throttled, ensure the client is
sending the **same** `Idempotency-Key` header on retries.

---

## Metrics & Alerting

Rate-limit enforcement is observable through structured logs.  Set up
alerting on:

| Alert Condition                                          | Severity | Action                                 |
| -------------------------------------------------------- | -------- | -------------------------------------- |
| `[rate-limit] req.ip is undefined` in logs               | Warning  | Fix `TRUST_PROXY`                      |
| `[rate-limit] absurdly high max` warning                 | Warning  | Review rate-limit config               |
| Redis store errors in logs (when `REDIS_URL` is set)     | High     | Redis is down, enforcement degraded    |
| Spike in 429 responses (from access logs)                 | Info     | Normal under load; investigate if sustained |

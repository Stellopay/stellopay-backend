# Rate Limiter Load & Soak Benchmark

## Overview
Documentation for concurrent multi-IP load and soak testing methodology for `src/middleware/rate-limit.ts`.

## Execution
Run load and soak test outside normal CI fast path:
```bash
pnpm test:load
```

## Metrics Baseline
- **Concurrency:** 20 parallel connections with multi-IP header rotation.
- **Latency Overhead:** < 1.5 ms per request.
- **Rate Shedding:** Validated strict HTTP 429 status response once rate thresholds are breached.

## Shared Redis store (optional)

Set `REDIS_URL` to share the global, strict, contact, and analytics limiter
counters across replicas. Without it, the existing in-memory store is used.
The shared client is created once at startup and all limiters use the same
`RedisStore`. `passOnStoreError: true` remains enabled: a Redis outage fails
open to preserve API availability, while the rate-limit library logs the store
error for operator alerting. Keep the Redis endpoint private and use TLS and
credentials in production.

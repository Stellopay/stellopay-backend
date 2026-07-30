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

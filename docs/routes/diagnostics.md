# Operator Diagnostics API (`/diagnostics/*`)

The diagnostics endpoint provides internal system telemetry, database metrics, event volume aggregations, and sanitized recent activity logs for system operators and incident reporting.

---

## Security Boundary & Authorization

### Access Control Policy
Diagnostics data exposes high-level operational telemetry and table volumes. Access is strictly limited to authorized operators:

- **Authentication (`requireAuth`)**: Every request must carry a valid Starknet wallet address in the `x-user-address` header and a valid session Bearer token in the `Authorization` header (`Authorization: Bearer <token>`).
- **Authorization (`requireAdmin`)**: The normalized `x-user-address` must match an entry in the system's `ADMIN_ADDRESSES` configuration allowlist.
- **Dual Enforcement**: Middleware checks are registered at both the router level (`diagnosticsRouter.use(requireAuth, requireAdmin)`) and explicitly per route handler definition (`diagnosticsRouter.get("/diagnostics/events", requireAuth, requireAdmin, ...)`) to ensure privilege boundaries cannot drift during maintenance.

Unauthenticated or non-admin requests receive a `401 Unauthorized` response envelope without triggering database execution.

---

## Endpoint Contract

### `GET /api/v1/diagnostics/events`

Returns aggregate event counts, table counts, connection pool status, and sanitized recent activity.

#### Request Headers

| Header | Type | Description | Required |
| :--- | :--- | :--- | :--- |
| `x-user-address` | String | Starknet wallet address of the requesting operator | Yes |
| `Authorization` | String | Format: `Bearer <session_token>` | Yes |
| `Idempotency-Key` | String | Client-provided deduplication key | No |

#### Request Parameters
- **Query Parameters**:
  - `limit` (Optional, Integer): The maximum number of recent events to return. Defaults to `20`. Hard-capped at `100`.
  - `offset` (Optional, Integer): The number of recent events to skip. Defaults to `0`.
- **Body**: None.
- Every query is strictly parameterized or uses parsed integers, ensuring zero SQL injection exposure.

#### Success Response (`200 OK`)

```json
{
  "eventTypeCounts": [
    { "event_type": "AgreementCreated", "count": "15" },
    { "event_type": "AgreementActivated", "count": "12" }
  ],
  "escrowEventCounts": [
    { "event_type": "Funded", "count": "8" }
  ],
  "paymentEventCounts": [
    { "event_type": "PaymentSent", "count": "20" }
  ],
  "tableCounts": {
    "agreement_events_count": "15",
    "escrow_events_count": "8",
    "payments_count": "20",
    "employees_count": "5",
    "milestones_count": "10",
    "agreements_count": "12",
    "latest_block": "104850"
  },
  "latestEvents": [
    {
      "event_type": "AgreementCreated",
      "created_at": "2026-07-26T18:00:00.000Z"
    }
  ],
  "poolStats": {
    "total": 10,
    "idle": 8,
    "active": 2,
    "waiting": 0
  },
  "circuitBreakers": [
    {
      "endpointUrl": "https://starknet-mainnet.example.com/rpc",
      "state": "CLOSED",
      "recentFailureCount": 0,
      "openedAt": null
    }
  ],
  "summary": {
    "totalAgreementEvents": "15",
    "totalEscrowEvents": "8",
    "totalPayments": "20",
    "totalEmployees": "5",
    "totalMilestones": "10",
    "latestBlock": "104850"
  },
  "queryDurationMs": 12.34,
  "diagnosticsMetrics": {
    "counters": {
      "diagnostics_requests_total": 42,
      "diagnostics_success_total": 40,
      "diagnostics_errors_total": 2,
      "diagnostics_query_duration_ms_total": 520.5
    },
    "gauges": {
      "diagnostics_last_query_duration_ms": 12.34
    }
  }
}
```

---

## Structured Logging & Observability

Every diagnostics request emits structured log events through the `logDiagnosticsEvent` helper (pattern-aligned with `src/starknet/client-metrics.ts` and `src/auth/session-metrics.ts`):

| Event | Level | When | Payload |
| :--- | :--- | :--- | :--- |
| `diagnostics.request` | `info` | Route handler begins | `admin` (lowercased address), `limit`, `offset` |
| `diagnostics.success` | `info` | All queries complete successfully | `admin`, `queryDurationMs`, `agreementEvents` |
| `diagnostics.error` | `error` | Any query or processing failure | `error` (message), `stack` (first 3 frames) |
| `diagnostics.query_timing` | `debug` | After parallel `Promise.all` queries | `durationMs`, `limit`, `offset` |

Log output respects `LOG_FORMAT` (JSON or text) and `LOG_LEVEL` from the global
config, consistent with every other module.

Process-local metric counters (monotonically increasing) are tracked and exposed
in the `diagnosticsMetrics` response field:

| Counter | Description |
| :--- | :--- |
| `diagnostics_requests_total` | Total number of diagnostics endpoint hits |
| `diagnostics_success_total` | Successful query executions |
| `diagnostics_errors_total` | Failed query executions |
| `diagnostics_query_duration_ms_total` | Cumulative query wall-clock time (ms) |

A gauge `diagnostics_last_query_duration_ms` captures the most recent query's
wall-clock duration for operational dashboards.

### Response Timing

The `queryDurationMs` field reports the wall-clock time (ms, rounded to 2
decimal places) spent executing all five parallel read queries inside
`fetchDiagnosticsData`. This is the same value logged in
`diagnostics.query_timing` and accumulated in the
`diagnostics_query_duration_ms_total` counter.

## Reliability & Retry Semantics

- **Concurrent Execution (`Promise.all`)**: Read queries for event types, escrow events, payment events, table totals, and recent activity are executed in parallel via `fetchDiagnosticsData`. This minimizes latency and prevents cascading roundtrip bottlenecks.
- **Idempotency & Replay Safety**: All queries are side-effect-free static `SELECT` statements. Replaying requests or polling from monitoring scripts and incident reporting tools is 100% idempotent and safe.
  - To prevent ambiguous outcomes during retries, operators can provide an `Idempotency-Key` header. When present, the first successful response is cached for 24 hours and returned for identical subsequent requests.
- **Null Safety**: Fallbacks (`[]` and `{}`) ensure that empty table states or partial query responses will not cause runtime `TypeError` exceptions.

---

## Data Redaction & Reconnaissance Prevention

Raw row identifiers and PII (such as transaction hashes, agreement IDs, contract addresses, and wallet addresses) are excluded from recent events responses. 

Row outputs are passed through the `redactRecentEvent` helper to guarantee that only non-sensitive attributes (`event_type` and `created_at`) are returned. Malformed rows missing these fields or providing invalid types gracefully fall back to `"Unknown"` and a zero-epoch timestamp, ensuring safe evaluation by downstream code.

---
## Backward-Compatibility Contract

Existing callers (dashboards, monitoring scripts, and incident-reporting
tooling that polls this endpoint) may depend on the current response
shape. The following is a stability guarantee, enforced by tests in
`diagnostics.test.ts`:

- **Top-level keys are additive-only.** `circuitBreakers`,
  `diagnosticsMetrics`, `escrowEventCounts`, `eventTypeCounts`,
    `latestEvents`, `paymentEventCounts`, `poolStats`, `queryDurationMs`,
      `summary`, and `tableCounts` will always be present. New keys may be added
        in a future change; none of these ten will be renamed or removed without
          a breaking-change notice and a version bump.
        - **`summary` always has its six documented fields** (`totalAgreementEvents`,
          `totalEscrowEvents`, `totalPayments`, `totalEmployees`, `totalMilestones`,
            `latestBlock`), even when the underlying tables are empty (as `0`, not
              `null` or a missing key).
              - **`latestEvents` entries are locked to exactly `event_type` and
                `created_at`.** This is a security property (redaction), not just a
                  style choice — no future change should widen this without an explicit
                    review, since it's the primary defense against leaking transaction
                      hashes or agreement IDs through this endpoint.
                      - **Only `GET` is exposed** on `/diagnostics/events`. Other HTTP methods
                        return Express's default `404` today; this is asserted by a test so
                          that adding a new method on this path in the future is a deliberate,
                            reviewed change rather than an accidental side effect.
                            - **Count values remain strings**, as returned by Postgres's `COUNT(*)`
                              aggregate through the raw `sql` template — consumers should not assume
                                a numeric JSON type for `count`, `*_count`, or `latest_block` fields.

                                ## Out of Scope Edge Cases

                                - **Granular resource permissions**: Access control is binary (operator admin vs non-admin). Per-resource role-based access control (RBAC) is out of scope.
                                - **External Log Streaming**: Direct integration with external SIEM/log providers is handled outside this route handler.
                                - **A dedicated incident-reporting endpoint**: this router currently exposes only `GET /diagnostics/events`, which incident-response tooling polls directly. A distinct incident-reporting API (e.g. structured alert submission) does not exist and is out of scope for this change.

                                
## Out of Scope Edge Cases

- **Granular resource permissions**: Access control is binary (operator admin vs non-admin). Per-resource role-based access control (RBAC) is out of scope.
- **External Log Streaming**: Direct integration with external SIEM/log providers is handled outside this route handler.

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
- **Query Parameters**: None.
- **Body**: None.
- Every query is parameter-free and static, ensuring zero SQL injection exposure.

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
  "summary": {
    "totalAgreementEvents": "15",
    "totalEscrowEvents": "8",
    "totalPayments": "20",
    "totalEmployees": "5",
    "totalMilestones": "10",
    "latestBlock": "104850"
  }
}
```

---

## Reliability & Retry Semantics

- **Concurrent Execution (`Promise.all`)**: Read queries for event types, escrow events, payment events, table totals, and recent activity are executed in parallel via `fetchDiagnosticsData`. This minimizes latency and prevents cascading roundtrip bottlenecks.
- **Idempotency & Replay Safety**: All queries are side-effect-free static `SELECT` statements. Replaying requests or polling from monitoring scripts and incident reporting tools is 100% idempotent and safe.
  - To prevent ambiguous outcomes during retries, operators can provide an `Idempotency-Key` header. When present, the first successful response is cached for 24 hours and returned for identical subsequent requests.
- **Null Safety**: Fallbacks (`[]` and `{}`) ensure that empty table states or partial query responses will not cause runtime `TypeError` exceptions.

---

## Data Redaction & Reconnaissance Prevention

Raw row identifiers and PII (such as transaction hashes, agreement IDs, contract addresses, and wallet addresses) are excluded from recent events responses. 

Row outputs are passed through the `redactRecentEvent` helper to guarantee that only non-sensitive attributes (`event_type` and `created_at`) are returned.

---

## Out of Scope Edge Cases

- **Granular resource permissions**: Access control is binary (operator admin vs non-admin). Per-resource role-based access control (RBAC) is out of scope.
- **External Log Streaming**: Direct integration with external SIEM/log providers is handled outside this route handler.

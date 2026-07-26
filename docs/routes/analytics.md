# Analytics Rollup API (`/analytics/*`)

The analytics endpoint aggregates on-chain financial activity (payments, escrow
events, and agreement creations) into monthly rollups for a specified Starknet
user address and calendar year.

---

## Backward-Compatibility Contract

The response shape is **stable**. The fields and behaviors described in this
document MUST be preserved across future changes so that existing callers (e.g.
chart components) continue to work without modification.

Breaking changes require a new route version (`/api/v2/analytics/...`) rather
than in-place modification of this endpoint.

---

## Endpoint Contract

### `GET /api/v1/analytics/:user_address`

Returns a 12-month chart dataset with aggregated financial activity for the
requested user and year.

#### Path Parameters

| Parameter | Type | Description | Required |
| :--- | :--- | :--- | :--- |
| `user_address` | String | Valid Starknet address (hex, up to 64 chars, optional `0x` prefix). Validated and normalized via `StarknetAddress.parse` before any DB query. | Yes |

#### Query Parameters

| Parameter | Type | Default | Constraint | Description |
| :--- | :--- | :--- | :--- | :--- |
| `year` | Integer | current year | 2020–2100 | The calendar year to aggregate. |

---

#### Success Response (`200 OK`)

```json
{
  "year": 2026,
  "data": [
    { "month": "Jan", "views": 0 },
    { "month": "Feb", "views": -7.5 },
    { "month": "Mar", "views": 4 },
    { "month": "Apr", "views": -3 },
    { "month": "May", "views": 4 },
    { "month": "Jun", "views": 2 },
    { "month": "Jul", "views": 0 },
    { "month": "Aug", "views": 0 },
    { "month": "Sept", "views": 10 },
    { "month": "Oct", "views": 0 },
    { "month": "Nov", "views": 0 },
    { "month": "Dec", "views": 0 }
  ],
  "total": 9.5
}
```

**Frozen fields (must not change):**

| Field | Type | Notes |
| :--- | :--- | :--- |
| `year` | integer | The requested calendar year. |
| `data` | array (exactly 12) | One entry per calendar month, Jan→Dec order. |
| `data[].month` | string | Short month label from the set below. |
| `data[].views` | number | Signed decimal net amount (see sign conventions). |
| `total` | number | Lossless sum of all `views` values (same decimal precision). |

**Frozen month label set** (in order, index 0–11):

```
"Jan" "Feb" "Mar" "Apr" "May" "Jun"
"Jul" "Aug" "Sept" "Oct" "Nov" "Dec"
```

Note: `"Sept"` (not `"Sep"`) is the frozen label for month 9.

**Future additions**: new optional fields may be added to the top-level
response object without breaking compatibility. Existing fields will not be
removed or renamed.

---

## Aggregation Logic

Three data sources are queried and combined into `monthlyData[1..12]` using
BigInt arithmetic to avoid precision loss on u256 on-chain amounts:

### 1. Payments (`schema.payments`)

Payments where `from = userAddress` OR `to = userAddress` are fetched.
All payment amounts are added as **positive values** (the route treats the
user's net participation — not direction — as the contribution to the month).

### 2. Escrow Events (`schema.escrowEvents`)

| `eventType` | Sign | Rationale |
| :--- | :--- | :--- |
| `Funded` | **negative** | Capital leaving the employer's control into escrow. |
| `Released` | **positive** | Funds disbursed to the contributor. |
| `Refunded` | **positive** | Funds returned to the employer. |

### 3. Agreement Creations (`schema.agreementEvents` + `schema.agreements`)

Each `AgreementCreated` event involving the user adds `count × 1 000 base units`
to the month. This is a **proxy activity value** that keeps months with
agreement-only activity visible on a chart when no payment amounts exist yet.

The `1 000` base-unit constant is frozen. At `DEFAULT_TOKEN_DECIMALS = 6`, one
agreement creation contributes `0.001` display units.

### Decimal formatting

All month sums are divided by `10^DEFAULT_TOKEN_DECIMALS` (6) using
`formatTokenAmount` before being returned as `number`. Amounts are aggregated
across all tokens; per-token precision is out of scope for this endpoint.

The `total` is computed from the raw BigInt sum of all months, never by
summing already-rounded `views` values, to avoid accumulation of rounding error.

---

## Error Handling

| Status | Error Message | Condition |
| :--- | :--- | :--- |
| `400 Bad Request` | `Validation failed` | Invalid address or year outside 2020–2100. |
| `500 Internal Server Error` | DB error message | Any database query failure. No partial chart is returned. |

---

## Calendar-Year Boundary

The year window spans exactly:

- Start: `new Date(year, 0, 1)` — midnight January 1
- End: `new Date(year, 11, 31, 23, 59, 59)` — end of December 31

All three aggregation queries use the same `startDate`/`endDate` bounds via
`gte` / `lte` filters on `createdAt`.

---

## Out of Scope Edge Cases

- **Per-token aggregation**: amounts from different tokens (STRK at 18 decimals vs USDC/USDT at 6) are currently mixed together using the 6-decimal default. A per-token breakdown would require separate aggregation passes and is deferred to a future version.
- **Pagination / multi-year spans**: each request covers exactly one calendar year. Multi-year or unbounded ranges are not supported.
- **Time-zone handling**: the date boundaries use JavaScript `Date` which interprets the year/month/day in the server process's local time zone. UTC normalization is not currently applied.

# Analytics Route

`GET /analytics/:user_address`

Returns monthly payment and escrow activity for a user in a given year, formatted as chart data.

## Query Parameters

| Param | Type   | Required | Description |
|-------|--------|----------|-------------|
| year  | number | No       | Calendar year (2020–2100). Defaults to current year. |

## Response Shape

```json
{
  "year": 2026,
  "data": [
    { "month": "Jan", "views": 0 },
    { "month": "Feb", "views": 0 },
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
  "total": 17
}
```

- `year` – The requested year.
- `data` – Exactly 12 entries (one per month). Each entry has:
  - `month` – Three-letter month abbreviation (`Jan`–`Dec`, with `Sept` for September).
  - `views` – Net aggregated amount for that month (payment amounts minus escrow funding plus releases/refunds, plus a small base activity value from agreement creations). Displayed as a decimal number in token units (6-decimal default).
- `total` – Sum of all 12 monthly values.

## Response Shape Guard

The outbound payload is validated against a Zod schema (`AnalyticsResponse`) on every request **outside production** (`NODE_ENV !== "production"`). On shape mismatch:

- The error is logged via `console.error` with the Zod validation issues.
- The request still completes normally (no 500 returned to the client).

In production the parse is skipped entirely, adding zero latency to the hot path.

This guard exists to catch silent contract drift during development and CI — e.g., a refactor that renames or drops a field will fail loudly in tests instead of silently breaking a downstream consumer.

### Exported symbols

- `AnalyticsResponse` – The Zod schema object, importable for use in tests or downstream consumers.
- `AnalyticsResponseType` – The inferred TypeScript type of a validated response.

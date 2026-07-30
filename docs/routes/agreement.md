# Agreement Routes

## Bulk status lookup

`POST /api/v1/agreement/:address/bulk-status` returns the indexed status of
multiple agreements for one WorkAgreement contract.

The `address` path parameter must be a valid Starknet address. The JSON request
body is strict and has this shape:

```json
{
  "agreement_ids": ["1", "2", "3"]
}
```

`agreement_ids` must contain between 1 and 50 positive integer IDs. IDs may be
safe JSON integers or decimal strings up to 78 digits. Additional body fields,
booleans, fractions, zero, negative values, unsafe JSON integers, and
non-decimal strings are rejected with `400 Bad Request`.

The response contains one result for every input ID in the same order. Duplicate
IDs remain duplicated in the response. Missing agreements do not fail the
request:

```json
{
  "results": [
    { "agreement_id": "1", "found": true, "status": 1 },
    { "agreement_id": "2", "found": false, "status": null },
    { "agreement_id": "3", "found": true, "status": 4 }
  ],
  "source": "indexed"
}
```

Agreement status values follow the database schema:

| Value | Meaning   |
| ----- | --------- |
| `0`   | Created   |
| `1`   | Active    |
| `2`   | Paused    |
| `3`   | Cancelled |
| `4`   | Completed |
| `5`   | Disputed  |

The endpoint is read-only and safe to retry. It validates and caps the request
before database access, deduplicates IDs for lookup efficiency, and performs one
parameterized `inArray` query against `schema.agreements`. The query is also
scoped by the validated contract address, preventing an agreement with the same
ID from another contract from being returned.

Unexpected database failures return `500 Internal Server Error` through the
service's central error handler.

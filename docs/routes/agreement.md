# Agreement Routes

**File:** `src/routes/agreement.ts`  
**Mounted at:** `/api/v1`

---

## Overview

The agreement routes provide on-chain and indexed read access to `WorkAgreement`
contracts deployed on Starknet, plus endpoints that prepare (but do not sign or
submit) transactions for every lifecycle action: creation (time-based,
milestone, payroll), funding, milestone management, employee management,
activation, pausing, cancellation, dispute resolution, claims, and payroll
payouts.

All state-mutating endpoints use a **prepare pattern**: they return a populated
Starknet call object, the caller's nonce, and the chain ID. The backend never
holds signing keys and never submits transactions — the client is responsible
for signing and broadcasting.

---

## Endpoints

### Read endpoints (GET)

These return data from the indexed database when available, falling back to
live on-chain contract calls. Each response includes a `source` field
(`"indexed"` or `"contract"`) so callers can distinguish the data origin.

#### `GET /agreement/defaults`

Returns the default `WorkAgreement` contract address.

**Response `200 OK`**

```json
{ "address": "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd" }
```

---

#### `GET /agreement/:address/get_employer/:agreement_id`

| Parameter      | Type    | Description                              |
| -------------- | ------- | ---------------------------------------- |
| `address`      | string  | WorkAgreement contract address           |
| `agreement_id` | integer | Positive agreement ID                    |

**Response `200 OK`**

```json
{ "agreement_id": "1", "employer": "0x1234...", "source": "indexed" }
```

---

#### `GET /agreement/:address/get_contributor/:agreement_id`

Same path parameters as `get_employer`. Returns the contributor address.

```json
{ "agreement_id": "1", "contributor": "0xabcd...", "source": "indexed" }
```

---

#### `GET /agreement/:address/get_token/:agreement_id`

Returns the ERC-20 token address used by the agreement.

```json
{ "agreement_id": "1", "token": "0x...", "source": "indexed" }
```

---

#### `GET /agreement/:address/get_escrow`

Returns the escrow contract address deployed for this WorkAgreement.

```json
{ "escrow": "0x..." }
```

---

#### `GET /agreement/:address/is_initialized`

Checks whether the WorkAgreement contract has been initialized (has a
non-zero escrow address set).

```json
{ "initialized": true, "escrow": "0x..." }
```

---

#### `GET /agreement/:address/get_total_amount/:agreement_id`

Returns the total funded amount for the agreement (as a decimal string for
precision-safe transport).

```json
{ "agreement_id": "1", "total_amount": "1000000000", "source": "indexed" }
```

---

#### `GET /agreement/:address/get_paid_amount/:agreement_id`

Returns the amount already paid out.

```json
{ "agreement_id": "1", "paid_amount": "500000000", "source": "indexed" }
```

---

#### `GET /agreement/:address/get_status/:agreement_id`

Returns the agreement status as a numeric code.  Values are defined by the
`WorkAgreement` Cairo contract enum; verify against the deployed contract
if the mapping changes across upgrades.

| Value | Meaning    |
| ----- | ---------- |
| 0     | Draft      |
| 1     | Funded     |
| 2     | Active     |
| 3     | Paused     |
| 4     | Completed  |
| 5     | Cancelled  |

```json
{ "agreement_id": "1", "status": 2, "source": "indexed" }
```

---

#### `POST /agreement/:address/bulk-status`

Fetch statuses for up to 50 agreement IDs in a single request.

**Body**

```json
{ "agreement_ids": [1, 2, 3] }
```

| Field           | Type       | Constraints                     |
| --------------- | ---------- | ------------------------------- |
| `agreement_ids` | integer[ ] | 1–50 entries, each positive int |

**Response `200 OK`**

```json
{
  "results": [
    { "agreement_id": "1", "found": true, "status": 2 },
    { "agreement_id": "999", "found": false, "status": null }
  ],
  "source": "indexed"
}
```

---

#### `GET /agreement/:address/get_agreement_mode/:agreement_id`

Returns the agreement mode:

| Value | Mode    |
| ----- | ------- |
| 0     | Escrow  |
| 1     | Payroll |

```json
{ "agreement_id": "1", "mode": 0, "source": "indexed" }
```

---

#### `GET /agreement/:address/get_employee_count/:agreement_id`

Returns the number of employees in a payroll agreement.

```json
{ "agreement_id": "1", "employee_count": 5, "source": "indexed" }
```

---

#### `GET /agreement/:address/get_employee/:agreement_id/:index`

Returns the employee address at the given 0-based index.

| Parameter | Type    | Description       |
| --------- | ------- | ----------------- |
| `index`   | integer | 0-based, ≥ 0     |

```json
{ "agreement_id": "1", "index": 0, "employee": "0x...", "source": "indexed" }
```

---

#### `GET /agreement/:address/get_employee_salary/:agreement_id/:index`

Returns the employee's salary-per-period as a decimal string.

```json
{ "agreement_id": "1", "index": 0, "salary": "1000000000000000000", "source": "indexed" }
```

---

#### `GET /agreement/:address/get_dispute_status/:agreement_id`

Returns the dispute status:

| Value | Meaning   |
| ----- | --------- |
| 0     | None      |
| 1     | Raised    |
| 2     | Resolved  |

```json
{ "agreement_id": "1", "dispute_status": 0, "source": "indexed" }
```

---

#### `GET /agreement/:address/is_grace_period_active/:agreement_id`

Returns whether the grace period is currently active after cancellation.

```json
{ "agreement_id": "1", "is_grace_period_active": false }
```

---

#### `GET /agreement/:address/list/:user_address`

Lists all agreements where `user_address` is the employer, contributor, or
a payroll employee. Uses cursor-based pagination.

| Query Param | Type    | Default | Notes                     |
| ----------- | ------- | ------- | ------------------------- |
| `limit`     | integer | 50      | Clamped to 1–100          |
| `cursor`    | string  | —       | Agreement ID for next page |
| `status`    | integer | —       | Filter by status (0–5)    |

**Response `200 OK`**

```json
{
  "agreements": [
    {
      "agreement_id": "1",
      "employer": "0x...",
      "contributor": "0x...",
      "status": 2,
      "mode": 0,
      "total_amount": "1000000000",
      "paid_amount": "500000000"
    }
  ],
  "source": "indexed",
  "limit": 50,
  "cursor": null,
  "hasMore": false
}
```

---

#### `POST /agreement/:address/get_agreement_id_from_tx`

Extracts the agreement ID from an `AgreementCreated` event in a transaction
receipt.

**Body**

```json
{ "tx_hash": "0x..." }
```

**Response `200 OK`**

```json
{ "agreement_id": "42" }
```

---

### Prepare endpoints (POST)

Every prepare endpoint requires a wallet session (`wallet_address` +
`session_token`) and returns the same response shape:

```json
{
  "call": { /* Starknet call object */ },
  "wallet_address": "0x...",
  "nonce": "0x...",
  "chain_id": "0x534e5f5345504f4c4941"
}
```

| Endpoint                                                    | Description                              |
| ----------------------------------------------------------- | ---------------------------------------- |
| `POST /prepare/agreement/:address/initialize`               | Initialize contract (escrow + arbiter)   |
| `POST /prepare/agreement/:address/create_time_based_agreement` | Create time-based agreement           |
| `POST /prepare/agreement/:address/create_milestone_agreement`  | Create milestone-based agreement      |
| `POST /prepare/agreement/:address/create_payroll_agreement`    | Create payroll agreement              |
| `POST /prepare/agreement/:address/add_employee`                | Add employee to payroll agreement     |
| `POST /prepare/agreement/:address/fund_agreement`              | Fund an agreement                     |
| `POST /prepare/agreement/:address/add_milestone`               | Add a milestone                        |
| `POST /prepare/agreement/:address/approve_milestone`           | Approve a milestone                    |
| `POST /prepare/agreement/:address/claim_milestone`             | Claim a milestone payout               |
| `POST /prepare/agreement/:address/activate`                    | Activate agreement                     |
| `POST /prepare/agreement/:address/pause`                       | Pause agreement                        |
| `POST /prepare/agreement/:address/resume`                      | Resume paused agreement                |
| `POST /prepare/agreement/:address/cancel`                      | Cancel agreement                       |
| `POST /prepare/agreement/:address/finalize_grace_period`       | Finalize the cancellation grace period |
| `POST /prepare/agreement/:address/raise_dispute`               | Raise a dispute                        |
| `POST /prepare/agreement/:address/resolve_dispute`             | Resolve a dispute (arbiter)            |
| `POST /prepare/agreement/:address/claim_time_based`            | Claim time-based payout                |
| `POST /prepare/agreement/:address/claim_payroll`               | Claim payroll payout (employee)        |

---

### Maintenance endpoint

#### `POST /agreement/:address/sync_index`

Rebuilds the agreement index by scanning on-chain agreements. Not intended
for production use — data is populated by the indexer.

**Response `200 OK`**

```json
{ "synced": 42, "total": 42 }
```

---

## Authentication & Session

All prepare endpoints require a valid session; they call `requireSession`
and return `401` with `{ "error": "Invalid session" }` when the session is
absent, expired, or revoked.

Read endpoints are public — no authentication required.

---

## Data Source Strategy

Read endpoints prefer the indexed database over live contract calls:

1. Query the `agreements` (or `employees`) table in the local PostgreSQL.
2. If a matching row is found, return `"source": "indexed"`.
3. If the DB query fails or returns empty, fall back to an on-chain contract
   call and return `"source": "contract"`.

This gives callers fast indexed data while providing a safety net when the
indexer has not yet processed a recently created agreement.

---

## Idempotency Contract

- **Read endpoints**: All `GET` endpoints are purely read-only — retries are
  safe and return the same result for the same block height.
- **Prepare endpoints**: These produce deterministic call objects given the
  same inputs (address, nonce, chain ID from the node). Re-calling with the
  same parameters produces the same call data; the caller is responsible
  for nonce management.

---

## Error Handling

| Status | Condition                              |
| ------ | -------------------------------------- |
| 400    | Invalid path or body parameter (Zod)   |
| 401    | Missing or invalid session             |
| 404    | Agreement or transaction not found     |
| 500    | Unexpected contract or database error  |

Path parameters (`:address`, `:agreement_id`) are validated by Zod schemas
(`StarknetAddress`, `AgreementIdParam`). Malformed inputs are rejected with
`400` before any contract call or database query.

---

## Constants

| Export                | Value | Purpose                            |
| --------------------- | ----- | ---------------------------------- |
| `BULK_STATUS_MAX_IDS` | 50    | Max agreement IDs per bulk request |
| `LIST_MAX_LIMIT`      | 100   | Max agreements per list page       |
| `LIST_DEFAULT_LIMIT`  | 50    | Default page size for list         |

---

## Security Notes

- The backend never stores or transmits private keys.
- All prepare endpoints enforce session authentication before returning call
  data.
- Contract addresses and agreement IDs are validated against schemas before
  use, preventing injection vectors.
- Wallet addresses are normalized (trimmed, lowercased, canonical hex) before
  database lookups.

# System Routes

**File:** `src/routes/system.ts`  
**Mounted at:** `/api/v1`

---

## Overview

The system routes expose lightweight operational endpoints: application
version, Starknet network chain ID, account nonce lookup, and Kubernetes-style
liveness/readiness probes. These routes are intentionally unauthenticated
and minimal — they serve infrastructure tooling, not end users.

---

## Endpoints

### `GET /system/version`

Returns the application version from `package.json`. The response is cached
in-process and served with `Cache-Control: public, max-age=3600`.

**Response `200 OK`**

```json
{ "version": "0.1.0" }
```

---

### `GET /network/chain_id`

Returns the Starknet chain ID and spec version, served from a short-lived
in-process cache.

**Response `200 OK`**

```json
{
  "chain_id": "0x534e5f5345504f4c4941",
  "spec_version": "0.7.1"
}
```

The response carries `Cache-Control: public, max-age=300` (5 minutes).

---

### `GET /account/:address/nonce`

Returns the current (pending) nonce for a Starknet account address.

| Parameter | Type   | Description                    |
| --------- | ------ | ------------------------------ |
| `address` | string | Valid Starknet account address |

**Response `200 OK`**

```json
{ "address": "0x...", "nonce": "0x2a" }
```

The nonce is fetched from the Starknet RPC with `"pending"` block tag, so
it includes transactions already submitted but not yet confirmed.

**Error responses**

| Status | Condition       |
| ------ | --------------- |
| 400    | Invalid address |
| 500    | RPC error       |

---

### `GET /system/live`

Kubernetes-style liveness probe. Returns immediately without checking any
external dependency.

**Response `200 OK`**

```json
{ "status": "ok" }
```

This endpoint is designed to be cheap and always succeed as long as the
Express process is serving HTTP. It does **not** verify database or RPC
connectivity — those checks belong to the readiness probe.

---

### `GET /system/ready`

Kubernetes-style readiness probe. Checks both database and Starknet RPC
health.

**Response `200 OK` (healthy)**

```json
{
  "status": "ok",
  "checks": {
    "database": "reachable",
    "starknet-rpc": "reachable"
  }
}
```

**Response `503 Service Unavailable` (degraded)**

```json
{
  "status": "degraded",
  "checks": {
    "database": "unreachable",
    "starknet-rpc": "reachable"
  }
}
```

The two checks run concurrently via `Promise.all`:

| Check         | Implementation                                          |
| ------------- | ------------------------------------------------------- |
| `database`    | `checkDbHealth()` — a lightweight DB ping               |
| `starknet-rpc` | `provider.getBlockNumber()` — latest block number call |

The endpoint returns `200` only when **both** dependencies are reachable.
If either check fails, the status is `503` with `"degraded"`.

---

## Caching

| Endpoint              | Cache Header                       | Notes                          |
| --------------------- | ---------------------------------- | ------------------------------ |
| `/system/version`     | `public, max-age=3600`             | In-process cache + HTTP header |
| `/network/chain_id`   | `public, max-age=300`              | In-process cache + HTTP header |
| `/account/:address/nonce` | None                           | Always fresh (pending nonce)   |
| `/system/live`        | None                               | Always fresh                   |
| `/system/ready`       | None                               | Always fresh                   |

---

## Authentication

All system routes are **public** — no authentication or session is required.
This is intentional: infrastructure probes (load balancer health checks,
monitoring agents) must not depend on wallet-based authentication.

---

## Idempotency Contract

- **Read-only**: All endpoints are `GET` and produce no side effects.
- **Version/chain ID**: Return cached values; repeated requests within the
  cache window return identical responses.
- **Nonce**: Represents volatile chain state; repeated requests may return
  different values as the account submits transactions.
- **Liveness/readiness**: Liveness is trivially idempotent. Readiness
  reflects current infrastructure state — repeated polls are expected.

---

## Security Notes

- No PII or internal configuration is exposed.
- The version endpoint reads from `package.json` on disk (cached after first
  read); ensure the production filesystem does not contain version files
  with sensitive metadata.
- The nonce endpoint exposes public on-chain data for the requested address
  — this is not protected information.

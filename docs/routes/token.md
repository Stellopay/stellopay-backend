# Token Routes

**File:** `src/routes/token.ts`  
**Mounted at:** `/api/v1`

---

## Overview

The token routes serve ERC-20 token metadata (name, symbol, decimals) with
in-memory caching and deduplication, read current allowance values, and
prepare token approval transactions.  Metadata is resolved from on-chain
Starknet contract calls and cached by canonical address for
`TOKEN_METADATA_CACHE_TTL_MS` (default 5 minutes).

---

## Endpoints

### `GET /token/:address/metadata`

Returns ERC-20 metadata for the given token contract address.

| Parameter | Type   | Description                                    |
| --------- | ------ | ---------------------------------------------- |
| `address` | string | Starknet ERC-20 token contract address         |

**Response `200 OK`**

```json
{
  "token": "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "name": "Starknet Token",
  "symbol": "STRK",
  "decimals": 18
}
```

The `stale` flag is included (set to `true`) when any underlying RPC call
was served from a stale cache — useful for detecting degraded RPC conditions
without breaking callers.

**Error responses**

| Status | Condition             | Body                                   |
| ------ | --------------------- | -------------------------------------- |
| 400    | Invalid address       | `{ "error": "Starknet address ..." }`  |
| 404    | Contract not found    | `{ "error": "Token not found" }`       |

---

### `GET /token/:address/allowance/:owner/:spender`

Returns the current ERC-20 allowance for `spender` granted by `owner`.

| Parameter | Type   | Description                            |
| --------- | ------ | -------------------------------------- |
| `address` | string | ERC-20 token contract address          |
| `owner`   | string | Address that granted the allowance     |
| `spender` | string | Address authorized to spend            |

**Response `200 OK`**

```json
{
  "token": "0x...",
  "owner": "0x...",
  "spender": "0x...",
  "allowance": "0xde0b6b3a7640000"
}
```

`allowance` is returned as a hex string to preserve full-precision `uint256`
values over JSON.

**Error responses**

| Status | Condition             |
| ------ | --------------------- |
| 400    | Invalid address       |
| 404    | Token contract not found |

---

### `POST /prepare/token/:address/approve`

Prepares an ERC-20 `approve` transaction for client-side signing.

| Parameter | Type   | Description                    |
| --------- | ------ | ------------------------------ |
| `address` | string | ERC-20 token contract address  |

**Body**

```json
{
  "wallet_address": "0x...",
  "session_token": "...",
  "spender": "0x...",
  "amount": "1000000000000000000"
}
```

| Field            | Type   | Constraints                    |
| ---------------- | ------ | ------------------------------ |
| `wallet_address` | string | Valid Starknet address         |
| `session_token`  | string | Min 10 chars                   |
| `spender`        | string | Valid Starknet address         |
| `amount`         | string | Non-empty decimal string       |

**Response `200 OK`**

```json
{
  "call": { /* Starknet call object */ },
  "wallet_address": "0x...",
  "nonce": "0x...",
  "chain_id": "0x534e5f5345504f4c4941"
}
```

**Error responses**

| Status | Condition            |
| ------ | -------------------- |
| 400    | Invalid body (Zod)   |
| 401    | Invalid session      |

---

## In-Memory Metadata Cache

Token metadata is cached by canonical Starknet address with a TTL configured
via `TOKEN_METADATA_CACHE_TTL_MS` (default: 5 minutes).

### Cache behavior

- **Cache hit**: Returns the cached `TokenMetadata` without an RPC call.
- **Cache miss / expired**: Fires an RPC call. Concurrent callers for the
  same address share a single in-flight promise — they all wait on the same
  result. This prevents thundering-herd RPC storms.
- **Failed requests are not cached**: Only successful metadata fetches are
  written to the cache. Transient RPC failures retry on the next caller.

### Exported helpers

```ts
getTokenMetadata(address: string): Promise<TokenMetadata>
getTokenMetadataBatch(addresses: string[]): Promise<Map<string, TokenMetadata>>
clearTokenMetadataCache(): void  // tests only
```

`getTokenMetadataBatch` canonicalizes and deduplicates addresses, then
resolves metadata with bounded concurrency (`TOKEN_METADATA_BATCH_CONCURRENCY = 8`).
This keeps a large notification or transaction page from creating an
unbounded RPC fan-out.

---

## Token Metadata Type

```typescript
interface TokenMetadata {
  token: string;     // Canonical Starknet address
  name: string;      // ERC-20 name (decoded from shortString)
  symbol: string;    // ERC-20 symbol (decoded from shortString)
  decimals: number;  // ERC-20 decimals
  stale?: boolean;   // True when RPC response was cached
}
```

---

## RPC Call Behavior

Metadata is resolved via three parallel `callContract` invocations for
`name`, `symbol`, and `decimals`. The `staleProvider` is used so that
results can be served even when the primary RPC endpoint is degraded —
circuit-breaker state does not prevent token metadata resolution.

---

## Authentication & Session

Only the `/prepare/token/:address/approve` endpoint requires a valid
session. Read endpoints (`metadata` and `allowance`) are public.

---

## Idempotency Contract

- **Read endpoints**: Pure RPC reads on chain state. Safe to retry.
- **Prepare endpoint**: Produces a deterministic call object. No side
  effects on the server.

---

## Security Notes

- The backend never holds signing keys. The `approve` endpoint returns
  unsigned call data; the client signs and broadcasts.
- Addresses are normalized via `normalizeStarknetAddress` before use as
  map keys or contract parameters.
- The metadata cache is in-process memory — it does not leak state across
  requests from different users.

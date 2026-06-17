## StelloPay Backend (Starknet Sepolia)

Backend service to read/write the deployed `PayrollEscrow` + `WorkAgreement` contracts over RPC.

### Setup

1. Copy env template:

```bash
cp env.example .env
```

2. Fill in:

- `STARKNET_RPC_URL`
- (optional) `PAYROLL_ESCROW_ADDRESS`, `WORK_AGREEMENT_ADDRESS`

3. Install + run:

```bash
npm install
npm run dev
```

If you use pnpm:

```bash
pnpm install
pnpm run dev
```

For production:

```bash
pnpm start
```

### Endpoints

- `GET /health`
- `GET /api/v1/network/chain_id`
- `GET /api/v1/account/:address/nonce`

#### Auth (wallet ownership)

- `POST /api/v1/auth/challenge`
- `POST /api/v1/auth/verify`

#### PayrollEscrow (view)

- `GET /api/v1/escrow/:address/get_employer`
- `GET /api/v1/escrow/:address/get_agreement`
- `GET /api/v1/escrow/:address/get_token`

#### PayrollEscrow (prepare to sign client-side)

- `POST /api/v1/prepare/escrow/:address/initialize`
- `POST /api/v1/prepare/escrow/:address/set_agreement`
- `POST /api/v1/prepare/escrow/:address/deposit`
- `POST /api/v1/prepare/escrow/:address/release`
- `POST /api/v1/prepare/escrow/:address/refund_remaining`

#### WorkAgreement (view)

- `GET /api/v1/agreement/:address/get_employer`
- `GET /api/v1/agreement/:address/get_contributor`
- `GET /api/v1/agreement/:address/get_token`
- `GET /api/v1/agreement/:address/get_escrow`
- `GET /api/v1/agreement/:address/get_total_amount`
- `GET /api/v1/agreement/:address/get_paid_amount`

#### WorkAgreement (invoke)

#### WorkAgreement (prepare to sign client-side)

- `POST /api/v1/prepare/agreement/:address/initialize_time_based`
- `POST /api/v1/prepare/agreement/:address/initialize_milestone_based`
- `POST /api/v1/prepare/agreement/:address/add_milestone`
- `POST /api/v1/prepare/agreement/:address/approve_milestone`
- `POST /api/v1/prepare/agreement/:address/claim_milestone`
- `POST /api/v1/prepare/agreement/:address/activate`
- `POST /api/v1/prepare/agreement/:address/pause`
- `POST /api/v1/prepare/agreement/:address/resume`
- `POST /api/v1/prepare/agreement/:address/cancel`
- `POST /api/v1/prepare/agreement/:address/claim_time_based`

#### Billing Profiles _(requires `BILLING_ENABLED=true`)_

All billing routes live under a single canonical prefix.  
Previously there were multiple duplicate paths (`/billing/profile/...`, `/billing-profiles/...`, `/settings/billing-profiles/...`, etc.) — these have been consolidated.

| Method | Path                                                      | Description                                           |
| ------ | --------------------------------------------------------- | ----------------------------------------------------- |
| `GET`  | `/api/v1/billing/profiles/:profileId`                     | Full profile (info + payment methods + invoices)      |
| `GET`  | `/api/v1/billing/profiles/:profileId/general-information` | Identity / contact fields (sensitive fields excluded) |
| `GET`  | `/api/v1/billing/profiles/:profileId/payment-methods`     | Payment methods (masked numbers only)                 |
| `GET`  | `/api/v1/billing/profiles/:profileId/invoices`            | Invoice history                                       |
| `GET`  | `/api/v1/billing/profiles/:profileId/summary`             | Reward-limit / spend summary                          |

**Feature flag:** Set `BILLING_ENABLED=true` in your environment once the `billing_profiles` database migration has been applied.  
Until then every route returns `HTTP 501 Not Implemented` — no mock PII is served at any time.

**Response envelope** (all routes):

```json
{ "success": true, "data": { ... } }
// or on error:
{ "success": false, "error": "message" }
```

**Database tables added** (see `src/db/schema.ts`):

- `billing_profiles` — identity, address, limits
- `billing_payment_methods` — masked payment method references
- `billing_invoices` — invoice records

**Security note:** `taxId` and `dateOfBirth` are stored in the database but are **never returned** by any API endpoint. They must only be accessed through separately-authorised, audited internal processes.

---

### ABI source

By default the backend loads ABI from:

- `../Starknet-Contracts/target/release/starknet_contracts_PayrollEscrow.contract_class.json`
- `../Starknet-Contracts/target/release/starknet_contracts_WorkAgreement.contract_class.json`

### Signing model

- The backend **does not** hold private keys.
- Users first prove wallet ownership by signing a backend-issued challenge (`/auth/challenge` → sign typed data → `/auth/verify`).
- For contract mutations, the backend returns a prepared `call` + `nonce`; the frontend wallet/account should sign + execute.

### Frontend usage (starknet.js wallet)

1. Get challenge and sign it:

```ts
import { connect, type TypedData } from "starknet";

const BACKEND = "http://localhost:4000/api/v1";

async function login(address: string) {
  const chRes = await fetch(`${BACKEND}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const ch = await chRes.json();
  const typed: TypedData = ch.typed_data;

  const conn = await connect();
  if (!conn?.account) throw new Error("Wallet not connected");

  const signature = await conn.account.signMessage(typed);

  const vRes = await fetch(`${BACKEND}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signature }),
  });
  return await vRes.json(); // { session_token, ... }
}
```

2. Prepare a call (example: escrow deposit), then execute from wallet:

```ts
async function deposit({
  walletAddress,
  sessionToken,
  escrowAddress,
  amount,
}: {
  walletAddress: string;
  sessionToken: string;
  escrowAddress: string;
  amount: string; // decimal string
}) {
  const prepRes = await fetch(
    `${BACKEND}/prepare/escrow/${escrowAddress}/deposit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet_address: walletAddress,
        session_token: sessionToken,
        amount,
      }),
    },
  );
  const prep = await prepRes.json(); // { call, nonce, chain_id, wallet_address }

  const conn = await connect();
  if (!conn?.account) throw new Error("Wallet not connected");

  // Wallet signs + sends the transaction directly
  return await conn.account.execute(prep.call, { nonce: prep.nonce });
}
```

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
- (optional) `CONTACT_RECIPIENT_EMAIL` — recipient for contact-form submissions (required to deliver them)

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

### Environment variables

All configuration is parsed and validated in `src/config.ts`. `env.example` has the full annotated list; the main settings and their defaults are:

| Variable | Default | Notes |
| --- | --- | --- |
| `STARKNET_RPC_URL` | (required) | Startup fails if unset |
| `NODE_ENV` | `development` | `production` enforces the ABI path guard below |
| `PORT` | `4000` | |
| `CORS_ORIGIN` | `*` | See the CORS Configuration section |
| `POSTGRES_CONNECTION_STRING` | `postgresql://localhost:5432/stellopay_indexer` | |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `900000` / `100` | Global rate limiter |
| `RATE_LIMIT_STRICT_WINDOW_MS` / `RATE_LIMIT_STRICT_MAX` | `300000` / `10` | Auth and contact limiter |
| `TRUST_PROXY` | `1` | Number of proxies, or `true` |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `10000` | Graceful shutdown drain timeout |
| `BILLING_ENABLED` | `false` | Only the literal `true` enables billing routes |
| `CONTACT_RECIPIENT_EMAIL` | (none) | Must be a valid email; required to deliver contact emails |
| `ESCROW_CONTRACT_CLASS_JSON` / `AGREEMENT_CONTRACT_CLASS_JSON` | local `contracts/` files in dev | Required in production; startup fails if unset |

### Deployment & graceful shutdown

The server captures `SIGTERM` and `SIGINT` signals to gracefully shutdown:
1. Stops accepting new connections (drains HTTP server).
2. Waits for existing in-flight requests to finish, bounded by a timeout (`SHUTDOWN_DRAIN_TIMEOUT_MS`, default 10 seconds).
3. Closes the Postgres connection pool gracefully.
4. Exits with code `0`. If the drain timeout is exceeded, it force-exits with `1`.

When deploying under a process manager (like PM2 or systemd) or container orchestrator (like Kubernetes/Docker Swarm), ensure that the orchestrator sends `SIGTERM` and waits at least `SHUTDOWN_DRAIN_TIMEOUT_MS` before sending `SIGKILL`. This ensures no in-flight requests are dropped and database connections are returned cleanly.

### Testing

Unit tests run with [Vitest](https://vitest.dev). They need no database or live
Starknet RPC — a dummy `STARKNET_RPC_URL` is injected via `vitest.config.ts`, and
route tests mock the DB/RPC layer.

```bash
pnpm test            # run the suite once
pnpm test:watch      # watch mode
pnpm test:coverage   # run with a coverage report
```

Coverage thresholds (95% statements/lines/functions, 90% branches) are enforced on
the core auth/codec modules. CI (`.github/workflows/ci.yml`) runs the build and tests
on every push and pull request.

### CORS Configuration

The server enforces strict CORS rules to prevent credential leakage:

| `CORS_ORIGIN` value | `credentials` | Behaviour |
|---|---|---|
| `http://localhost:3000` | ✅ `true` | Only that origin is allowed; unlisted origins are **rejected** |
| `http://a.com,https://b.com` | ✅ `true` | Both origins allowed; all others **rejected** |
| `*` | ❌ `false` | All origins allowed, but cookies/auth headers are **not forwarded** |

> **Security rule** (enforced by the CORS spec): you **cannot** combine `credentials: true`
> with a wildcard `*` origin. The server will never silently reflect an unknown origin —
> any origin not on the allowlist receives an explicit rejection error.

**Development** (default — single origin):
```env
CORS_ORIGIN=http://localhost:3000
```

**Production** (explicit allowlist — recommended):
```env
CORS_ORIGIN=https://app.stellopay.com,https://staging.stellopay.com
```

**Public / unauthenticated API** (no cookies/auth forwarded):
```env
CORS_ORIGIN=*
```

### Route inventory

Routes are mounted in `src/index.ts`. `/api/*` routes share the global rate limiter; `/api/v1/auth/*` and `/api/v1/contact/*` also use the stricter limiter. "Session" means the route calls `requireSession` with `wallet_address` and `session_token` from the JSON body.

| Method | Path | Purpose | Auth/session | DB/RPC/flag notes |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | Liveness check | No | No DB/RPC |
| `GET` | `/api/v1/network/chain_id` | Starknet chain/spec version | No | RPC |
| `GET` | `/api/v1/account/:address/nonce` | Pending nonce for an account | No | RPC |
| `POST` | `/api/v1/auth/challenge` | Create wallet ownership challenge | No | RPC chain ID; strict limiter |
| `POST` | `/api/v1/auth/verify` | Verify signed challenge and create session | No existing session | RPC signature verification; strict limiter |
| `POST` | `/api/v1/auth/session/validate` | Validate and refresh a session | Body session | In-memory session store |
| `GET` | `/api/v1/escrow/defaults` | Default escrow contract address | No | Config only |
| `GET` | `/api/v1/escrow/:address/get_token` | Escrow token address | No | RPC |
| `GET` | `/api/v1/escrow/:address/is_initialized` | Escrow initialization probe | No | RPC |
| `GET` | `/api/v1/escrow/:address/get_agreement_balance/:agreement_id` | Escrow balance for agreement | No | DB indexed events, then RPC fallback |
| `GET` | `/api/v1/escrow/:address/get_agreement_employer/:agreement_id` | Employer for escrow agreement | No | RPC |
| `POST` | `/api/v1/prepare/escrow/:address/initialize` | Prepare escrow `initialize` call | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/escrow/:address/fund_agreement` | Prepare escrow funding call | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/escrow/:address/release` | Prepare escrow release call | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/escrow/:address/refund_remaining` | Prepare escrow refund call | Body session | RPC nonce/chain ID |
| `GET` | `/api/v1/agreement/defaults` | Default agreement contract address | No | Config only |
| `GET` | `/api/v1/agreement/:address/get_employer/:agreement_id` | Agreement employer | No | DB agreement row, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/get_contributor/:agreement_id` | Agreement contributor | No | DB agreement row, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/get_token/:agreement_id` | Agreement token | No | DB agreement row, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/get_escrow` | Agreement escrow contract | No | RPC |
| `GET` | `/api/v1/agreement/:address/is_initialized` | Agreement initialization probe | No | RPC |
| `GET` | `/api/v1/agreement/:address/get_total_amount/:agreement_id` | Agreement total amount | No | DB agreement row, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/get_paid_amount/:agreement_id` | Agreement paid amount | No | DB agreement row, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/get_status/:agreement_id` | Agreement status | No | DB agreement row, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/get_agreement_mode/:agreement_id` | Escrow/payroll mode | No | DB agreement row, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/get_employee_count/:agreement_id` | Payroll employee count | No | DB employees, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/get_employee/:agreement_id/:index` | Payroll employee address | No | DB employees, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/get_employee_salary/:agreement_id/:index` | Payroll employee salary | No | DB employees, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/get_dispute_status/:agreement_id` | Agreement dispute status | No | DB agreement row, then RPC fallback |
| `GET` | `/api/v1/agreement/:address/is_grace_period_active/:agreement_id` | Grace period status | No | RPC |
| `POST` | `/api/v1/prepare/agreement/:address/initialize` | Prepare agreement `initialize` call | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/create_time_based_agreement` | Prepare time-based agreement creation | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/create_milestone_agreement` | Prepare milestone agreement creation | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/create_payroll_agreement` | Prepare payroll agreement creation | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/add_employee` | Prepare payroll employee addition | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/fund_agreement` | Prepare agreement funding | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/add_milestone` | Prepare milestone addition | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/approve_milestone` | Prepare milestone approval | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/claim_milestone` | Prepare milestone claim | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/activate` | Prepare agreement activation | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/pause` | Prepare agreement pause | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/resume` | Prepare agreement resume | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/cancel` | Prepare agreement cancellation | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/finalize_grace_period` | Prepare grace-period finalization | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/raise_dispute` | Prepare dispute raise | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/agreement/:address/get_agreement_id_from_tx` | Extract agreement ID from a transaction receipt | No | RPC receipt and contract reads |
| `GET` | `/api/v1/agreement/:address/list/:user_address` | List indexed agreements for a user | No | DB only |
| `POST` | `/api/v1/agreement/:address/sync_index` | Operator sync scan for agreement IDs | No app auth | RPC; no persisted writes in current code |
| `POST` | `/api/v1/prepare/agreement/:address/resolve_dispute` | Prepare dispute resolution | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/claim_time_based` | Prepare time-based claim | Body session | RPC nonce/chain ID |
| `POST` | `/api/v1/prepare/agreement/:address/claim_payroll` | Prepare payroll claim | Body session | RPC nonce/chain ID |
| `GET` | `/api/v1/token/:token/balance/:owner` | ERC20 balance | No | RPC |
| `GET` | `/api/v1/token/:token/decimals` | ERC20 decimals | No | RPC |
| `GET` | `/api/v1/token/:token/symbol` | ERC20 symbol | No | RPC |
| `GET` | `/api/v1/escrow/:address/balance/:agreement_id` | Escrow balance read | No | RPC |
| `GET` | `/api/v1/escrow/:address/summary/:agreement_id` | Escrow UI summary | No | RPC |
| `GET` | `/api/v1/agreement/:address/summary/:agreement_id` | Agreement UI summary | No | RPC |
| `GET` | `/api/v1/indexed/agreements/:contract_address/user/:user_address` | Indexed agreements for a user | No | DB |
| `GET` | `/api/v1/indexed/agreement/:contract_address/:agreement_id` | Indexed agreement detail with related rows | No | DB |
| `GET` | `/api/v1/indexed/payments/user/:user_address` | Indexed payments for a user | No | DB |
| `GET` | `/api/v1/indexed/escrow/:contract_address/balance/:agreement_id` | Indexed escrow balance from events | No | DB |
| `GET` | `/api/v1/token/:address/allowance/:owner/:spender` | ERC20 allowance | No | RPC |
| `POST` | `/api/v1/prepare/token/:address/approve` | Prepare ERC20 approve call | Body session | RPC nonce/chain ID |
| `GET` | `/api/v1/transactions/:user_address` | Combined transaction feed | No | DB; may read agreement token over RPC with cache |
| `GET` | `/api/v1/transactions/:user_address/filtered` | Transaction feed with date filters | No | DB |
| `GET` | `/api/v1/notifications/:user_address` | User notification feed | No | DB |
| `GET` | `/api/v1/analytics/:user_address` | Monthly analytics for a user | No | DB |
| `POST` | `/api/v1/events/process_tx/:tx_hash` | Operator event decode/persist for one tx | No app auth | RPC receipts/ABIs; DB writes; idempotent inserts |
| `POST` | `/api/v1/events/process_batch` | Operator batch event decode/persist | No app auth | RPC receipts/ABIs; DB writes; max 50 tx hashes |
| `GET` | `/api/v1/indexer/status` | Indexer counts and latest rows | No app auth | DB diagnostics |
| `GET` | `/api/v1/indexer/user/:user_address/events` | Indexed event summary for a user | No | DB |
| `POST` | `/api/v1/reprocess-events/tx/:tx_hash` | Operator reprocess one tx via shared event processor | No app auth | RPC receipts/ABIs; DB writes |
| `POST` | `/api/v1/reprocess-events/status-changes` | Operator rename stored status-change events | No app auth | RPC receipts/ABIs; DB updates |
| `GET` | `/api/v1/diagnostics/events` | Operator event/table diagnostics | No app auth | DB raw aggregate queries |
| `POST` | `/api/v1/backfill/employee-events` | Operator backfill `EmployeeAdded` events | No app auth | DB reads/writes |
| `POST` | `/api/v1/backfill/milestone-events` | Operator backfill `MilestoneAdded` events | No app auth | DB reads/writes |
| `POST` | `/api/v1/contact/send-message` | Contact form submission | No | Strict limiter; sends email when configured |
| `GET` | `/api/v1/billing/profiles/:profileId` | Full billing profile | Feature flag only | `BILLING_ENABLED=true`; DB; 501 when disabled |
| `GET` | `/api/v1/billing/profiles/:profileId/general-information` | Billing identity/contact fields | Feature flag only | `BILLING_ENABLED=true`; DB; excludes sensitive fields; 501 when disabled |
| `GET` | `/api/v1/billing/profiles/:profileId/payment-methods` | Billing payment methods | Feature flag only | `BILLING_ENABLED=true`; DB; masked methods only; 501 when disabled |
| `GET` | `/api/v1/billing/profiles/:profileId/invoices` | Billing invoice history | Feature flag only | `BILLING_ENABLED=true`; DB; 501 when disabled |
| `GET` | `/api/v1/billing/profiles/:profileId/summary` | Billing reward-limit/spend summary | Feature flag only | `BILLING_ENABLED=true`; DB; 501 when disabled |

Billing responses use `{ "success": true, "data": ... }` or `{ "success": false, "error": "message" }`. Billing stores `taxId` and `dateOfBirth`, but route responses strip those fields.

---

### ABI source

By default the backend loads ABI from:

- `../Starknet-Contracts/target/release/starknet_contracts_PayrollEscrow.contract_class.json`
- `../Starknet-Contracts/target/release/starknet_contracts_WorkAgreement.contract_class.json`

### Signing model

- The backend **does not** hold private keys.
- Users first prove wallet ownership by signing a backend-issued challenge (`/auth/challenge` → sign typed data → `/auth/verify`).
- For contract mutations, the backend returns a prepared `call` + `nonce`; the frontend wallet/account should sign + execute.

### Sessions

After `/auth/verify` succeeds, the backend issues a session token with a **sliding expiry**. The lifetime is controlled by `SESSION_TTL_MS` (default 24 hours), and `/auth/verify` returns the remaining lifetime as `expires_in_ms`. A token is refreshed for another full TTL each time it is used on a successful `/auth/session/validate`, and expired tokens are rejected and purged (lazily on use, plus a periodic background sweep) so they cannot be replayed or leak memory.

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

2. Prepare a call (example: escrow funding), then execute from wallet:

```ts
async function fundAgreement({
  walletAddress,
  sessionToken,
  escrowAddress,
  agreementId,
  employer,
  amount,
}: {
  walletAddress: string;
  sessionToken: string;
  escrowAddress: string;
  agreementId: string;
  employer: string;
  amount: string; // decimal string
}) {
  const prepRes = await fetch(
    `${BACKEND}/prepare/escrow/${escrowAddress}/fund_agreement`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet_address: walletAddress,
        session_token: sessionToken,
        agreement_id: agreementId,
        employer,
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

### Security

The backend includes multiple security layers:

#### Helmet
[Helmet](https://helmetjs.github.io/) middleware is applied to all responses, setting secure HTTP headers including:
- `Content-Security-Policy`
- `Strict-Transport-Security` (HSTS)
- `X-Frame-Options`
- `X-Content-Type-Options`
- `X-XSS-Protection`
- And many others

This provides baseline protection against common web vulnerabilities.

#### Rate Limiting
[express-rate-limit](https://github.com/nfriedly/express-rate-limit) is configured with a tiered approach:

**Global Rate Limit** (applies to all `/api/v1` endpoints):
- Window: 15 minutes (configurable via `RATE_LIMIT_WINDOW_MS`)
- Max requests: 100 per window (configurable via `RATE_LIMIT_MAX`)
- Returns HTTP 429 with JSON error response

**Strict Rate Limit** (applies to sensitive endpoints):
- Endpoints: `/api/v1/auth/*` and `/api/v1/contact/*`
- Window: 5 minutes (configurable via `RATE_LIMIT_STRICT_WINDOW_MS`)
- Max requests: 10 per window (configurable via `RATE_LIMIT_STRICT_MAX`)
- Returns HTTP 429 with JSON error response
- **Why**: These endpoints are unauthenticated and have side effects:
  - `/auth/challenge` and `/auth/verify` trigger RPC calls to Starknet
  - `/contact/send-message` sends emails via nodemailer

This prevents:
- Denial-of-service (DoS) attacks via resource exhaustion
- Spam campaigns targeting the contact form
- Brute force attacks on authentication endpoints

#### Proxy Configuration
For deployments behind a reverse proxy or CDN (nginx, Cloudflare, AWS ALB, etc.):
- Set `TRUST_PROXY` to the number of trusted proxies (default: `1`)
- This ensures rate limits key on the real client IP via `X-Forwarded-For` header
- In containerized deployments, typical value is `1` (requests come through one proxy layer)
- See [Express trust proxy documentation](https://expressjs.com/en/guide/behind-proxies.html)

#### Configuration Examples

**Development** (relaxed limits):
```bash
RATE_LIMIT_WINDOW_MS=900000        # 15 minutes
RATE_LIMIT_MAX=100                 # 100 requests
RATE_LIMIT_STRICT_WINDOW_MS=300000 # 5 minutes
RATE_LIMIT_STRICT_MAX=10           # 10 requests
TRUST_PROXY=1
```

**Production with high traffic** (stricter limits):
```bash
RATE_LIMIT_WINDOW_MS=600000        # 10 minutes
RATE_LIMIT_MAX=50                  # 50 requests
RATE_LIMIT_STRICT_WINDOW_MS=300000 # 5 minutes
RATE_LIMIT_STRICT_MAX=5            # 5 requests
TRUST_PROXY=1  # or higher if behind multiple proxies
```

**Production with CDN** (e.g., Cloudflare):
```bash
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=100
RATE_LIMIT_STRICT_WINDOW_MS=300000
RATE_LIMIT_STRICT_MAX=10
TRUST_PROXY=1  # Cloudflare is the only proxy
```

Rate-limit responses are JSON, consistent with the error-handler format:
```json
{
  "error": "Too many requests, please try again later."
}
```

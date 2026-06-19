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
the core auth/codec modules. CI (`.github/workflows/ci.yml`) installs with pnpm on
Node.js 22, runs the build, optional lint, tests, and uploads the generated coverage
report on every pull request and push to `main`.

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

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

| Variable                                                       | Default                                         | Notes                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `STARKNET_RPC_URL`                                             | (required)                                      | Startup fails if unset                                                  |
| `NODE_ENV`                                                     | `development`                                   | `production` enforces the ABI path guard below                          |
| `PORT`                                                         | `4000`                                          |                                                                         |
| `CORS_ORIGIN`                                                  | `*`                                             | See the CORS Configuration section                                      |
| `POSTGRES_CONNECTION_STRING`                                   | `postgresql://localhost:5432/stellopay_indexer` |                                                                         |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`                      | `900000` / `100`                                | Global rate limiter                                                     |
| `RATE_LIMIT_STRICT_WINDOW_MS` / `RATE_LIMIT_STRICT_MAX`        | `300000` / `10`                                 | Auth and contact limiter                                                |
| `TRUST_PROXY`                                                  | `1`                                             | Number of proxies, or `true`                                            |
| `SHUTDOWN_DRAIN_TIMEOUT_MS`                                    | `10000`                                         | Graceful shutdown drain timeout                                         |
| `BILLING_ENABLED`                                              | `false`                                         | Only the literal `true` enables billing routes                          |
| `CONTACT_RECIPIENT_EMAIL`                                      | (none)                                          | Must be a valid email; required to deliver contact emails               |
| `ESCROW_CONTRACT_CLASS_JSON` / `AGREEMENT_CONTRACT_CLASS_JSON` | local `contracts/` files in dev                 | Required in production; startup fails if unset                          |
| `LOG_LEVEL`                                                    | `info`                                          | Specifies the minimum logging level                                     |
| `LOG_FORMAT`                                                   | `json`                                          | Use `json` for structured logging or `text` for readable console output |

### Observability

The application includes structured JSON access logging and request correlation to monitor traffic, latency, error rates, and trace requests across the frontend/backend boundary.

#### Request ID Correlation

Every request is assigned a unique `request_id` that flows through the entire request lifecycle:

- **Client-supplied IDs** (via `X-Request-Id` header) are validated, sanitised, and echoed back on the response header
  - Length-capped at 128 characters
  - Restricted to printable ASCII (no control chars, newlines, or carriage returns)
  - Invalid IDs are silently rejected; a server-generated UUID is used instead
- **Server-generated IDs** (when no header is provided) use `crypto.randomUUID()` to ensure uniqueness
- The ID is available on `res.locals.requestId` for all downstream handlers and middleware
- Every response includes the `X-Request-Id` header so clients can correlate their logs with server-side logs

**Example: correlating a 500 error**

Frontend logs report a failed request:

```
[app] POST /api/v1/escrow/0x123/deposit failed with status 500
Request-Id: req-client-001
```

Backend logs include the same correlation ID:

```json
{"level":"error","request_id":"req-client-001","message":"database connection failed",...}
```

**Client library integration** (e.g., in React/Vue):

```javascript
// Send a client-managed request ID to link frontend logs with backend
const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
const response = await fetch("/api/v1/escrow/0x123/deposit", {
  method: "POST",
  headers: {
    "X-Request-Id": requestId,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    /* ... */
  }),
});
console.log("[app]", requestId, "server echo:", response.headers.get("X-Request-Id"));
```

#### Access Logging

By default, the logger records:

- `method` — HTTP method (GET, POST, etc.)
- `path` — request path and query string
- `status` — HTTP response status
- `duration_ms` — request duration in milliseconds
- `request_id` — correlation ID (see above)
- `timestamp` — ISO 8601 timestamp

**JSON format** (structured, recommended for production):

```json
{
  "timestamp": "2024-06-20T15:51:29.123Z",
  "level": "info",
  "method": "POST",
  "path": "/api/v1/escrow/0x123/initialize",
  "status": 200,
  "duration_ms": 45.23,
  "request_id": "req-client-001"
}
```

**Text format** (human-readable, development):

```
[2024-06-20T15:51:29.123Z] INFO POST /api/v1/escrow/0x123/initialize 200 45.23ms [req-client-001]
```

**Configuration**:

```env
LOG_FORMAT=json  # Use 'json' for structured logging (production) or 'text' for console (development)
LOG_LEVEL=info   # Minimum logging level (debug, info, warn, error)
```

Sensitive fields such as request bodies and authorization tokens are **strictly omitted** from all access logs.
The noisy `/health` endpoint is **completely excluded** from logging to reduce noise.

#### Error Logging with Correlation

When an error occurs, the central error handler logs the full error context **with the request ID**:

```json
{
  "level": "error",
  "request_id": "req-client-001",
  "message": "Insufficient balance in escrow",
  "cause": "SmartContract validation failed",
  "stack": "Error: ...",
  "status": 400
}
```

The client also receives the correlation ID in the error response body:

```json
{
  "error": "Insufficient balance in escrow",
  "request_id": "req-client-001",
  "details": null
}
```

In development mode, the response includes `cause` and `stack` for debugging:

```json
{
  "error": "Insufficient balance in escrow",
  "request_id": "req-client-001",
  "cause": "SmartContract validation failed",
  "stack": "Error: ...\n    at ..."
}
```

#### Monitoring & Alerting Integration

To integrate with external monitoring systems (Datadog, New Relic, Grafana Loki, etc.):

1. **Set `LOG_FORMAT=json`** to emit structured JSON that most systems can ingest
2. **Parse the JSON stream** in your collector to extract metrics:
   - `status >= 500` → alert on server errors
   - `duration_ms > threshold` → alert on slow requests
   - Group errors by `request_id` to trace failure chains
3. **Use `request_id` as a unique trace identifier** across services:
   - Pass `X-Request-Id` header to downstream services
   - Include it in log aggregation queries for full request traces

### Database & health checks

The service uses a configured Postgres pool with explicit limits and timeouts. The connection string is validated at startup, and the pool listens for runtime errors without crashing the process.

- `GET /health` returns `{ "ok": true }` for process liveness.
- `GET /ready` runs `SELECT 1` against the database and returns:
  - `200` when the database responds successfully.
  - `503` when the database is unreachable or returns an error.

The implementation never logs the raw connection string. Any log output that references the DSN uses a masked value so credentials are not exposed.

#### Schema migrations & bootstrapping

Database schema migrations are managed using Drizzle Kit. To bootstrap or update the database schema:

1. Ensure you have configured `POSTGRES_CONNECTION_STRING` in your `.env` file (e.g. `POSTGRES_CONNECTION_STRING=postgresql://postgres:postgres@localhost:5432/stellopay_indexer`).
2. Run database migrations to create/update tables and indexes:
   ```bash
   pnpm db:migrate
   ```

To preview pending migration files without applying schema changes, run:

```bash
pnpm db:migrate -- --dry-run
```

If you make any changes to the database schema in `src/db/schema.ts`, you can generate new migration files by running:

```bash
pnpm db:generate
```

> [!IMPORTANT]
> The database schema is shared with the external Apibara indexer (see [INDEXER_INTEGRATION.md](INDEXER_INTEGRATION.md)). Ensure any schema modifications remain compatible with the indexer's write paths.

### Database & health checks

The service uses a configured Postgres pool with explicit limits and timeouts. The connection string is validated at startup, and the pool listens for runtime errors without crashing the process.

- `GET /health` returns `{ "ok": true }` for process liveness.
- `GET /ready` runs `SELECT 1` against the database and returns:
  - `200` when the database responds successfully.
  - `503` when the database is unreachable or returns an error.

The implementation never logs the raw connection string. Any log output that references the DSN uses a masked value so credentials are not exposed.

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

### Dependency Maintenance

Use pnpm as the source of truth for dependency installs and lockfile updates. The
canonical lockfile is `pnpm-lock.yaml`. The old npm lockfile has been removed and
`package-lock.json` is ignored so dependency changes do not create competing lock
state. `package.json` pins the expected pnpm version through the `packageManager`
field.

Dependabot checks the npm ecosystem weekly and groups minor/patch dependency
updates into a single pull request to reduce review noise. Security-sensitive
updates may still be opened separately by Dependabot.

Run the same audit gate locally before merging dependency changes:

```bash
pnpm install --frozen-lockfile
pnpm audit --prod --audit-level high
```

The CI workflow fails pull requests when production dependencies contain high or
critical advisories, then runs linting, build, and tests.

### Linting and formatting

The repository uses ESLint flat config and Prettier for local quality checks.

```bash
pnpm lint          # run the blocking ESLint gate
pnpm lint:all      # run ESLint and show non-blocking warnings
pnpm lint:fix      # run ESLint with safe fixes
pnpm format        # format files with Prettier
pnpm format:check  # check formatting without writing changes
```

The lint config enables `@typescript-eslint/no-unused-vars` and keeps the existing
`no-console` disable comments meaningful in the entrypoint and middleware files that
already annotate intentional startup, warning, and error logs.

### CORS Configuration

The server enforces strict CORS rules to prevent credential leakage:

| `CORS_ORIGIN` value          | `credentials` | Behaviour                                                           |
| ---------------------------- | ------------- | ------------------------------------------------------------------- |
| `http://localhost:3000`      | ✅ `true`     | Only that origin is allowed; unlisted origins are **rejected**      |
| `http://a.com,https://b.com` | ✅ `true`     | Both origins allowed; all others **rejected**                       |
| `*`                          | ❌ `false`    | All origins allowed, but cookies/auth headers are **not forwarded** |

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
- `POST /api/v1/auth/session/validate`

#### PayrollEscrow (view)

- `GET /api/v1/escrow/defaults`
- `GET /api/v1/escrow/:address/get_token`
- `GET /api/v1/escrow/:address/is_initialized`
- `GET /api/v1/escrow/:address/get_agreement_balance/:agreement_id`
- `GET /api/v1/escrow/:address/get_agreement_employer/:agreement_id`

#### PayrollEscrow (prepare to sign client-side)

- `POST /api/v1/prepare/escrow/:address/initialize`
- `POST /api/v1/prepare/escrow/:address/fund_agreement`
- `POST /api/v1/prepare/escrow/:address/release`
- `POST /api/v1/prepare/escrow/:address/refund_remaining`

#### WorkAgreement (view)

- `GET /api/v1/agreement/defaults`
- `GET /api/v1/agreement/:address/get_employer/:agreement_id`
- `GET /api/v1/agreement/:address/get_contributor/:agreement_id`
- `GET /api/v1/agreement/:address/get_token/:agreement_id`
- `GET /api/v1/agreement/:address/get_escrow`
- `GET /api/v1/agreement/:address/is_initialized`
- `GET /api/v1/agreement/:address/get_total_amount/:agreement_id`
- `GET /api/v1/agreement/:address/get_paid_amount/:agreement_id`
- `GET /api/v1/agreement/:address/get_status/:agreement_id`
- `GET /api/v1/agreement/:address/get_agreement_mode/:agreement_id`
- `GET /api/v1/agreement/:address/get_employee_count/:agreement_id`
- `GET /api/v1/agreement/:address/get_employee/:agreement_id/:index`
- `GET /api/v1/agreement/:address/get_employee_salary/:agreement_id/:index`
- `GET /api/v1/agreement/:address/get_dispute_status/:agreement_id`
- `GET /api/v1/agreement/:address/is_grace_period_active/:agreement_id`
- `GET /api/v1/agreement/:address/list/:user_address`

#### WorkAgreement (index helpers)

- `POST /api/v1/agreement/:address/get_agreement_id_from_tx`
- `POST /api/v1/agreement/:address/sync_index`

#### WorkAgreement (prepare to sign client-side)

- `POST /api/v1/prepare/agreement/:address/initialize`
- `POST /api/v1/prepare/agreement/:address/create_time_based_agreement`
- `POST /api/v1/prepare/agreement/:address/create_milestone_agreement`
- `POST /api/v1/prepare/agreement/:address/create_payroll_agreement`
- `POST /api/v1/prepare/agreement/:address/add_employee`
- `POST /api/v1/prepare/agreement/:address/fund_agreement`
- `POST /api/v1/prepare/agreement/:address/add_milestone`
- `POST /api/v1/prepare/agreement/:address/approve_milestone`
- `POST /api/v1/prepare/agreement/:address/claim_milestone`
- `POST /api/v1/prepare/agreement/:address/activate`
- `POST /api/v1/prepare/agreement/:address/pause`
- `POST /api/v1/prepare/agreement/:address/resume`
- `POST /api/v1/prepare/agreement/:address/cancel`
- `POST /api/v1/prepare/agreement/:address/finalize_grace_period`
- `POST /api/v1/prepare/agreement/:address/raise_dispute`
- `POST /api/v1/prepare/agreement/:address/resolve_dispute`
- `POST /api/v1/prepare/agreement/:address/claim_time_based`
- `POST /api/v1/prepare/agreement/:address/claim_payroll`

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

Unmatched `/api/v1` routes also return this JSON envelope with HTTP 404. The
response includes the requested HTTP method and normalized path in `data`, while
`/health` remains outside the API router and is not intercepted by the not-found
handler.

**Database tables added** (see `src/db/schema.ts`):

- `billing_profiles` — identity, address, limits
- `billing_payment_methods` — masked payment method references
- `billing_invoices` — invoice records

**Security note:** `taxId` and `dateOfBirth` are stored in the database but are **never returned** by any API endpoint. They must only be accessed through separately-authorised, audited internal processes.

---

### Indexed query parameters

Path and query parameters on the indexed and indexer-status routes are validated with Zod before any database call:

- Address parameters (`contract_address`, `user_address`) must be hex with an optional `0x` prefix, up to 64 hex characters; malformed values are rejected with `400`.
- `agreement_id` must be a numeric string.
- List endpoints (`/indexed/agreements/...`, `/indexed/payments/user/...`, and `/indexer/user/:user_address/events`) accept `limit` and `offset` query parameters. `limit` is clamped server-side to the range 1 to 100 (default 50) and `offset` to 0 or more, so a client cannot request an unbounded result set.

Validation failures return `400` with a structured `details` array of the Zod issues.

---

### ABI source

By default the backend loads ABI from:

- `../Starknet-Contracts/target/release/starknet_contracts_PayrollEscrow.contract_class.json`
- `../Starknet-Contracts/target/release/starknet_contracts_WorkAgreement.contract_class.json`

### Signing model

- The backend **does not** hold private keys.
- Users first prove wallet ownership by signing a backend-issued challenge (`/auth/challenge` → sign typed data → `/auth/verify`).
- For contract mutations, the backend returns a prepared `call` + `nonce`; the frontend wallet/account should sign + execute.

### Wallet-signature auth flow

Authentication is a wallet-ownership proof. The backend creates a short-lived
challenge, the frontend asks the wallet to sign the returned SNIP-12 typed data,
and the backend verifies the signature against the Starknet account contract
through the configured RPC provider before issuing a session token.

#### 1. Request a challenge

`POST /api/v1/auth/challenge`

Request:

```json
{
  "address": "0xWALLET_ADDRESS"
}
```

Response:

```json
{
  "address": "0xWALLET_ADDRESS",
  "nonce": "0xRANDOM_16_BYTE_NONCE",
  "expires_in_ms": 300000,
  "chain_id": "0xCHAIN_ID_FELT",
  "typed_data": {
    "types": {
      "StarknetDomain": [
        { "name": "name", "type": "felt" },
        { "name": "version", "type": "felt" },
        { "name": "chainId", "type": "felt" },
        { "name": "revision", "type": "felt" }
      ],
      "Challenge": [
        { "name": "action", "type": "felt" },
        { "name": "wallet", "type": "felt" },
        { "name": "nonce", "type": "felt" }
      ]
    },
    "primaryType": "Challenge",
    "domain": {
      "name": "StelloPay",
      "version": "1",
      "chainId": "SN_SEPOLIA",
      "revision": "1"
    },
    "message": {
      "action": "LOGIN",
      "wallet": "0xWALLET_ADDRESS",
      "nonce": "0xRANDOM_16_BYTE_NONCE"
    }
  }
}
```

`expires_in_ms` is the remaining challenge lifetime in milliseconds. Challenges
currently live for five minutes (`300000` ms) and are stored in process memory.
The server enforces this expiry; clients should treat the value as display or
retry guidance, not as an authority to extend the challenge lifetime.

`chain_id` is the raw chain ID returned by the configured Starknet RPC provider.
The `typed_data` object is Starknet SNIP-12 typed data, similar in shape to
EIP-712: it declares domain fields, a primary type, and the message fields that
the wallet signs. `typed_data.domain.chainId` is the decoded short-string label,
for example `SN_SEPOLIA` on Starknet Sepolia. Sign exactly the returned
`typed_data`; do not reconstruct it with a different chain ID, nonce, domain, or
message.

Safe challenge request:

```bash
curl -sS http://localhost:4000/api/v1/auth/challenge \
  -H 'content-type: application/json' \
  --data '{"address":"0xWALLET_ADDRESS"}'
```

#### 2. Sign typed data and verify

The frontend passes `typed_data` to the connected Starknet wallet. The backend
does not receive or need a private key.

`POST /api/v1/auth/verify`

Request:

```json
{
  "address": "0xWALLET_ADDRESS",
  "signature": ["0xSIGNATURE_PART_0", "0xSIGNATURE_PART_1", "0xOPTIONAL_SIGNATURE_PART_2"]
}
```

Response:

```json
{
  "ok": true,
  "address": "0xWALLET_ADDRESS",
  "session_token": "SESSION_TOKEN",
  "expires_in_ms": 86400000
}
```

`signature` is an array of felts encoded as strings. It must contain at least two
items, but it is intentionally variable length because Starknet wallets and
account contracts do not all emit exactly two signature elements. Send the array
returned by the wallet without truncating or padding it.

`expires_in_ms` in the verify response is the session lifetime in milliseconds.
It is controlled by `SESSION_TTL_MS` and defaults to 24 hours (`86400000` ms).
Session TTL enforcement is server-side, following the fix tracked in
[#41](https://github.com/Stellopay/stellopay-backend/issues/41); do not trust a
client-reported timestamp or cached expiry as proof that a session is still
valid. The used challenge is cleared after successful verification.

If the challenge is missing or expired, `/auth/verify` returns `400`:

```json
{
  "error": "No active challenge (or expired). Call /auth/challenge again."
}
```

If the wallet signature does not validate through the Starknet account contract,
`/auth/verify` returns `401`:

```json
{
  "error": "Invalid signature"
}
```

Safe verify request shape with placeholder values:

```bash
curl -sS http://localhost:4000/api/v1/auth/verify \
  -H 'content-type: application/json' \
  --data '{
    "address": "0xWALLET_ADDRESS",
    "signature": [
      "0xSIGNATURE_PART_0",
      "0xSIGNATURE_PART_1"
    ]
  }'
```

#### 3. Validate a session

`POST /api/v1/auth/session/validate`

Request:

```json
{
  "address": "0xWALLET_ADDRESS",
  "session_token": "SESSION_TOKEN"
}
```

Response:

```json
{
  "ok": true,
  "address": "0xWALLET_ADDRESS"
}
```

Invalid, expired, unknown, or wrong-address tokens return `401`:

```json
{
  "ok": false,
  "error": "Invalid session"
}
```

Safe validation request shape with placeholder values:

```bash
curl -sS http://localhost:4000/api/v1/auth/session/validate \
  -H 'content-type: application/json' \
  --data '{
    "address": "0xWALLET_ADDRESS",
    "session_token": "SESSION_TOKEN"
  }'
```

Sessions have a sliding expiry. A successful `/auth/session/validate` refreshes
the token for another full `SESSION_TTL_MS`, although the validation response
does not include the refreshed expiry. Expired tokens are rejected and purged
lazily on use, with a periodic background sweep for tokens that are never used
again.

Contract prepare routes currently validate sessions from the JSON request body
with `wallet_address` and `session_token`. Middleware-protected routes use the
same session store but expect `Authorization: Bearer <session_token>` plus an
`x-user-address` header.

Challenges and sessions are both in-memory only. Restarting the server clears
all outstanding challenges and session tokens, so clients should handle
`401 Invalid session` by starting the challenge → verify flow again.

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

2. Prepare a call (example: funding an escrow agreement), then execute from wallet:

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
  const prepRes = await fetch(`${BACKEND}/prepare/escrow/${escrowAddress}/fund_agreement`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet_address: walletAddress,
      session_token: sessionToken,
      agreement_id: agreementId,
      employer,
      amount,
    }),
  });
  const prep = await prepRes.json(); // { call, nonce, chain_id, wallet_address }

  const conn = await connect();
  if (!conn?.account) throw new Error("Wallet not connected");

  // Wallet signs + sends the transaction directly
  return await conn.account.execute(prep.call, { nonce: prep.nonce });
}
```

### Security

The backend includes multiple security layers:

#### Protected endpoints

Mutating endpoints and backend administration routes require session authentication. A bearer token (session token) and an `x-user-address` header are required. Some routes are strictly limited to administrators defined in the `ADMIN_ADDRESSES` environment variable.

**Authenticated Endpoints (`requireAuth`)**

- `POST /api/v1/events/process_tx/:tx_hash`
- `POST /api/v1/events/process_batch`

**Admin Endpoints (`requireAuth` + `requireAdmin`)**

- `POST /api/v1/backfill/employee-events`
- `POST /api/v1/backfill/milestone-events`
- `POST /api/v1/reprocess-events/tx/:tx_hash`
- `POST /api/v1/reprocess-events/status-changes`
- `GET /api/v1/diagnostics/events`

_Note: Indexed reading routes remain public because they only expose aggregated on-chain data and do not trigger remote RPC calls._

#### Operator diagnostics

`GET /api/v1/diagnostics/events` is operator-only. The whole diagnostics router is gated by `requireAuth` + `requireAdmin`, so only an authenticated address listed in `ADMIN_ADDRESSES` can reach it.

- It returns **aggregate counts** (event-type counts and per-table totals) for operators.
- The `poolStats` object reports the Postgres pool's point-in-time `total`, `idle`, `active`, and `waiting` connection counts without exposing connection details.
- The recent-activity list is **redacted** to `event_type` and `created_at` only. Transaction hashes and agreement IDs are never returned, since the aggregate counts already convey volume and the raw identifiers aid reconnaissance.
- Every query is static SQL with no request input, so there is no injection surface.

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

#### Limiter Factory

All limiters are built by a single factory, `makeLimiter`, in
[`src/middleware/rate-limit.ts`](src/middleware/rate-limit.ts). This removes the
duplicated `keyGenerator`/`handler`/`message` wiring that previously lived inline
and gives the app one place to tune limits and swap the backing store:

```ts
import { makeLimiter } from "./middleware/rate-limit.js";

const adminLimiter = makeLimiter({
  name: "admin", // label for docs/debugging and future shared stores
  windowMs: 60_000, // sliding window length
  max: 20, // max requests per window, per client IP
  message: "Too many admin requests, please try again later.", // optional
  skip: (req) => req.path === "/health", // optional bypass predicate
});

app.use("/api/v1/admin", adminLimiter);
```

Every limiter shares the same client-IP key generator and emits the same JSON
`429` envelope (`{ "error": string }`), so adding a new named limiter for
write/admin endpoints is a one-liner that cannot drift from the others.

**Security:** the shared key generator keys on `req.ip`, which honours the
Express `trust proxy` setting (`TRUST_PROXY`). When `trust proxy` is unset, a
forged `X-Forwarded-For` header is ignored and the direct socket IP is used —
clients cannot spoof the rate-limit key.

#### Store Limitation and Shared (Redis) Store Seam

The factory uses `express-rate-limit`'s **default in-memory store**. Counters
live in the process heap, which means:

- **Not shared across instances** — each replica enforces its own counts, so
  behind a load balancer the effective limit scales with the number of
  instances.
- **Resets on restart/redeploy** — counters are lost, briefly relaxing
  enforcement.

For multi-instance deployments, replace the store with a shared backend (e.g.
Redis via [`rate-limit-redis`](https://www.npmjs.com/package/rate-limit-redis)).
`makeLimiter` is the single seam for this: construct a shared `store` and pass it
to the `rateLimit` call inside the factory (see the marked `store` comment in
[`src/middleware/rate-limit.ts`](src/middleware/rate-limit.ts)). No call sites
change.

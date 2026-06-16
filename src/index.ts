import express from "express";
import cors from "cors";
import { env } from "./config.js";
import { escrowRouter } from "./routes/escrow.js";
import { agreementRouter } from "./routes/agreement.js";
import { authRouter } from "./routes/auth.js";
import { systemRouter } from "./routes/system.js";
import { readRouter } from "./routes/read.js";
import { indexedRouter } from "./routes/indexed.js";
import { tokenRouter } from "./routes/token.js";
import { transactionsRouter } from "./routes/transactions.js";
import { notificationsRouter } from "./routes/notifications.js";
import { analyticsRouter } from "./routes/analytics.js";
import { eventsRouter } from "./routes/events.js";
import { indexerStatusRouter } from "./routes/indexer-status.js";
import { reprocessEventsRouter } from "./routes/reprocess-events.js";
import { diagnosticsRouter } from "./routes/diagnostics.js";
import { backfillEventsRouter } from "./routes/backfill-events.js";
import { contactRouter } from "./routes/contact.js";
import { billingRouter } from "./routes/billing.js";

const app = express();

// eslint-disable-next-line no-console
console.log("[config] STARKNET_RPC_URL =", env.STARKNET_RPC_URL);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
// The CORS spec forbids combining credentials:true with a wildcard origin.
// When CORS_ORIGIN="*" we serve public (credential-less) responses.
// For an explicit allowlist we use a custom callback that rejects any origin
// NOT on the list — no silent reflection of arbitrary origins.
// ---------------------------------------------------------------------------
const corsOriginValue = env.CORS_ORIGIN.trim();
const isWildcard = corsOriginValue === "*";

if (isWildcard && env.NODE_ENV === "production") {
  // eslint-disable-next-line no-console
  console.warn(
    `[cors] SECURITY WARNING: CORS_ORIGIN='*' is set in production (NODE_ENV=${env.NODE_ENV}). ` +
      `Credentials will be disabled. Set CORS_ORIGIN to an explicit comma-separated allowlist for authenticated endpoints.`,
  );
} else if (isWildcard) {
  // eslint-disable-next-line no-console
  console.warn(
    `[cors] Wildcard origin '*' detected — Access-Control-Allow-Credentials is disabled. ` +
      `Never combine wildcard origins with credentials in production.`,
  );
}

// Build the allowed-origins list (empty when wildcard).
const allowedOrigins = isWildcard
  ? []
  : corsOriginValue
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);

// The origin handler:
//  - Wildcard → pass `true` to cors (no credentials attached).
//  - Allowlist → custom callback that only approves listed origins and
//    explicitly rejects everything else (no reflection of unknown origins).
const corsOriginHandler: cors.CorsOptions["origin"] = isWildcard
  ? true
  : (origin, callback) => {
      // Allow server-to-server / same-origin requests (no Origin header).
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Reject unknown origins with a clear error — do NOT reflect them.
      callback(new Error(`[cors] Origin '${origin}' is not in the allowlist`));
    };

app.set("trust proxy", 1);

app.use(
  cors({
    origin: corsOriginHandler,
    credentials: !isWildcard, // never combine wildcard + credentials
  }),
);
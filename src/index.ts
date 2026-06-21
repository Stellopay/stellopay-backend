import express from "express";
import cors from "cors";
import helmet from "helmet";
import { ZodError } from "zod";
import { env } from "./config.js";
import { makeLimiter } from "./middleware/rate-limit.js";
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
import { apiV1NotFoundHandler } from "./routes/not-found.js";
import { checkDbHealth, closePool } from "./db/index.js";
import { setupGracefulShutdown } from "./shutdown.js";
import { accessLogMiddleware } from "./middleware/access-log.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { provider } from "./starknet/client.js";

export const app = express();

// eslint-disable-next-line no-console
console.log("[config] STARKNET_RPC_URL =", env.STARKNET_RPC_URL);

// Mount request-ID middleware first so every downstream handler and logger
// can read res.locals.requestId and every response carries X-Request-Id.
app.use(requestIdMiddleware);

// Apply access log middleware early
app.use(accessLogMiddleware);

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

// Set trust proxy for correct client IP detection in rate limiting.
// Parse TRUST_PROXY env var - can be a number, "true", or comma-separated list.
let trustProxyValue: string | number | string[] | boolean = env.TRUST_PROXY;
if (env.TRUST_PROXY === "true") {
  trustProxyValue = true;
} else if (/^\d+$/.test(env.TRUST_PROXY)) {
  trustProxyValue = parseInt(env.TRUST_PROXY, 10);
} else if (env.TRUST_PROXY.includes(",")) {
  trustProxyValue = env.TRUST_PROXY.split(",").map((s) => s.trim());
}
app.set("trust proxy", trustProxyValue);

// Security: Add Helmet headers
app.use(helmet());

// Apply CORS
app.use(
  cors({
    origin: corsOriginHandler,
    credentials: !isWildcard, // never combine wildcard + credentials
  }),
);
app.use(express.json({ limit: "1mb" }));

// Rate limiting: limiters are built via the shared factory so the
// keyGenerator (IP, honouring trust proxy) and JSON 429 envelope stay
// consistent. See src/middleware/rate-limit.ts for the in-memory store
// limitation and the shared-store (Redis) seam.

// Global limiter (looser) — applied to all /api routes; health probes are
// mounted outside /api and do not pass through this limiter.
const globalLimiter = makeLimiter({
  name: "global",
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  message: "Too many requests, please try again later.",
  // Keep this predicate for future global mounts that include probe routes.
  skip: (req) => req.path === "/health" || req.path === "/ready",
});

// Strict limiter for unauthenticated, side-effecting auth and contact endpoints.
const strictLimiter = makeLimiter({
  name: "strict",
  windowMs: env.RATE_LIMIT_STRICT_WINDOW_MS,
  max: env.RATE_LIMIT_STRICT_MAX,
  message: "Too many requests from this IP, please try again later.",
});

// Apply global rate limiter to all API routes
app.use("/api/", globalLimiter);

app.get("/health", (_req, res) => res.json({ ok: true }));

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("readiness check timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

app.get("/ready", async (_req, res) => {
  const [database, starknetRpc] = await Promise.allSettled([
    checkDbHealth(),
    withTimeout(provider.getChainId(), 1_500),
  ]);

  const dependencies = {
    database: database.status === "fulfilled" && database.value ? "up" : "down",
    starknetRpc: starknetRpc.status === "fulfilled" ? "up" : "down",
  };
  const ok = dependencies.database === "up" && dependencies.starknetRpc === "up";

  res.status(ok ? 200 : 503).json({ ok, dependencies });
});

app.use("/api/v1", escrowRouter);
app.use("/api/v1", agreementRouter);
// Apply strict rate limiting to auth endpoint
app.use("/api/v1/auth", strictLimiter);
app.use("/api/v1", authRouter);
app.use("/api/v1", systemRouter);
app.use("/api/v1", readRouter);
app.use("/api/v1", indexedRouter);
app.use("/api/v1", tokenRouter);
app.use("/api/v1", transactionsRouter);
app.use("/api/v1", notificationsRouter);
app.use("/api/v1", analyticsRouter);
app.use("/api/v1", eventsRouter);
app.use("/api/v1", indexerStatusRouter);
app.use("/api/v1", reprocessEventsRouter);
app.use("/api/v1", diagnosticsRouter);
app.use("/api/v1", backfillEventsRouter);
// Apply strict rate limiting to contact endpoint
app.use("/api/v1/contact", strictLimiter);
app.use("/api/v1", contactRouter);
app.use("/api/v1", billingRouter);
app.use("/api/v1", apiV1NotFoundHandler);

// Basic error handler
app.use(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const requestId: string | undefined = res.locals.requestId;
    // eslint-disable-next-line no-console
    console.error("[api] error", {
      request_id: requestId,
      message: err?.message,
      cause: err?.cause,
      stack: err?.stack,
      issues: err?.issues,
    });
    // Zod validation errors are client errors: surface them as 400 with the
    // structured issue list rather than the default 500.
    const isZodError = err instanceof ZodError;
    const status = isZodError ? 400 : typeof err?.status === "number" ? err.status : 500;
    res.status(status).json({
      error: isZodError ? "Validation failed" : (err?.message ?? "Internal error"),
      request_id: requestId,
      details: err?.issues ?? undefined,
      ...(env.NODE_ENV === "development"
        ? {
            cause: err?.cause?.message ?? err?.cause ?? undefined,
            stack: err?.stack,
          }
        : {}),
    });
  },
);

if (process.env.NODE_ENV !== "test") {
  const server = app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`stellopay-backend listening on :${env.PORT}`);
  });

  // Setup graceful shutdown handling
  setupGracefulShutdown(server, closePool, env.SHUTDOWN_DRAIN_TIMEOUT_MS);
}

import express from "express";
import { initLogger } from "./utils/logger.js";
import cors from "cors";
import { resolveCorsConfig } from "./utils/cors.js";
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
import { checkDbHealth, closePool, waitForDbReadiness } from "./db/index.js";
import { dbReadinessMiddleware, setApplicationReady } from "./middleware/db-readiness.js";
import { setupGracefulShutdown } from "./shutdown.js";
import { accessLogMiddleware } from "./middleware/access-log.js";
import { requestIdMiddleware } from "./middleware/request-id.js";

export const app = express();
initLogger();


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
// resolveCorsConfig enforces environment-aware allow-list policy:
//  - development (or NODE_ENV unset): permissive wildcard default when
//    CORS_ORIGIN is not provided — a warning is logged at startup.
//  - non-development: CORS_ORIGIN MUST be set to an explicit, non-wildcard
//    comma-separated list of trusted origins; absence or "*" causes a fatal
//    startup error so the API never serves authenticated routes insecurely.
// ---------------------------------------------------------------------------
const { originHandler: corsOriginHandler, credentials: corsCredentials } = resolveCorsConfig(
  env.CORS_ORIGIN,
  env.NODE_ENV,
);

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

app.use(
  cors({
    origin: corsOriginHandler,
    credentials: corsCredentials,
  }),
);
app.use(express.json({ limit: "1mb" }));

app.use(dbReadinessMiddleware);

// Rate limiting: limiters are built via the shared factory so the
// keyGenerator (IP, honouring trust proxy) and JSON 429 envelope stay
// consistent. See src/middleware/rate-limit.ts for the in-memory store
// limitation and the shared-store (Redis) seam.

// Global limiter (looser) — applied to all /api routes; /health is exempt.
const globalLimiter = makeLimiter({
  name: "global",
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  message: "Too many requests, please try again later.",
  // Don't count /health requests against the rate limit.
  skip: (req) => req.path === "/health",
});

// Strict limiter for unauthenticated, side-effecting auth endpoints.
const strictLimiter = makeLimiter({
  name: "strict",
  windowMs: env.RATE_LIMIT_STRICT_WINDOW_MS,
  max: env.RATE_LIMIT_STRICT_MAX,
  message: "Too many requests from this IP, please try again later.",
});

// Contact form limiter (stricter) - prevents spam on the public contact form.
const contactLimiter = makeLimiter({
  name: "contact",
  windowMs: env.RATE_LIMIT_CONTACT_WINDOW_MS,
  max: env.RATE_LIMIT_CONTACT_MAX,
  message: "Too many contact form submissions. Please try again later.",
});

// Apply global rate limiter to all API routes
app.use("/api/", globalLimiter);

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/ready", async (_req, res) => {
  const isReady = await checkDbHealth();
  res.status(isReady ? 200 : 503).json(isReady ? { ok: true } : { ok: false });
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
// Apply contact-specific rate limiting to contact endpoint
app.use("/api/v1/contact", contactLimiter);
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
    const status = isZodError
      ? 400
      : typeof err?.status === "number"
        ? err.status
        : 500;
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

  void (async () => {
    await waitForDbReadiness();
    setApplicationReady(true);
    // eslint-disable-next-line no-console
    console.log("[startup] Database ready — serving traffic");
  })();
}

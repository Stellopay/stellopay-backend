import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
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

// ── Proxy trust ────────────────────────────────────────────────────────────
// Required so rate limiters key on the real client IP behind a reverse proxy.
app.set("trust proxy", 1);

// ── Security headers (Helmet) ──────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────
// Wildcard ("*") and credentials:true are mutually exclusive per the CORS spec.
// When a wildcard is configured we serve CORS without credentials.
const corsOriginValue = env.CORS_ORIGIN.trim();
const isWildcard = corsOriginValue === "*";

if (isWildcard && env.NODE_ENV === "production") {
  // eslint-disable-next-line no-console
  console.warn(
    "[cors] WARNING: CORS_ORIGIN='*' is set in production. " +
      "Credentials will be disabled. Set an explicit allowlist for authenticated endpoints.",
  );
}

const allowedOrigins: string[] = isWildcard
  ? []
  : corsOriginValue
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);

const corsOriginHandler: cors.CorsOptions["origin"] = isWildcard
  ? true
  : (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' is not in the allowlist`));
    };

app.use(
  cors({
    origin: corsOriginHandler,
    credentials: !isWildcard,
  }),
);

// ── Rate limiting ──────────────────────────────────────────────────────────
const rateLimitResponse = (req: express.Request, res: express.Response) => {
  res.status(429).json({ error: "Too many requests, please try again later." });
};

// Global limiter: 60 req / window (default 60s) per IP
const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitResponse,
});

// Strict limiter for auth endpoints: 10 req / window per IP
const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitResponse,
});

// Contact form limiter: 5 req / window per IP
const contactLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.CONTACT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitResponse,
});

app.use(globalLimiter);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Apply stricter limiters to sensitive route groups before mounting routers
app.use("/api/v1/auth", authLimiter);
app.use("/api/v1/contact", contactLimiter);

app.use("/api/v1", escrowRouter);
app.use("/api/v1", agreementRouter);
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
app.use("/api/v1", contactRouter);
app.use("/api/v1", billingRouter);

// Basic error handler
app.use(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error("[api] error", {
      message: err?.message,
      cause: err?.cause,
      stack: err?.stack,
      issues: err?.issues,
    });
    const status = typeof err?.status === "number" ? err.status : 500;
    res.status(status).json({
      error: err?.message ?? "Internal error",
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

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`stellopay-backend listening on :${env.PORT}`);
});

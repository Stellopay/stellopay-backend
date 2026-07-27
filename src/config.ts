import dotenv from "dotenv";
import { z } from "zod";
import path from "node:path";
import { parseStarknetRpcUrls } from "./starknet/rpc-urls.js";

dotenv.config();

export const EnvSchema = z
  .object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: z.coerce.number().int().positive().optional().default(4000),
  // CORS_ORIGIN — comma-separated list of allowed origins.
  // In development, defaults to "*" (permissive) when unset.
  // In non-development (staging/production), there is NO default: the variable
  // must be set to an explicit allowlist. A wildcard is rejected in non-dev
  // environments via the superRefine below.
  CORS_ORIGIN: z.string().optional(),

  // Observability configuration
  LOG_LEVEL: z.string().optional().default("info"),
  LOG_FORMAT: z.string().optional().default("json"),
  LOG_REDACT_QUERY_PARAMS: z
    .string()
    .optional()
    .default("token,signature,secret")
    .transform((s) =>
      s
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.length > 0),
    ),

  // Required: Starknet RPC URL(s), v0_8 — comma-separated for failover (HTTPS only)
  // Provide via environment variable (e.g. in `.env` or inline `STARKNET_RPC_URL=... pnpm dev`)
  STARKNET_RPC_URL: z.string().min(1),
  // Users sign transactions client-side; backend does not require account keys.

  PAYROLL_ESCROW_ADDRESS: z.string().optional(),
  WORK_AGREEMENT_ADDRESS: z.string().optional(),

  // ABI file paths - should be absolute paths or relative to project root
  // In production, these should point to the actual location of the contract class JSON files
  ESCROW_CONTRACT_CLASS_JSON: z.string().optional(),
  AGREEMENT_CONTRACT_CLASS_JSON: z.string().optional(),

  // Database connection for indexed data (required for startup and health checks)
  POSTGRES_CONNECTION_STRING: z.string().url(),
  // Pool tuning knobs for the Postgres connection pool
  DB_POOL_MAX: z.coerce.number().int().positive().optional().default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(30_000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(5_000),

  // Token addresses (optional, with defaults)
  TOKEN_STRK: z.string().optional(),
  TOKEN_USDC: z.string().optional(),
  TOKEN_USDT: z.string().optional(),
  // Token metadata cache lifetime (milliseconds) - default 5 minutes
  TOKEN_METADATA_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(5 * 60 * 1000),

  // Email configuration for contact form
  EMAIL_USER: z.string().optional(),
  EMAIL_PASSWORD: z.string().optional(),
  // Recipient for contact-form submissions (no personal address is hardcoded in source)
  CONTACT_RECIPIENT_EMAIL: z.string().email().optional(),

  // Rate limiting configuration
  // Global rate limit window (milliseconds) - default 15 minutes
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(15 * 60 * 1000),
  // Global rate limit max requests per window - default 100
  RATE_LIMIT_MAX: z.coerce.number().int().positive().optional().default(100),
  // Strict rate limit for auth/contact endpoints (milliseconds) - default 5 minutes
  RATE_LIMIT_STRICT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(5 * 60 * 1000),
  // Strict rate limit max requests per window - default 10
  RATE_LIMIT_STRICT_MAX: z.coerce.number().int().positive().optional().default(10),
  // Contact form rate limit window (milliseconds) - default 1 hour
  RATE_LIMIT_CONTACT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(60 * 60 * 1000),
  // Contact form rate limit max requests per window - default 3
  RATE_LIMIT_CONTACT_MAX: z.coerce.number().int().positive().optional().default(3),
  // Trust proxy for correct client IP detection (set to number of proxies or 'true' for single proxy)
  TRUST_PROXY: z.string().optional().default("1"),

  // Session token lifetime in milliseconds (sliding expiry) - default 24 hours
  SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(24 * 60 * 60 * 1000),

  // Absolute maximum session lifetime in milliseconds - default 7 days
  SESSION_MAX_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(7 * 24 * 60 * 60 * 1000),

  // Feature flag: set to "true" to enable billing profile endpoints.
  // When false (default) all /billing/* routes return 501 Not Implemented.
  BILLING_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),

  // Drain timeout for graceful shutdown (milliseconds) - default 10000 (10 seconds)
  SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(10000),

  // Comma-separated list of admin addresses
  ADMIN_ADDRESSES: z
    .string()
    .optional()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.length > 0),
    ),
  })
  .superRefine((data, ctx) => {
    const isDev = !data.NODE_ENV || data.NODE_ENV === "development";
    const origin = data.CORS_ORIGIN;

    if (isDev) {
      // Development: permissive wildcard default is fine — nothing to reject.
      return;
    }

    // Non-development: require an explicit, non-wildcard allowlist.
    if (!origin || origin.trim() === "" || origin.trim() === "*") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGIN"],
        message:
          `CORS_ORIGIN must be set to an explicit comma-separated allowlist of origins ` +
          `in non-development environments (NODE_ENV=${data.NODE_ENV}). ` +
          `A wildcard ('*') is not permitted outside of development because it ` +
          `cannot be combined with credentials and exposes authenticated endpoints ` +
          `to cross-origin requests from any domain.`,
      });
    }
  });

/** Resolve the effective CORS_ORIGIN value, applying the development wildcard default. */
const _rawEnv = EnvSchema.parse(process.env);

export const env = {
  ..._rawEnv,
  // Apply development default: when CORS_ORIGIN is unset in development, fall back to "*".
  CORS_ORIGIN:
    _rawEnv.CORS_ORIGIN ??
    (_rawEnv.NODE_ENV === "development" || !_rawEnv.NODE_ENV ? "*" : ""),
};

/** Ordered Starknet JSON-RPC endpoints (primary first) from STARKNET_RPC_URL. */
export const starknetRpcUrls = parseStarknetRpcUrls(env.STARKNET_RPC_URL);

// Resolve ABI paths - use provided paths or fallback to local contracts directory
// In production, these should be set as absolute paths or paths relative to the deployed location
export const abiPaths = {
  escrow:
    env.ESCROW_CONTRACT_CLASS_JSON ||
    (process.env.NODE_ENV === "production"
      ? null
      : path.resolve(
          process.cwd(),
          "contracts/starknet_contracts_PayrollEscrow.contract_class.json",
        )),
  agreement:
    env.AGREEMENT_CONTRACT_CLASS_JSON ||
    (process.env.NODE_ENV === "production"
      ? null
      : path.resolve(
          process.cwd(),
          "contracts/starknet_contracts_WorkAgreement.contract_class.json",
        )),
};

// Validate that ABI paths are set in production
if (process.env.NODE_ENV === "production") {
  if (!abiPaths.escrow || !abiPaths.agreement) {
    throw new Error(
      "ESCROW_CONTRACT_CLASS_JSON and AGREEMENT_CONTRACT_CLASS_JSON must be set in production environment",
    );
  }
}

export const defaults = {
  payrollEscrowAddress:
    env.PAYROLL_ESCROW_ADDRESS ??
    "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
  workAgreementAddress:
    env.WORK_AGREEMENT_ADDRESS ??
    "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
};

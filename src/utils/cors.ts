import type { CorsOptions } from "cors";

/**
 * @deprecated Use `buildCorsOriginHandler` instead. This helper is kept only
 * for backward compatibility and will be removed in a future cleanup.
 *
 * Parse CORS origin configuration into the format expected by the `cors` middleware.
 *
 * Supports comma-separated origin values with whitespace trimming.
 * The literal string `"*"` is returned as `true`, meaning the middleware reflects any origin.
 *
 * @param origin Raw CORS_ORIGIN configuration value
 */
export const parseCorsOrigin = (origin: string): string | string[] | boolean => {
  if (origin === "*") {
    return true;
  }

  const origins = origin
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  return origins.length === 1 ? origins[0] : origins;
};

/**
 * Build a safe CORS origin handler from a raw `CORS_ORIGIN` env value.
 *
 * Rules enforced:
 *  - `"*"` (wildcard) → **only** permitted in development (`nodeEnv === "development"`).
 *    In any other environment a wildcard causes an immediate `Error` to be thrown so
 *    the application refuses to start with an insecure configuration.
 *  - In development with wildcard: logs a warning and returns `{ originHandler: true,
 *    credentials: false }` (permissive, credential-less).
 *  - Explicit allowlist → custom callback that **only** approves listed origins.
 *    Origins NOT on the list are rejected with an error (no silent reflection).
 *
 * @param corsOriginEnv  Raw value of `CORS_ORIGIN` env variable.
 * @param nodeEnv        Value of `NODE_ENV` (defaults to `"development"`).
 * @returns `{ originHandler, credentials }` ready to spread into `cors()` options.
 * @throws {Error} When a wildcard is used outside of development.
 */
export const buildCorsOriginHandler = (
  corsOriginEnv: string,
  nodeEnv = "development",
): { originHandler: CorsOptions["origin"]; credentials: boolean } => {
  const value = corsOriginEnv.trim();
  const isWildcard = value === "*";
  const isDev = nodeEnv === "development";

  if (isWildcard && !isDev) {
    // Non-development: wildcard is never acceptable — refuse to start.
    throw new Error(
      `[cors] FATAL: CORS_ORIGIN='*' is not permitted in non-development environments ` +
        `(NODE_ENV=${nodeEnv}). ` +
        `Set CORS_ORIGIN to an explicit comma-separated allowlist of trusted origins. ` +
        `A wildcard cannot be combined with credentials and exposes authenticated endpoints ` +
        `to cross-origin requests from any domain.`,
    );
  }

  if (isWildcard) {
    // Development only: permissive wildcard with a clear startup warning.
    // eslint-disable-next-line no-console
    console.warn(
      `[cors] Wildcard origin '*' detected in development (NODE_ENV=${nodeEnv}). ` +
        `Access-Control-Allow-Credentials is disabled. ` +
        `Never use CORS_ORIGIN=* in staging or production.`,
    );
    return { originHandler: true, credentials: false };
  }

  const allowedOrigins = value
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  const originHandler: CorsOptions["origin"] = (origin, callback) => {
    // Allow same-origin / server-to-server requests (no Origin header).
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Reject unknown origins — do NOT reflect them.
    callback(new Error(`[cors] Origin '${origin}' is not in the allowlist`));
  };

  return { originHandler, credentials: true };
};

/**
 * Resolve the effective CORS configuration from environment variables.
 *
 * This is the **canonical entry-point** used by `src/index.ts`. It applies the
 * environment-aware allow-list policy:
 *
 * - **Development** (`NODE_ENV=development` or unset): if `CORS_ORIGIN` is not
 *   provided it falls back to `"*"` (permissive dev default). A warning is logged.
 * - **Non-development**: `CORS_ORIGIN` **must** be set to an explicit, non-wildcard
 *   comma-separated list of allowed origins. An empty value or `"*"` is rejected
 *   by throwing an `Error`, preventing the application from starting insecurely.
 *
 * @param corsOriginEnv  Raw value of the `CORS_ORIGIN` environment variable
 *                       (may be `undefined` when the variable is unset).
 * @param nodeEnv        Value of `NODE_ENV` (defaults to `"development"`).
 * @returns `{ originHandler, credentials }` ready to spread into `cors()` options.
 * @throws {Error} In non-development when `CORS_ORIGIN` is absent, empty, or `"*"`.
 */
export const resolveCorsConfig = (
  corsOriginEnv: string | undefined,
  nodeEnv = "development",
): { originHandler: CorsOptions["origin"]; credentials: boolean } => {
  const isDev = nodeEnv === "development";
  const raw = corsOriginEnv?.trim() ?? "";

  if (!raw || raw === "*") {
    if (isDev) {
      // Development: fall back to permissive wildcard with a warning.
      return buildCorsOriginHandler("*", nodeEnv);
    }

    // Non-development: deny by default — refuse to start without an explicit allowlist.
    throw new Error(
      `[cors] FATAL: CORS_ORIGIN is ${!raw ? "not set" : "set to wildcard '*'"} ` +
        `in a non-development environment (NODE_ENV=${nodeEnv}). ` +
        `Set CORS_ORIGIN to an explicit comma-separated allowlist of trusted origins ` +
        `(e.g. CORS_ORIGIN=https://app.stellopay.com). ` +
        `Wildcard CORS is incompatible with authenticated endpoints.`,
    );
  }

  return buildCorsOriginHandler(raw, nodeEnv);
};

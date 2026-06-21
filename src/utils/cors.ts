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
 *  - `"*"` (wildcard) → origin handler is `true`; `credentials` must be `false`.
 *  - Explicit allowlist → custom callback that **only** approves listed origins.
 *    Origins NOT on the list are rejected with an error (no silent reflection).
 *  - Logs a startup warning when wildcard is used in production.
 *
 * @param corsOriginEnv  Raw value of `CORS_ORIGIN` env variable.
 * @param nodeEnv        Value of `NODE_ENV` (used for production warning).
 * @returns `{ originHandler, credentials }` ready to spread into `cors()` options.
 */
export const buildCorsOriginHandler = (
  corsOriginEnv: string,
  nodeEnv = "development",
): { originHandler: CorsOptions["origin"]; credentials: boolean } => {
  const value = corsOriginEnv.trim();
  const isWildcard = value === "*";

  if (isWildcard && nodeEnv === "production") {
    // eslint-disable-next-line no-console
    console.warn(
      `[cors] SECURITY WARNING: CORS_ORIGIN='*' is set in production (NODE_ENV=${nodeEnv}). ` +
        `Credentials will be disabled. Set CORS_ORIGIN to an explicit comma-separated allowlist for authenticated endpoints.`,
    );
  } else if (isWildcard) {
    // eslint-disable-next-line no-console
    console.warn(
      `[cors] Wildcard origin '*' detected — Access-Control-Allow-Credentials is disabled. ` +
        `Never combine wildcard origins with credentials in production.`,
    );
  }

  if (isWildcard) {
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

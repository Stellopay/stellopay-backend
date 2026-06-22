import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config.js";
import * as schema from "./schema.js";

// Pool tuning shared across whichever connection string we end up using:
// bounded size plus idle/connection timeouts so a stuck DB can't exhaust the
// pool. Sourced from validated env config.
const poolTuning = {
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  query_timeout: env.DB_QUERY_TIMEOUT_MS,
};

function maskConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.username = "***";
    url.password = "***";
    return url.toString();
  } catch {
    return "<redacted-connection-string>";
  }
}

// Create connection pool with proper error handling.
let pool: Pool;
try {
  const connectionString = env.POSTGRES_CONNECTION_STRING;

  // Validate connection string format
  if (!connectionString || typeof connectionString !== "string") {
    console.warn("[db] POSTGRES_CONNECTION_STRING not set, database features will be unavailable");
    // Create a dummy pool that will fail gracefully
    pool = new Pool({
      connectionString: "postgresql://localhost:5432/stellopay_indexer",
      ...poolTuning,
    });
  } else {
    // Parse and validate the connection string
    const url = new URL(connectionString);
    // Ensure password is a string (even if empty)
    if (url.password === null || url.password === undefined) {
      url.password = "";
    }

    pool = new Pool({
      connectionString: url.toString(),
      ...poolTuning,
    });
  }
} catch (error) {
  console.error("[db] Failed to initialize connection pool", {
    message: error instanceof Error ? error.message : String(error),
  });
  // Fall back to a pool that will fail gracefully on use rather than at import.
  pool = new Pool({
    connectionString: "postgresql://localhost:5432/stellopay_indexer",
    ...poolTuning,
  });
}

pool.on("error", (error: Error & { code?: string }) => {
  console.error("[db] Unexpected pool error", {
    message: error.message,
    code: error.code,
    stack: error.stack,
  });
});

export const db = drizzle(pool, { schema });
export { schema };

/**
 * Checks whether the database is reachable with a lightweight probe.
 *
 * @returns `true` when `SELECT 1` succeeds, otherwise `false`.
 */
export async function checkDbHealth(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (error) {
    console.error("[db] Health check failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Closes the Postgres connection pool gracefully.
 */
export async function closePool(): Promise<void> {
  console.log("[db] Closing Postgres connection pool...");
  await pool.end();
  console.log("[db] Postgres connection pool closed.");
}

export { maskConnectionString };


import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config.js";
import * as schema from "./schema.js";

// Pool tuning shared across whichever connection string we end up using.
// Bounded size plus idle/connection timeouts keep a stuck DB from exhausting the pool.
const poolTuning = {
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
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

  if (!connectionString || typeof connectionString !== "string") {
    console.warn("[db] POSTGRES_CONNECTION_STRING not set, database features will be unavailable");
    pool = new Pool({
      connectionString: "postgresql://localhost:5432/stellopay_indexer",
      ...poolTuning,
    });
  } else {
    const url = new URL(connectionString);
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

/** Current utilization counters for the shared Postgres connection pool. */
export interface PoolStats {
  total: number;
  idle: number;
  active: number;
  waiting: number;
}

/**
 * Returns a point-in-time snapshot of the shared Postgres pool.
 *
 * The values come directly from `pg`'s read-only pool counters. No connection
 * details are included, and reading the snapshot does not acquire a client.
 */
export function getPoolStats(): PoolStats {
  const total = pool.totalCount;
  const idle = pool.idleCount;

  return {
    total,
    idle,
    active: total - idle,
    waiting: pool.waitingCount,
  };
}

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

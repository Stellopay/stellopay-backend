import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config.js";
import * as schema from "./schema.js";

const poolConfig = {
  connectionString: env.POSTGRES_CONNECTION_STRING,
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

const pool = new Pool(poolConfig);

pool.on("error", (error) => {
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


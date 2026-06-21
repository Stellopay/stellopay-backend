import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config.js";
// Import schema from local file
import * as schema from "./schema.js";

// Create connection pool with proper error handling
let pool: Pool;
try {
  const connectionString = env.POSTGRES_CONNECTION_STRING;

  // Validate connection string format
  if (!connectionString || typeof connectionString !== "string") {
    console.warn("[db] POSTGRES_CONNECTION_STRING not set, database features will be unavailable");
    // Create a dummy pool that will fail gracefully
    pool = new Pool({
      connectionString: "postgresql://localhost:5432/stellopay_indexer",
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
    });
  }
} catch (e) {
  console.error("[db] Failed to initialize database pool:", e);
  // Fallback to default
  pool = new Pool({
    connectionString: "postgresql://localhost:5432/stellopay_indexer",
  });
}

// Create drizzle instance
export const db = drizzle(pool, { schema });

// Export schema for use in routes
export { schema };

/**
 * Closes the Postgres connection pool gracefully.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    console.log("[db] Closing Postgres connection pool...");
    await pool.end();
    console.log("[db] Postgres connection pool closed.");
  }
}

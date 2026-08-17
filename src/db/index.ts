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

function createPool(connectionString: string | undefined, label: string, tuning = poolTuning): Pool {
  try {
    if (!connectionString) console.warn(`[db] ${label} connection string not set, using local fallback`);
    const url = new URL(connectionString ?? "postgresql://localhost:5432/stellopay_indexer");
    if (url.password === null || url.password === undefined) url.password = "";
    const createdPool = new Pool({ connectionString: url.toString(), ...tuning });
    createdPool.on("error", (error: Error & { code?: string }) => {
      console.error(`[db] Unexpected ${label} pool error`, {
        message: error.message,
        code: error.code,
        stack: error.stack,
      });
    });
    return createdPool;
  } catch (error) {
    console.error(`[db] Failed to initialize ${label} connection pool`, {
      message: error instanceof Error ? error.message : String(error),
    });
    return new Pool({
      connectionString: "postgresql://localhost:5432/stellopay_indexer",
      ...tuning,
    });
  }
}

const pool = createPool(env.POSTGRES_CONNECTION_STRING, "primary");
const readPool = env.POSTGRES_READ_REPLICA_CONNECTION_STRING
  ? createPool(env.POSTGRES_READ_REPLICA_CONNECTION_STRING, "read replica", {
      ...poolTuning,
      max: Math.max(1, Math.floor(env.DB_POOL_MAX / 2)),
    })
  : null;

export const db = drizzle(pool, { schema });
/** Read-only queries use the replica when configured, otherwise the primary. */
export const readDb = drizzle(readPool ?? pool, { schema });
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
  return getStatsForPool(pool);
}

/** Returns the replica pool snapshot, or the primary snapshot when disabled. */
export function getReadPoolStats(): PoolStats {
  return getStatsForPool(readPool ?? pool);
}

function getStatsForPool(activePool: Pool): PoolStats {
  const total = activePool.totalCount;
  const idle = activePool.idleCount;

  return {
    total,
    idle,
    active: total - idle,
    waiting: activePool.waitingCount,
  };
}

/** Result of a database health-check probe. */
export interface HealthCheckResult {
  /** true when SELECT 1 succeeds, false otherwise. */
  healthy: boolean;
  /** Round-trip time of the health-check query in milliseconds. */
  latencyMs: number;
  /** true when the query succeeded but exceeded the degraded-latency threshold. */
  degraded: boolean;
}

/**
 * Checks whether the database is reachable with a lightweight probe and
 * reports the round-trip latency.
 *
 * @returns An object with `healthy`, `latencyMs`, and `degraded` fields.
 *   - `healthy` is `true` when `SELECT 1` succeeds.
 *   - `latencyMs` is the query duration in milliseconds.
 *   - `degraded` is `true` when the query succeeded but took longer than
 *     `env.DB_HEALTH_DEGRADED_LATENCY_MS`.
 */
export async function checkDbHealth(): Promise<HealthCheckResult> {
  const start = performance.now();
  try {
    await pool.query("SELECT 1");
    const latencyMs = performance.now() - start;
    return {
      healthy: true,
      latencyMs: Math.round(latencyMs * 100) / 100,
      degraded: latencyMs >= env.DB_HEALTH_DEGRADED_LATENCY_MS,
    };
  } catch (error) {
    const latencyMs = performance.now() - start;
    console.error("[db] Health check failed", {
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(latencyMs * 100) / 100,
    });
    return {
      healthy: false,
      latencyMs: Math.round(latencyMs * 100) / 100,
      degraded: false,
    };
  }
}

export async function waitForDbReadiness(): Promise<void> {
  const maxAttempts = env.DB_CONNECTION_RETRY_MAX_ATTEMPTS ?? 5;
  const baseDelay = env.DB_CONNECTION_RETRY_BASE_DELAY_MS ?? 500;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await checkDbHealth();
    if (result.healthy) {
      return;
    }
    if (attempt < maxAttempts) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.warn(`[db] DB not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`[db] Unable to connect to database after ${env.DB_CONNECTION_RETRY_MAX_ATTEMPTS} attempts`);
}


/**
 * Closes the Postgres connection pool gracefully.
 */
export async function closePool(): Promise<void> {
  console.log("[db] Closing Postgres connection pool...");
  await pool.end();
  if (readPool && readPool !== pool) await readPool.end();
  console.log("[db] Postgres connection pool closed.");
}

export { maskConnectionString };

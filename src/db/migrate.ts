import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../migrations");

const connectionString =
  process.env.POSTGRES_CONNECTION_STRING ?? "postgresql://localhost:5432/stellopay_indexer";

const pool = new Pool({ connectionString });
const db = drizzle(pool);

console.log("[migrate] Running migrations from", migrationsFolder);

await migrate(db, { migrationsFolder });

console.log("[migrate] Done");
await pool.end();

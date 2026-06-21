import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config.js";

async function main() {
  const connectionString = env.POSTGRES_CONNECTION_STRING;
  if (!connectionString) {
    console.error("POSTGRES_CONNECTION_STRING is required to run migrations");
    process.exit(1);
  }

  console.log("Running database migrations...");
  const client = new pg.Client({ connectionString });
  await client.connect();

  const db = drizzle(client);

  // Apply migrations located in the src/db/migrations folder
  await migrate(db, { migrationsFolder: "./src/db/migrations" });

  console.log("Migrations applied successfully!");
  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

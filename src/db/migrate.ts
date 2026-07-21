import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import fs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { env } from "../config.js";

const MIGRATIONS_FOLDER = "./src/db/migrations";
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";
// Stable two-part key for the StelloPay ("Stel") migration ("Migr") lock namespace.
const MIGRATION_LOCK_KEYS = [0x5374656c, 0x4d696772];

interface MigrationJournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

function readMigrationJournal(migrationsFolder: string): MigrationJournal {
  const journal = JSON.parse(
    fs.readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"),
  ) as MigrationJournal;

  return journal;
}

export function getPendingMigrationFileNames(
  journalEntries: MigrationJournalEntry[],
  lastAppliedMigrationTimestamp: number | null,
) {
  return journalEntries
    .filter(
      (migration) =>
        lastAppliedMigrationTimestamp === null || lastAppliedMigrationTimestamp < migration.when,
    )
    .map((migration) => `${migration.tag}.sql`);
}

export async function getLastAppliedMigrationTimestamp(client: pg.Client) {
  let lastApplied: pg.QueryResult<{ created_at: string | number | null }>;

  try {
    lastApplied = await client.query(
      `select created_at from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" order by created_at desc limit 1`,
    );
  } catch (error) {
    if (error instanceof pg.DatabaseError && error.code === "42P01") {
      return null;
    }

    throw error;
  }

  const createdAt = lastApplied.rows[0]?.created_at;
  return createdAt === undefined || createdAt === null ? null : Number(createdAt);
}

export async function listPendingMigrationFileNames(client: pg.Client) {
  const journal = readMigrationJournal(MIGRATIONS_FOLDER);

  // Keep Drizzle's migration file validation and timestamp parsing in the dry-run path.
  readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

  const lastAppliedMigrationTimestamp = await getLastAppliedMigrationTimestamp(client);
  return getPendingMigrationFileNames(journal.entries, lastAppliedMigrationTimestamp);
}

export async function withMigrationLock<T>(client: pg.Client, runMigrations: () => Promise<T>) {
  await client.query("SELECT pg_advisory_lock($1, $2)", MIGRATION_LOCK_KEYS);

  try {
    return await runMigrations();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1, $2)", MIGRATION_LOCK_KEYS);
  }
}

export async function main(argv = process.argv, connectionString = env.POSTGRES_CONNECTION_STRING) {
  if (!connectionString) {
    console.error("POSTGRES_CONNECTION_STRING is required to run migrations");
    process.exitCode = 1;
    return;
  }

  const dryRun = argv.includes("--dry-run");
  if (!dryRun) {
    console.log("Running database migrations...");
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    if (dryRun) {
      const pendingMigrations = await listPendingMigrationFileNames(client);

      if (pendingMigrations.length === 0) {
        console.log("No pending migrations.");
      } else {
        console.log("Pending migrations:");
        for (const migration of pendingMigrations) {
          console.log(migration);
        }
      }

      return;
    }

    await withMigrationLock(client, async () => {
      const db = drizzle(client);

      // Apply migrations located in the src/db/migrations folder
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    });

    console.log("Migrations applied successfully!");
  } finally {
    await client.end();
  }
}

export function isMainModule(argvPath: string | undefined, moduleUrl: string) {
  return Boolean(argvPath && moduleUrl === pathToFileURL(resolve(argvPath)).href);
}

export function handleMigrationFailure(error: unknown) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  void main().catch(handleMigrationFailure);
}

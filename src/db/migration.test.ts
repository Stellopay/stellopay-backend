import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import {
  getLastAppliedMigrationTimestamp,
  getPendingMigrationFileNames,
  handleMigrationFailure,
  isMainModule,
  main,
} from "./migrate.js";

vi.mock("drizzle-orm/node-postgres/migrator", () => ({
  migrate: vi.fn(),
}));

const describeDbMigration = process.env.RUN_DB_MIGRATION_TESTS === "1" ? describe : describe.skip;

describe("migration dry-run helpers", () => {
  it("lists migrations newer than the last applied migration timestamp", () => {
    const pendingMigrations = getPendingMigrationFileNames(
      [
        { idx: 0, when: 100, tag: "0000_initial" },
        { idx: 1, when: 200, tag: "0001_add_sessions" },
        { idx: 2, when: 300, tag: "0002_add_billing" },
      ],
      100,
    );

    expect(pendingMigrations).toEqual(["0001_add_sessions.sql", "0002_add_billing.sql"]);
  });

  it("treats a missing migrations table as no applied migrations", async () => {
    const missingTableError = Object.assign(
      new pg.DatabaseError("relation does not exist", 0, "error"),
      { code: "42P01" },
    );
    const client = {
      query: vi.fn().mockRejectedValue(missingTableError),
    } as unknown as pg.Client;

    await expect(getLastAppliedMigrationTimestamp(client)).resolves.toBeNull();
  });

  it("propagates errors when the migrations table cannot be read", async () => {
    const permissionError = Object.assign(new pg.DatabaseError("permission denied", 0, "error"), {
      code: "42501",
    });
    const client = {
      query: vi.fn().mockRejectedValue(permissionError),
    } as unknown as pg.Client;

    await expect(getLastAppliedMigrationTimestamp(client)).rejects.toBe(permissionError);
  });
});

describe("migration CLI", () => {
  const connectionString = "postgresql://postgres:postgres@localhost:5432/stellopay_test";

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function mockClient() {
    const connect = vi.spyOn(pg.Client.prototype, "connect").mockResolvedValue();
    const end = vi.spyOn(pg.Client.prototype, "end").mockResolvedValue();

    return { connect, end };
  }

  it("prints pending migrations without invoking Drizzle migrate", async () => {
    const { connect, end } = mockClient();
    const query = vi.spyOn(pg.Client.prototype, "query").mockResolvedValue({ rows: [] } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["node", "migrate.ts", "--dry-run"], connectionString);

    expect(connect).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
    expect(vi.mocked(migrate)).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Pending migrations:");
    expect(log).toHaveBeenCalledWith("0000_faulty_mole_man.sql");
    expect(log).toHaveBeenCalledWith("0001_faulty_blue_blade.sql");
    expect(end).toHaveBeenCalledOnce();
  });

  it("prints when there are no pending migrations", async () => {
    mockClient();
    vi.spyOn(pg.Client.prototype, "query").mockResolvedValue({
      rows: [{ created_at: Number.MAX_SAFE_INTEGER }],
    } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["node", "migrate.ts", "--dry-run"], connectionString);

    expect(log).toHaveBeenCalledWith("No pending migrations.");
    expect(vi.mocked(migrate)).not.toHaveBeenCalled();
  });

  it("keeps normal migration behavior unchanged", async () => {
    const { connect, end } = mockClient();
    const query = vi.spyOn(pg.Client.prototype, "query");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(migrate).mockResolvedValue();

    await main(["node", "migrate.ts"], connectionString);

    expect(connect).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(migrate).toHaveBeenCalledWith(expect.anything(), {
      migrationsFolder: "./src/db/migrations",
    });
    expect(log).toHaveBeenCalledWith("Running database migrations...");
    expect(log).toHaveBeenCalledWith("Migrations applied successfully!");
    expect(end).toHaveBeenCalledOnce();
  });

  it("sets a non-zero exit code when the connection string is missing", async () => {
    const previousExitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      process.exitCode = undefined;
      await main(["node", "migrate.ts", "--dry-run"], "");

      expect(error).toHaveBeenCalledWith(
        "POSTGRES_CONNECTION_STRING is required to run migrations",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("recognizes direct CLI execution", () => {
    const scriptPath = resolve("src/db/migrate.ts");

    expect(isMainModule(scriptPath, pathToFileURL(scriptPath).href)).toBe(true);
    expect(isMainModule(undefined, pathToFileURL(scriptPath).href)).toBe(false);
    expect(isMainModule(scriptPath, pathToFileURL(resolve("src/index.ts")).href)).toBe(false);
  });

  it("reports migration failures with a non-zero exit code", () => {
    const previousExitCode = process.exitCode;
    const error = new Error("database unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      process.exitCode = undefined;
      handleMigrationFailure(error);

      expect(consoleError).toHaveBeenCalledWith("Migration failed:", error);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describeDbMigration("Database migration integration test", () => {
  let containerId: string;
  const connectionString = "postgresql://postgres:postgres@localhost:54321/stellopay_test";

  beforeAll(async () => {
    // Start temporary postgres container
    containerId = execSync(
      "docker run --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=stellopay_test -p 54321:5432 -d postgres:16-alpine",
      { stdio: "pipe" },
    )
      .toString()
      .trim();

    // Wait for postgres to be ready
    let attempts = 0;
    let databaseReady = false;
    while (attempts < 15) {
      try {
        execSync(`docker exec ${containerId} pg_isready -U postgres -d stellopay_test`, {
          stdio: "ignore",
        });
        databaseReady = true;
        break;
      } catch {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (!databaseReady) {
      throw new Error("PostgreSQL test container did not become ready in time");
    }
  }, 120000);

  afterAll(() => {
    if (!containerId) {
      return;
    }

    // Clean up container
    try {
      execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
    } catch (e) {
      console.warn("Failed to remove test container:", e);
    }
  }, 30000);

  it("lists pending migrations without changing the schema during dry-run", async () => {
    const output = execSync("pnpm db:migrate -- --dry-run", {
      env: {
        ...process.env,
        POSTGRES_CONNECTION_STRING: connectionString,
      },
      stdio: "pipe",
    }).toString();

    expect(output).toContain("Pending migrations:");
    expect(output).toContain("0000_faulty_mole_man.sql");
    expect(output).toContain("0001_faulty_blue_blade.sql");

    const client = new pg.Client({ connectionString });
    await client.connect();

    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const drizzleSchema = await client.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = 'drizzle'
    `);

    expect(tables.rows).toHaveLength(0);
    expect(drizzleSchema.rows).toHaveLength(0);

    await client.end();
  });

  it("successfully applies migrations to a clean database and creates all tables", async () => {
    // Run the migration script
    execSync("pnpm db:migrate", {
      env: {
        ...process.env,
        POSTGRES_CONNECTION_STRING: connectionString,
      },
      stdio: "pipe",
    });

    // Connect to database to inspect created tables
    const client = new pg.Client({ connectionString });
    await client.connect();

    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);

    const tables = res.rows.map((row) => row.table_name);

    const expectedTables = [
      "agreements",
      "agreement_events",
      "payments",
      "milestones",
      "employees",
      "escrow_events",
      "billing_profiles",
      "billing_payment_methods",
      "billing_invoices",
      "sessions",
    ];

    for (const table of expectedTables) {
      expect(tables).toContain(table);
    }

    await client.end();
  });

  it("exits non-zero when the migrations table cannot be read", async () => {
    const adminClient = new pg.Client({ connectionString });
    await adminClient.connect();

    try {
      await adminClient.query(
        "CREATE ROLE migration_reader_test LOGIN PASSWORD 'migration_reader_test'",
      );
      await adminClient.query("GRANT CONNECT ON DATABASE stellopay_test TO migration_reader_test");
      await adminClient.query("GRANT USAGE ON SCHEMA drizzle TO migration_reader_test");
    } finally {
      await adminClient.end();
    }

    const restrictedConnectionString =
      "postgresql://migration_reader_test:migration_reader_test@localhost:54321/stellopay_test";

    expect(() =>
      execSync("pnpm db:migrate -- --dry-run", {
        env: {
          ...process.env,
          POSTGRES_CONNECTION_STRING: restrictedConnectionString,
        },
        stdio: "pipe",
      }),
    ).toThrow();
  });
});

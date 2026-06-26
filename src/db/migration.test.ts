import { execSync } from "node:child_process";
import pg from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const describeDbMigration = process.env.RUN_DB_MIGRATION_TESTS === "1" ? describe : describe.skip;

describeDbMigration("Database migration integration test", () => {
  let containerId: string;
  const connectionString = "postgresql://postgres:postgres@localhost:54321/stellopay_test";

  beforeAll(async () => {
    // Start temporary postgres container
    containerId = execSync(
      "docker run --name stellopay-test-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=stellopay_test -p 54321:5432 -d postgres:16-alpine",
      { stdio: "pipe" },
    )
      .toString()
      .trim();

    // Wait for postgres to be ready
    let attempts = 0;
    while (attempts < 15) {
      try {
        execSync("pg_isready -h localhost -p 54321", { stdio: "ignore" });
        break;
      } catch {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }, 60000);

  afterAll(() => {
    // Clean up container
    try {
      execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
    } catch (e) {
      console.warn("Failed to remove test container:", e);
    }
  }, 30000);

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
});

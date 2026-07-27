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
  withMigrationLock,
} from "./migrate.js";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  agreements,
  agreementEvents,
  payments,
  milestones,
  employees,
  escrowEvents,
  billingProfiles,
  billingPaymentMethods,
  billingInvoices,
  U256_DECIMAL_REGEX,
  U256_DECIMAL_PATTERN,
  CURRENCY_CODE_REGEX,
  isValidU256,
  isValidCurrencyCode,
  isValidNonNegativeInteger,
  assertNonNegative,
  assertValidU256,
  clampPageLimit,
  clampBatchSize,
  validateBatchSize,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  MAX_BATCH_SIZE,
} from "./schema.js";

vi.mock("drizzle-orm/node-postgres/migrator", () => ({
  migrate: vi.fn(),
}));

const describeDbMigration = process.env.RUN_DB_MIGRATION_TESTS === "1" ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helper: extract CHECK constraint names declared on a table
// ---------------------------------------------------------------------------
function getCheckConstraintNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  const config = getTableConfig(table);
  // Drizzle exposes check constraints under config.checks
  const checks = (config as { checks?: Array<{ name: string }> }).checks ?? [];
  return checks.map((c) => c.name);
}

// ---------------------------------------------------------------------------
// Schema CHECK constraint declarations
// ---------------------------------------------------------------------------

describe("schema check constraints", () => {
  describe("agreements", () => {
    it("declares check constraints for mode, paymentType, status, disputeStatus, blockNumber, and u256 amounts", () => {
      const names = getCheckConstraintNames(agreements);
      expect(names).toContain("agreements_mode_check");
      expect(names).toContain("agreements_payment_type_check");
      expect(names).toContain("agreements_status_check");
      expect(names).toContain("agreements_dispute_status_check");
      expect(names).toContain("agreements_block_number_check");
      expect(names).toContain("agreements_total_amount_check");
      expect(names).toContain("agreements_paid_amount_check");
    });
  });

  describe("agreement_events", () => {
    it("declares check constraints for blockNumber and eventIndex", () => {
      const names = getCheckConstraintNames(agreementEvents);
      expect(names).toContain("agreement_events_block_number_check");
      expect(names).toContain("agreement_events_event_index_check");
    });
  });

  describe("payments", () => {
    it("declares check constraints for blockNumber, amount, and eventType", () => {
      const names = getCheckConstraintNames(payments);
      expect(names).toContain("payments_block_number_check");
      expect(names).toContain("payments_amount_check");
      expect(names).toContain("payments_event_type_check");
    });
  });

  describe("milestones", () => {
    it("declares check constraints for milestoneId, blockNumber, and amount", () => {
      const names = getCheckConstraintNames(milestones);
      expect(names).toContain("milestones_milestone_id_check");
      expect(names).toContain("milestones_block_number_check");
      expect(names).toContain("milestones_amount_check");
    });
  });

  describe("employees", () => {
    it("declares check constraints for employeeIndex, claimedPeriods, blockNumber, and salary", () => {
      const names = getCheckConstraintNames(employees);
      expect(names).toContain("employees_employee_index_check");
      expect(names).toContain("employees_claimed_periods_check");
      expect(names).toContain("employees_block_number_check");
      expect(names).toContain("employees_salary_per_period_check");
    });
  });

  describe("escrow_events", () => {
    it("declares check constraints for blockNumber, amount, and eventType", () => {
      const names = getCheckConstraintNames(escrowEvents);
      expect(names).toContain("escrow_events_block_number_check");
      expect(names).toContain("escrow_events_amount_check");
      expect(names).toContain("escrow_events_event_type_check");
    });
  });

  describe("billing_profiles", () => {
    it("declares check constraints for profileType, currency, and reward limits", () => {
      const names = getCheckConstraintNames(billingProfiles);
      expect(names).toContain("billing_profiles_profile_type_check");
      expect(names).toContain("billing_profiles_currency_check");
      expect(names).toContain("billing_profiles_annual_reward_limit_check");
      expect(names).toContain("billing_profiles_used_amount_check");
    });
  });

  describe("billing_payment_methods", () => {
    it("declares a check constraint for type", () => {
      const names = getCheckConstraintNames(billingPaymentMethods);
      expect(names).toContain("billing_payment_methods_type_check");
    });
  });

  describe("billing_invoices", () => {
    it("declares check constraints for status, currency, and amount", () => {
      const names = getCheckConstraintNames(billingInvoices);
      expect(names).toContain("billing_invoices_status_check");
      expect(names).toContain("billing_invoices_currency_check");
      expect(names).toContain("billing_invoices_amount_check");
    });
  });

  describe("u256 decimal format validation", () => {
    // Documents and tests the regex used in CHECK constraints for u256 columns.
    // The pattern is: ^(0|[1-9][0-9]{0,77})$
    // – accepts "0" and positive integers up to 78 digits (the max decimal
    //   width of 2^256 - 1); rejects leading zeros, negatives, decimals, etc.

    const validU256Values = [
      ["zero", "0"],
      ["one", "1"],
      ["large number", "123456789"],
      ["78-digit max", "1" + "0".repeat(77)],
    ] as const;

    const invalidU256Values = [
      ["empty string", ""],
      ["negative", "-1"],
      ["leading zero", "01"],
      ["decimal point", "1.5"],
      ["non-numeric", "abc"],
      ["leading space", " 1"],
      ["trailing space", "1 "],
      ["79 digits", "1" + "0".repeat(78)],
    ] as const;

    it("exports the regex constant with the correct pattern", () => {
      expect(U256_DECIMAL_REGEX).toBe("^(0|[1-9][0-9]{0,77})$");
    });

    it("compiled pattern matches the string constant", () => {
      expect(U256_DECIMAL_PATTERN.source).toBe(U256_DECIMAL_REGEX);
    });

    it.each(validU256Values)("accepts valid u256 value (%s): %s", (_label, value) => {
      expect(U256_DECIMAL_PATTERN.test(value)).toBe(true);
    });

    it.each(invalidU256Values)("rejects invalid u256 value (%s): %s", (_label, value) => {
      expect(U256_DECIMAL_PATTERN.test(value)).toBe(false);
    });
  });

  describe("currency code format validation", () => {
    // Documents the regex used in CHECK constraints for currency columns.
    // Accepts exactly three uppercase ASCII letters (ISO 4217 style).

    const validCurrencies = [
      ["USD", "USD"],
      ["EUR", "EUR"],
      ["GBP", "GBP"],
      ["JPY", "JPY"],
    ] as const;

    const invalidCurrencies = [
      ["empty string", ""],
      ["lowercase", "usd"],
      ["too short", "US"],
      ["too long", "USDD"],
      ["digits", "123"],
    ] as const;

    it.each(validCurrencies)("accepts valid currency code (%s)", (_label, code) => {
      expect(CURRENCY_CODE_REGEX.test(code)).toBe(true);
    });

    it.each(invalidCurrencies)("rejects invalid currency code (%s)", (_label, code) => {
      expect(CURRENCY_CODE_REGEX.test(code)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Runtime validation helpers
  // -------------------------------------------------------------------------

  describe("runtime validation helpers", () => {
    describe("isValidU256", () => {
      it("returns true for valid u256 values", () => {
        expect(isValidU256("0")).toBe(true);
        expect(isValidU256("1")).toBe(true);
        expect(isValidU256("123456789")).toBe(true);
        expect(isValidU256("1" + "0".repeat(77))).toBe(true);
      });

      it("returns false for invalid u256 values", () => {
        expect(isValidU256("")).toBe(false);
        expect(isValidU256("-1")).toBe(false);
        expect(isValidU256("01")).toBe(false);
        expect(isValidU256("1.5")).toBe(false);
        expect(isValidU256("abc")).toBe(false);
        expect(isValidU256("1" + "0".repeat(78))).toBe(false);
      });
    });

    describe("isValidCurrencyCode", () => {
      it("returns true for valid currency codes", () => {
        expect(isValidCurrencyCode("USD")).toBe(true);
        expect(isValidCurrencyCode("EUR")).toBe(true);
        expect(isValidCurrencyCode("GBP")).toBe(true);
      });

      it("returns false for invalid currency codes", () => {
        expect(isValidCurrencyCode("")).toBe(false);
        expect(isValidCurrencyCode("usd")).toBe(false);
        expect(isValidCurrencyCode("US")).toBe(false);
        expect(isValidCurrencyCode("USDD")).toBe(false);
        expect(isValidCurrencyCode("123")).toBe(false);
      });
    });

    describe("isValidNonNegativeInteger", () => {
      it("returns true for non-negative integers", () => {
        expect(isValidNonNegativeInteger(0)).toBe(true);
        expect(isValidNonNegativeInteger(1)).toBe(true);
        expect(isValidNonNegativeInteger(100)).toBe(true);
      });

      it("returns false for negative numbers", () => {
        expect(isValidNonNegativeInteger(-1)).toBe(false);
        expect(isValidNonNegativeInteger(-100)).toBe(false);
      });

      it("returns false for non-integer values", () => {
        expect(isValidNonNegativeInteger(1.5)).toBe(false);
        expect(isValidNonNegativeInteger(NaN)).toBe(false);
        expect(isValidNonNegativeInteger(Infinity)).toBe(false);
      });
    });

    describe("assertNonNegative", () => {
      it("passes for non-negative integers", () => {
        expect(() => assertNonNegative(0, "blockNumber")).not.toThrow();
        expect(() => assertNonNegative(1, "blockNumber")).not.toThrow();
        expect(() => assertNonNegative(100, "blockNumber")).not.toThrow();
      });

      it("throws RangeError for negative values", () => {
        expect(() => assertNonNegative(-1, "blockNumber")).toThrow(RangeError);
        expect(() => assertNonNegative(-1, "blockNumber")).toThrow("blockNumber must be non-negative");
      });

      it("throws RangeError for non-integer values", () => {
        expect(() => assertNonNegative(1.5, "eventIndex")).toThrow(RangeError);
        expect(() => assertNonNegative(NaN, "eventIndex")).toThrow(RangeError);
      });

      it("includes the field name in the error message", () => {
        expect(() => assertNonNegative(-5, "customField")).toThrow("customField");
      });
    });

    describe("assertValidU256", () => {
      it("passes for valid u256 strings", () => {
        expect(() => assertValidU256("0", "amount")).not.toThrow();
        expect(() => assertValidU256("12345", "amount")).not.toThrow();
      });

      it("throws RangeError for invalid u256 strings", () => {
        expect(() => assertValidU256("-1", "amount")).toThrow(RangeError);
        expect(() => assertValidU256("abc", "amount")).toThrow(RangeError);
        expect(() => assertValidU256("01", "amount")).toThrow(RangeError);
        expect(() => assertValidU256("", "amount")).toThrow(RangeError);
      });

      it("includes the field name and value in the error message", () => {
        expect(() => assertValidU256("-1", "totalAmount")).toThrow("totalAmount");
        expect(() => assertValidU256("-1", "totalAmount")).toThrow('"-1"');
      });
    });

    describe("clampPageLimit", () => {
      it("returns DEFAULT_PAGE_SIZE for values <= 0", () => {
        expect(clampPageLimit(0)).toBe(DEFAULT_PAGE_SIZE);
        expect(clampPageLimit(-1)).toBe(DEFAULT_PAGE_SIZE);
      });

      it("returns the requested value when within range", () => {
        expect(clampPageLimit(1)).toBe(1);
        expect(clampPageLimit(DEFAULT_PAGE_SIZE)).toBe(DEFAULT_PAGE_SIZE);
        expect(clampPageLimit(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
      });

      it("caps values above MAX_PAGE_SIZE", () => {
        expect(clampPageLimit(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
        expect(clampPageLimit(1000)).toBe(MAX_PAGE_SIZE);
      });
    });

    describe("clampBatchSize (legacy)", () => {
      it("returns 0 for invalid input", () => {
        expect(clampBatchSize(0)).toBe(0);
        expect(clampBatchSize(-1)).toBe(0);
        expect(clampBatchSize(MAX_BATCH_SIZE + 1)).toBe(0);
      });

      it("returns the requested value when within range", () => {
        expect(clampBatchSize(1)).toBe(1);
        expect(clampBatchSize(MAX_BATCH_SIZE)).toBe(MAX_BATCH_SIZE);
        expect(clampBatchSize(50)).toBe(50);
      });
    });

    describe("validateBatchSize", () => {
      it("returns the requested value when within range", () => {
        expect(validateBatchSize(1)).toBe(1);
        expect(validateBatchSize(MAX_BATCH_SIZE)).toBe(MAX_BATCH_SIZE);
        expect(validateBatchSize(50)).toBe(50);
      });

      it("throws RangeError for values <= 0", () => {
        expect(() => validateBatchSize(0)).toThrow(RangeError);
        expect(() => validateBatchSize(-1)).toThrow(RangeError);
      });

      it("throws RangeError for values above MAX_BATCH_SIZE", () => {
        expect(() => validateBatchSize(MAX_BATCH_SIZE + 1)).toThrow(RangeError);
      });

      it("throws RangeError for non-integer values", () => {
        expect(() => validateBatchSize(1.5)).toThrow(RangeError);
      });

      it("includes a custom name in the error when provided", () => {
        expect(() => validateBatchSize(0, "customBatch")).toThrow("customBatch");
      });

      it("includes the invalid value in the error message", () => {
        expect(() => validateBatchSize(999)).toThrow("999");
      });
    });
  });
});

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
    expect(query.mock.calls.some(([statement]) => String(statement).includes("pg_advisory"))).toBe(
      false,
    );
    expect(vi.mocked(migrate)).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Pending migrations:");
    expect(log).toHaveBeenCalledWith("0000_faulty_mole_man.sql");
    expect(log).toHaveBeenCalledWith("0001_faulty_blue_blade.sql");
    expect(log).toHaveBeenCalledWith("0002_hard_onslaught.sql");
    expect(log).toHaveBeenCalledWith("0003_schema_check_constraints.sql");
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
    const query = vi.spyOn(pg.Client.prototype, "query").mockResolvedValue({ rows: [] } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(migrate).mockResolvedValue();

    await main(["node", "migrate.ts"], connectionString);

    expect(connect).toHaveBeenCalledOnce();
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_lock($1, $2)",
      [0x5374656c, 0x4d696772],
    );
    expect(migrate).toHaveBeenCalledWith(expect.anything(), {
      migrationsFolder: "./src/db/migrations",
    });
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_unlock($1, $2)",
      [0x5374656c, 0x4d696772],
    );
    expect(log).toHaveBeenCalledWith("Running database migrations...");
    expect(log).toHaveBeenCalledWith("Migrations applied successfully!");
    expect(end).toHaveBeenCalledOnce();
  });

  it("releases the migration lock when migration execution fails", async () => {
    const { end } = mockClient();
    const query = vi.spyOn(pg.Client.prototype, "query").mockResolvedValue({ rows: [] } as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const migrationError = new Error("migration failed");
    vi.mocked(migrate).mockRejectedValue(migrationError);

    await expect(main(["node", "migrate.ts"], connectionString)).rejects.toBe(migrationError);

    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_lock($1, $2)",
      [0x5374656c, 0x4d696772],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_unlock($1, $2)",
      [0x5374656c, 0x4d696772],
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it("waits for a held migration lock before starting another migration", async () => {
    let finishFirstMigration!: () => void;
    const firstMigrationFinished = new Promise<void>((resolve) => {
      finishFirstMigration = resolve;
    });
    let grantSecondLock!: () => void;
    const secondLockGranted = new Promise<void>((resolve) => {
      grantSecondLock = resolve;
    });

    const firstClient = {
      query: vi.fn().mockImplementation(async (statement: string) => {
        if (statement.includes("pg_advisory_unlock")) {
          grantSecondLock();
        }
        return { rows: [] };
      }),
    } as unknown as pg.Client;
    const secondClient = {
      query: vi.fn().mockImplementation(async (statement: string) => {
        if (statement.includes("pg_advisory_lock")) {
          await secondLockGranted;
        }
        return { rows: [] };
      }),
    } as unknown as pg.Client;
    let activeMigrations = 0;
    let maximumActiveMigrations = 0;
    const firstMigration = vi.fn(async () => {
      activeMigrations++;
      maximumActiveMigrations = Math.max(maximumActiveMigrations, activeMigrations);
      await firstMigrationFinished;
      activeMigrations--;
    });
    const secondMigration = vi.fn(async () => {
      activeMigrations++;
      maximumActiveMigrations = Math.max(maximumActiveMigrations, activeMigrations);
      activeMigrations--;
    });

    const firstRun = withMigrationLock(firstClient, firstMigration);
    await vi.waitFor(() => expect(firstMigration).toHaveBeenCalledOnce());

    const secondRun = withMigrationLock(secondClient, secondMigration);
    await vi.waitFor(() => expect(secondClient.query).toHaveBeenCalledOnce());
    expect(secondMigration).not.toHaveBeenCalled();

    finishFirstMigration();
    await Promise.all([firstRun, secondRun]);

    expect(secondMigration).toHaveBeenCalledOnce();
    expect(maximumActiveMigrations).toBe(1);
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
    expect(output).toContain("0002_hard_onslaught.sql");
    expect(output).toContain("0003_schema_check_constraints.sql");

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

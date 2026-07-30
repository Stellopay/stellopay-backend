import { index, pgTable, text } from "drizzle-orm/pg-core";
import { getTableConfig, type PgTableWithColumns } from "drizzle-orm/pg-core";
import { isTable } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  assertSchemaForeignKeyIndexes,
  validateSchema,
  findUnindexedForeignKeyColumns,
  findUnindexedForeignKeyColumnsInSchema,
  getIndexedColumnSqlNames,
  isForeignKeyShapedColumn,
} from "./schema-fk-indexes.js";
import * as schema from "./schema.js";

describe("isForeignKeyShapedColumn", () => {
  it("recognizes relational Id columns", () => {
    expect(isForeignKeyShapedColumn("agreementId", "agreement_id", false)).toBe(true);
    expect(isForeignKeyShapedColumn("profileId", "profile_id", false)).toBe(true);
  });

  it("ignores primary keys, tax identifiers, and non-relational columns", () => {
    expect(isForeignKeyShapedColumn("id", "id", true)).toBe(false);
    expect(isForeignKeyShapedColumn("taxId", "tax_id", false)).toBe(false);
    expect(isForeignKeyShapedColumn("eventIndex", "event_index", false)).toBe(false);
  });
});

describe("findUnindexedForeignKeyColumns", () => {
  const tableWithoutFkIndex = pgTable("schema_consistency_gap_fixture", {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id").notNull(),
  });

  const tableWithFkIndex = pgTable(
    "schema_consistency_ok_fixture",
    {
      id: text("id").primaryKey(),
      agreementId: text("agreement_id").notNull(),
    },
    (table) => ({
      agreementIdIdx: index("schema_consistency_ok_fixture_agreement_id_idx").on(table.agreementId),
    }),
  );

  it("flags FK-shaped columns that lack an index", () => {
    expect(findUnindexedForeignKeyColumns(tableWithoutFkIndex)).toEqual([
      {
        tableName: "schema_consistency_gap_fixture",
        columnName: "agreement_id",
        jsName: "agreementId",
      },
    ]);
  });

  it("passes when the FK column is indexed", () => {
    expect(findUnindexedForeignKeyColumns(tableWithFkIndex)).toEqual([]);
  });
});

describe("schema contract validation", () => {
  it("validateSchema is the single entry point for production schema validation", () => {
    expect(() => validateSchema(schema as Record<string, unknown>)).not.toThrow();
  });

  it("assertSchemaForeignKeyIndexes delegates to validateSchema", () => {
    expect(() => assertSchemaForeignKeyIndexes(schema as Record<string, unknown>)).not.toThrow();
  });

  it("validateSchema throws with FK-level detail when an indexed column is missing", () => {
    const gapTable = pgTable("schema_consistency_gap_fixture", {
      id: text("id").primaryKey(),
      agreementId: text("agreement_id").notNull(),
    });

    expect(() => validateSchema({ gapTable } as Record<string, unknown>)).toThrow(
      /schema_consistency_gap_fixture\.agreement_id \(agreementId\)/,
    );
  });

  it("returns empty for a schema where every FK column is indexed", () => {
    const completeTable = pgTable(
      "schema_consistency_complete_fixture",
      {
        id: text("id").primaryKey(),
        agreementId: text("agreement_id").notNull(),
      },
      (table) => ({
        agreementIdIdx: index("schema_consistency_complete_fixture_agreement_id_idx").on(table.agreementId),
      }),
    );

    expect(() => validateSchema({ completeTable } as Record<string, unknown>)).not.toThrow();
  });
});

describe("schema.ts foreign-key index consistency", () => {
  it("indexes every FK-shaped column exported from schema.ts", () => {
    const unindexed = findUnindexedForeignKeyColumnsInSchema(schema as Record<string, unknown>);
    expect(unindexed).toEqual([]);
  });

  it("assertSchemaForeignKeyIndexes succeeds on the production schema", () => {
    expect(() => assertSchemaForeignKeyIndexes(schema as Record<string, unknown>)).not.toThrow();
  });

  it("covers billing profile owner_address via unique constraint indexing", () => {
    const indexed = getIndexedColumnSqlNames(schema.billingProfiles);
    expect(indexed.has("owner_address")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema contract enforcement — invariants I1–I7 from the module header
// ---------------------------------------------------------------------------

/** Return check-constraint names declared on a Drizzle table (same helper used by migration.test.ts). */
function getCheckConstraintNames(table: PgTableWithColumns<any>): string[] {
  const config = getTableConfig(table);
  const checks = (config as { checks?: Array<{ name: string }> }).checks ?? [];
  return checks.map((c) => c.name);
}

describe("schema contract invariants", () => {
  // ── I1: Table inventory ─────────────────────────────────────────────────

  describe("I1 — table inventory", () => {
    it("exports exactly the tables listed in SCHEMA_TABLES (no orphans, no duplicates)", () => {
      // Collect every Drizzle table exported from the schema module using isTable().
      const exportedTableNames: string[] = [];
      for (const [key, value] of Object.entries(schema)) {
        if (isTable(value)) {
          exportedTableNames.push(key);
        }
      }

      const schemaTableNames = schema.SCHEMA_TABLES.map((t) => t.name);

      // Sorted comparison catches both missing tables and duplicates.
      expect(exportedTableNames.sort()).toEqual(schemaTableNames.sort());
    });

    it("has exactly 12 tables", () => {
      expect(schema.SCHEMA_TABLES).toHaveLength(12);
    });

    it("every SCHEMA_TABLES entry has a defined table reference", () => {
      for (const entry of schema.SCHEMA_TABLES) {
        expect(entry.table, `${entry.name} must have a table reference`).toBeDefined();
        expect(isTable(entry.table), `${entry.name} must be a valid Drizzle table`).toBe(true);
      }
    });
  });

  // ── I3 / I5 / I6: CHECK constraint coverage ─────────────────────────────

  describe("CHECK constraint coverage", () => {
    it("every u256 amount column has a named CHECK constraint", () => {
      // Columns carrying u256 amounts as decimal strings.
      // The migration.test.ts separately verifies the regex content;
      // this test ensures the constraint declaration exists.
      const amountChecks: Array<{ table: string; constraint: string }> = [
        { table: "agreements", constraint: "agreements_total_amount_check" },
        { table: "agreements", constraint: "agreements_paid_amount_check" },
        { table: "payments", constraint: "payments_amount_check" },
        { table: "milestones", constraint: "milestones_amount_check" },
        { table: "employees", constraint: "employees_salary_per_period_check" },
        { table: "escrowEvents", constraint: "escrow_events_amount_check" },
      ];

      for (const { table, constraint } of amountChecks) {
        const tableDef = schema.SCHEMA_TABLES.find((t) => t.name === table);
        expect(tableDef, `SCHEMA_TABLES must include ${table}`).toBeDefined();
        const names = getCheckConstraintNames(tableDef!.table);
        expect(names, `${table} must declare ${constraint}`).toContain(constraint);
      }
    });

    it("every block_number column has CHECK >= 0", () => {
      const blockNumberChecks: Array<{ table: string; constraint: string }> = [
        { table: "agreements", constraint: "agreements_block_number_check" },
        { table: "agreementEvents", constraint: "agreement_events_block_number_check" },
        { table: "payments", constraint: "payments_block_number_check" },
        { table: "milestones", constraint: "milestones_block_number_check" },
        { table: "employees", constraint: "employees_block_number_check" },
        { table: "escrowEvents", constraint: "escrow_events_block_number_check" },
      ];

      for (const { table, constraint } of blockNumberChecks) {
        const tableDef = schema.SCHEMA_TABLES.find((t) => t.name === table);
        expect(tableDef, `SCHEMA_TABLES must include ${table}`).toBeDefined();
        const names = getCheckConstraintNames(tableDef!.table);
        expect(names, `${table} must declare ${constraint}`).toContain(constraint);
      }
    });

    it("every status/type enum column has a named CHECK constraint", () => {
      // Tables whose design includes enumerations must declare at least one
      // CHECK IN / CHECK BETWEEN constraint beyond numeric range checks.
      const tablesRequiringEnumChecks = [
        "agreements",
        "payments",
        "escrowEvents",
        "billingProfiles",
        "billingPaymentMethods",
        "billingInvoices",
      ];

      for (const tableName of tablesRequiringEnumChecks) {
        const tableDef = schema.SCHEMA_TABLES.find((t) => t.name === tableName);
        expect(tableDef, `SCHEMA_TABLES must include ${tableName}`).toBeDefined();
        const allChecks = getCheckConstraintNames(tableDef!.table);
        // Filter out numeric-range and currency-format checks to find enum-style ones.
        const enumChecks = allChecks.filter(
          (name) =>
            !name.includes("block_number") &&
            !name.includes("amount") &&
            !name.includes("salary") &&
            !name.includes("event_index") &&
            !name.includes("employee_index") &&
            !name.includes("claimed_periods") &&
            !name.includes("milestone_id") &&
            !name.includes("annual_reward") &&
            !name.includes("used_amount") &&
            !name.includes("currency"),
        );
        // NOTE: the exclusion list above must be kept in sync when new
        // numeric/range CHECK constraints are added. Any constraint name
        // that does not match one of the excluded patterns is treated as
        // an enum-style check.
        expect(
          enumChecks.length,
          `${tableName} must have at least one enum-style CHECK constraint (mode, status, type, event_type, profile_type, etc.)`,
        ).toBeGreaterThan(0);
      }
    });
  });

  // ── I7: Runtime ↔ DB parity ────────────────────────────────────────────

  describe("I7 — runtime ↔ DB parity", () => {
    it("exports a runtime helper for every shared constraint pattern", () => {
      expect(typeof schema.isValidU256).toBe("function");
      expect(typeof schema.isValidCurrencyCode).toBe("function");
      expect(typeof schema.isValidNonNegativeInteger).toBe("function");
      expect(typeof schema.assertValidU256).toBe("function");
      expect(typeof schema.assertNonNegative).toBe("function");
    });

    it("exports the constraint regex constants used by CHECK definitions", () => {
      expect(typeof schema.U256_DECIMAL_REGEX).toBe("string");
      expect(schema.U256_DECIMAL_REGEX.length).toBeGreaterThan(0);
      expect(schema.U256_DECIMAL_PATTERN).toBeInstanceOf(RegExp);
      expect(schema.CURRENCY_CODE_REGEX).toBeInstanceOf(RegExp);
    });

    it("exports pagination and batching constants", () => {
      expect(schema.MAX_PAGE_SIZE).toBe(100);
      expect(schema.DEFAULT_PAGE_SIZE).toBe(50);
      expect(schema.MAX_BATCH_SIZE).toBe(100);
      expect(typeof schema.clampPageLimit).toBe("function");
      expect(typeof schema.clampBatchSize).toBe("function");
      expect(typeof schema.validateBatchSize).toBe("function");
    });
  });
});

import { execSync } from "node:child_process";
import fs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm";
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
import { validateSchema } from "./schema-fk-indexes.js";
import { pgTable, text } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";
import {
  SCHEMA_COMPATIBILITY_VERSION,
  agreements,
  agreementEvents,
  payments,
  milestones,
  employees,
  escrowEvents,
  billingProfiles,
  billingPaymentMethods,
  billingInvoices,
  sessions,
  backfillProgress,
  U256_DECIMAL_REGEX,
  U256_DECIMAL_PATTERN,
  CURRENCY_CODE_REGEX,
  isValidU256,
  isValidCurrencyCode,
  isValidNonNegativeInteger,
  assertNonNegative,
  assertValidU256,
  assertValidCurrencyCode,
  clampPageLimit,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampBatchSize,
  MAX_BATCH_SIZE,
  validateBatchSize,
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

  describe("backfill_progress", () => {
    it("declares check constraints for status, totalScanned, and totalCreated", () => {
      const names = getCheckConstraintNames(backfillProgress);
      expect(names).toContain("backfill_progress_status_check");
      expect(names).toContain("backfill_progress_total_scanned_check");
      expect(names).toContain("backfill_progress_total_created_check");
    });
  });

  // -----------------------------------------------------------------------
  // Global invariants — fail if two tables share a CHECK constraint name.
  // A name collision would cause the constraint migration to fail in
  // production because Postgres enforces uniqueness of constraint names
  // within a schema.
  // -----------------------------------------------------------------------
  describe("global CHECK constraint invariants", () => {
    it("uses unique CHECK constraint names across every table in the schema", () => {
      const seen = new Map<string, string>();
      const duplicates: Array<{ name: string; tables: string[] }> = [];

      for (const { name, table } of schema.SCHEMA_TABLES) {
        for (const checkName of getCheckConstraintNames(table)) {
          const existing = seen.get(checkName);
          if (existing) {
            // First duplicate found — record the conflict list.
            if (!duplicates.find((d) => d.name === checkName)) {
              duplicates.push({ name: checkName, tables: [existing] });
            }
            const entry = duplicates.find((d) => d.name === checkName);
            entry?.tables.push(name);
          } else {
            seen.set(checkName, name);
          }
        }
      }

      expect(duplicates, "duplicate CHECK constraint names across tables").toEqual([]);
    });

    it("lists every emitted CHECK constraint in at least one schema table", () => {
      // Guard against a CHECK declared in Drizzle but never registered in
      // SCHEMA_TABLES — it would still build, but a later migration that
      // touches it through the inventory could miss it.
      const allConstraintNames = new Set<string>();
      for (const { table } of schema.SCHEMA_TABLES) {
        for (const name of getCheckConstraintNames(table)) {
          allConstraintNames.add(name);
        }
      }

      // Sanity: at least as many constraints as the production migration
      // applies (one CHECK per ALTER TABLE line). The schema file mirrors
      // the migration list verbatim, so any drop here is a regression.
      expect(allConstraintNames.size).toBeGreaterThanOrEqual(28);
    });
  });

  // -----------------------------------------------------------------------
  // SQL ↔ Drizzle parity — every CHECK in the migration SQL must be
  // declared in schema.ts. Catches a real failure mode: a future migration
  // generator could silently drop a CHECK from Drizzle's runtime metadata
  // while leaving the SQL intact (or vice-versa), causing schema drift
  // between code and database.
  // -----------------------------------------------------------------------

  // Migration files that contain `CHECK` constraint definitions. The list
  // pins the parser fixtures so a renamed file fails the test instead of
  // silently passing on an empty result.
  const SQL_MIGRATION_FILES_WITH_CHECKS = [
    "20240104000000_schema_check_constraints.sql",
    "0004_noisy_eternals.sql",
  ] as const;

  // Extract every CHECK constraint name from a SQL migration file.
  // Matches both `ALTER TABLE ... ADD CONSTRAINT "<name>" CHECK (...)`
  // and the inline `CONSTRAINT "<name>" CHECK (...)` form used by
  // `CREATE TABLE`-based migrations.
  function readCheckConstraintNamesFromMigration(fileName: string): string[] {
    const sqlPath = resolve(`src/db/migrations/${fileName}`);
    const content = fs.readFileSync(sqlPath, "utf8");
    const matches = content.matchAll(/(?:ADD\s+)?CONSTRAINT\s+"([^"]+)"\s+CHECK\b/g);
    return Array.from(matches, (m) => m[1]);
  }

  describe("SQL migration ↔ Drizzle schema parity", () => {
    it("every CHECK constraint in the canonical migration SQL is also declared in schema.ts", () => {
      const declaredInDrizzle = new Set<string>();
      for (const { table } of schema.SCHEMA_TABLES) {
        for (const name of getCheckConstraintNames(table)) {
          declaredInDrizzle.add(name);
        }
      }

      const declaredInSql: string[] = [];
      for (const file of SQL_MIGRATION_FILES_WITH_CHECKS) {
        declaredInSql.push(...readCheckConstraintNamesFromMigration(file));
      }

      // The fixtures must produce at least one constraint — empty output
      // means the parser is broken or the fixture paths drifted, and we
      // want to fail loudly rather than silently pass.
      expect(declaredInSql.length).toBeGreaterThan(0);

      const missingFromDrizzle = declaredInSql.filter(
        (n) => !declaredInDrizzle.has(n),
      );
      expect(
        missingFromDrizzle,
        "CHECK constraints defined in migration SQL must be present in schema.ts Drizzle metadata",
      ).toEqual([]);
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

      it("accepts the exact 78-digit upper boundary (2^256 − 1 decimal width)", () => {
        const maxU256DecimalWidth = "1" + "0".repeat(77);
        expect(maxU256DecimalWidth).toHaveLength(78);
        expect(() => assertValidU256(maxU256DecimalWidth, "amount")).not.toThrow();
      });

      it("throws RangeError for invalid u256 strings", () => {
        expect(() => assertValidU256("-1", "amount")).toThrow(RangeError);
        expect(() => assertValidU256("abc", "amount")).toThrow(RangeError);
        expect(() => assertValidU256("01", "amount")).toThrow(RangeError);
        expect(() => assertValidU256("", "amount")).toThrow(RangeError);
      });

      it("rejects strings that exceed the 78-digit upper boundary", () => {
        const tooLong = "1" + "0".repeat(78);
        expect(tooLong).toHaveLength(79);
        expect(() => assertValidU256(tooLong, "amount")).toThrow(RangeError);
      });

      it("includes the field name and value in the error message", () => {
        expect(() => assertValidU256("-1", "totalAmount")).toThrow("totalAmount");
        expect(() => assertValidU256("-1", "totalAmount")).toThrow('"-1"');
      });
    });

    describe("assertValidCurrencyCode", () => {
      it("passes for valid ISO 4217-style codes", () => {
        expect(() => assertValidCurrencyCode("USD", "currency")).not.toThrow();
        expect(() => assertValidCurrencyCode("EUR", "currency")).not.toThrow();
        expect(() => assertValidCurrencyCode("JPY", "currency")).not.toThrow();
      });

      it("throws RangeError for malformed codes", () => {
        expect(() => assertValidCurrencyCode("", "currency")).toThrow(RangeError);
        expect(() => assertValidCurrencyCode("usd", "currency")).toThrow(RangeError);
        expect(() => assertValidCurrencyCode("US", "currency")).toThrow(RangeError);
        expect(() => assertValidCurrencyCode("USDD", "currency")).toThrow(RangeError);
        expect(() => assertValidCurrencyCode("123", "currency")).toThrow(RangeError);
      });

      it("includes the field name and code in the error message", () => {
        expect(() => assertValidCurrencyCode("usd", "currency")).toThrow("currency");
        expect(() => assertValidCurrencyCode("usd", "currency")).toThrow('"usd"');
      });

      it("mirrors isValidCurrencyCode for every valid and invalid sample", () => {
        const validCodes = ["USD", "EUR", "GBP", "JPY"];
        const invalidCodes = ["", "usd", "US", "USDD", "123", "U$D"];
        for (const code of validCodes) {
          expect(isValidCurrencyCode(code), `predicate expects ${code} valid`).toBe(true);
          expect(() => assertValidCurrencyCode(code, "currency")).not.toThrow();
        }
        for (const code of invalidCodes) {
          expect(isValidCurrencyCode(code), `predicate expects ${code} invalid`).toBe(false);
          expect(() => assertValidCurrencyCode(code, "currency")).toThrow(RangeError);
        }
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

    describe("security boundary - sensitive billing fields", () => {
      it("defines SENSITIVE_BILLING_FIELDS containing exactly taxId and dateOfBirth", () => {
        expect(schema.SENSITIVE_BILLING_FIELDS).toEqual(["taxId", "dateOfBirth"]);
      });

      it("verifies sensitive fields exist on the billingProfiles table schema", () => {
        const columns = getTableConfig(schema.billingProfiles).columns;
        const columnNames = columns.map((c) => c.name);
        expect(columnNames).toContain("tax_id");
        expect(columnNames).toContain("date_of_birth");
      });

      it("stripSensitiveBillingFields removes sensitive fields and returns a clean object copy", () => {
        const input = {
          id: "profile-1",
          ownerAddress: "0xowner",
          taxId: "EIN-12345",
          dateOfBirth: "1990-01-01",
          firstName: "Alice",
        };
        const output = schema.stripSensitiveBillingFields(input);
        expect(output).toEqual({
          id: "profile-1",
          ownerAddress: "0xowner",
          firstName: "Alice",
        });
        // Ensure original object was not mutated (non-mutating copy behavior)
        expect(input.taxId).toBe("EIN-12345");
        expect(input.dateOfBirth).toBe("1990-01-01");
      });

      it("stripSensitiveBillingFields is a no-op for objects without sensitive fields", () => {
        const input = {
          id: "profile-2",
          ownerAddress: "0xowner",
          firstName: "Bob",
        };
        const output = schema.stripSensitiveBillingFields(input);
        expect(output).toEqual(input);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Backward-compatibility contract
// ---------------------------------------------------------------------------

describe("backward-compatibility contract", () => {
  // ── B1: Compatibility version ──────────────────────────────────────────

  describe("B1 — compatibility version", () => {
    it("exports SCHEMA_COMPATIBILITY_VERSION with the initial value of 1", () => {
      expect(SCHEMA_COMPATIBILITY_VERSION).toBe(1);
    });

    it("SCHEMA_COMPATIBILITY_VERSION is a frozen number constant", () => {
      expect(typeof SCHEMA_COMPATIBILITY_VERSION).toBe("number");
      expect(Object.isFrozen).toBeDefined();
    });
  });

  // ── B2: Export inventory — helpers and constants must not disappear ────

  describe("B2 — export inventory stability", () => {
    it("exports every expected validation helper function", () => {
      expect(typeof schema.isValidU256).toBe("function");
      expect(typeof schema.isValidCurrencyCode).toBe("function");
      expect(typeof schema.isValidNonNegativeInteger).toBe("function");
      expect(typeof schema.assertNonNegative).toBe("function");
      expect(typeof schema.assertValidU256).toBe("function");
      expect(typeof schema.assertValidCurrencyCode).toBe("function");
      expect(typeof schema.clampPageLimit).toBe("function");
      expect(typeof schema.clampBatchSize).toBe("function");
      expect(typeof schema.validateBatchSize).toBe("function");
      expect(typeof schema.stripSensitiveBillingFields).toBe("function");
    });

    it("exports every expected constant", () => {
      expect(typeof schema.U256_DECIMAL_REGEX).toBe("string");
      expect(schema.U256_DECIMAL_PATTERN).toBeInstanceOf(RegExp);
      expect(schema.CURRENCY_CODE_REGEX).toBeInstanceOf(RegExp);
      expect(typeof schema.MAX_PAGE_SIZE).toBe("number");
      expect(typeof schema.DEFAULT_PAGE_SIZE).toBe("number");
      expect(typeof schema.MAX_BATCH_SIZE).toBe("number");
      expect(Array.isArray(schema.SCHEMA_TABLES)).toBe(true);
      expect(Array.isArray(schema.SENSITIVE_BILLING_FIELDS)).toBe(true);
      expect(typeof schema.SCHEMA_COMPATIBILITY_VERSION).toBe("number");
    });

    it("exports exactly 12 tables", () => {
      expect(schema.SCHEMA_TABLES).toHaveLength(12);
    });

    it("SENSITIVE_BILLING_FIELDS contains exactly the expected fields", () => {
      expect(schema.SENSITIVE_BILLING_FIELDS).toEqual(["taxId", "dateOfBirth"]);
    });
  });

  // ── B3: Runtime helper ↔ DB constraint parity ─────────────────────────

  describe("B3 — helper-to-constraint mapping", () => {
    it("isValidU256 maps to the U256_DECIMAL_REGEX DB CHECK constraint", () => {
      expect(isValidU256("0")).toBe(true);
      expect(isValidU256("1")).toBe(true);
      expect(isValidU256("-1")).toBe(false);
      expect(isValidU256("abc")).toBe(false);
    });

    it("isValidCurrencyCode maps to the currency CHECK constraints", () => {
      expect(isValidCurrencyCode("USD")).toBe(true);
      expect(isValidCurrencyCode("EUR")).toBe(true);
      expect(isValidCurrencyCode("usd")).toBe(false);
      expect(isValidCurrencyCode("")).toBe(false);
    });

    it("isValidNonNegativeInteger maps to block_number CHECK >= 0 constraints", () => {
      expect(isValidNonNegativeInteger(0)).toBe(true);
      expect(isValidNonNegativeInteger(1)).toBe(true);
      expect(isValidNonNegativeInteger(-1)).toBe(false);
      expect(isValidNonNegativeInteger(1.5)).toBe(false);
    });

    it("assertNonNegative maps to block_number CHECK >= 0 constraints with a thrown error", () => {
      expect(() => assertNonNegative(0, "test")).not.toThrow();
      expect(() => assertNonNegative(-1, "test")).toThrow(RangeError);
    });

    it("assertValidU256 maps to U256_DECIMAL_REGEX CHECK constraints with a thrown error", () => {
      expect(() => assertValidU256("0", "test")).not.toThrow();
      expect(() => assertValidU256("-1", "test")).toThrow(RangeError);
      expect(() => assertValidU256("-1", "test")).toThrow('"-1"');
    });

    it("assertValidCurrencyCode maps to currency CHECK constraints with a thrown error", () => {
      expect(() => assertValidCurrencyCode("USD", "test")).not.toThrow();
      expect(() => assertValidCurrencyCode("usd", "test")).toThrow(RangeError);
    });
  });

  // ── B4: every table with enum columns has at least one enum CHECK ──────

  describe("B4 — enum CHECK constraint coverage", () => {
    const enumCheckTables = [
      { name: "agreements", constraint: "agreements_mode_check" },
      { name: "payments", constraint: "payments_event_type_check" },
      { name: "escrowEvents", constraint: "escrow_events_event_type_check" },
      { name: "billingProfiles", constraint: "billing_profiles_profile_type_check" },
      { name: "billingPaymentMethods", constraint: "billing_payment_methods_type_check" },
      { name: "billingInvoices", constraint: "billing_invoices_status_check" },
      { name: "backfillProgress", constraint: "backfill_progress_status_check" },
    ];

    it.each(enumCheckTables)("$name declares the enum CHECK $constraint", ({ name, constraint }) => {
      const entry = schema.SCHEMA_TABLES.find((t) => t.name === name);
      expect(entry, `${name} must be registered in SCHEMA_TABLES`).toBeDefined();
      const names = getCheckConstraintNames(entry!.table);
      expect(names, `${name} must declare ${constraint}`).toContain(constraint);
    });
  });

  // ── B5: Boundary paths for validation helpers ──────────────────────────

  describe("B5 — validation helper boundary paths", () => {
    describe("isValidU256 boundary", () => {
      it("rejects exactly at 79 digits (one past max)", () => {
        expect(isValidU256("1" + "0".repeat(78))).toBe(false);
      });

      it("accepts exactly at 78 digits (max)", () => {
        expect(isValidU256("1" + "0".repeat(77))).toBe(true);
      });

      it("rejects empty string", () => {
        expect(isValidU256("")).toBe(false);
      });

      it("rejects zero with leading digit", () => {
        expect(isValidU256("00")).toBe(false);
      });

      it("accepts single zero", () => {
        expect(isValidU256("0")).toBe(true);
      });
    });

    describe("clampPageLimit boundary", () => {
      it("returns NaN for NaN (current behavior — not NaN-safe)", () => {
        expect(Number.isNaN(clampPageLimit(NaN))).toBe(true);
      });

      it("returns DEFAULT_PAGE_SIZE for negative infinity", () => {
        expect(clampPageLimit(-Infinity)).toBe(DEFAULT_PAGE_SIZE);
      });

      it("caps exactly at MAX_PAGE_SIZE", () => {
        expect(clampPageLimit(MAX_PAGE_SIZE + 0.5)).toBe(MAX_PAGE_SIZE);
      });
    });

    describe("validateBatchSize boundary", () => {
      it("throws RangeError for zero", () => {
        expect(() => validateBatchSize(0)).toThrow(RangeError);
      });

      it("throws RangeError for MAX_BATCH_SIZE + 1", () => {
        expect(() => validateBatchSize(MAX_BATCH_SIZE + 1)).toThrow(RangeError);
      });

      it("throws RangeError for floating point within range", () => {
        expect(() => validateBatchSize(50.5)).toThrow(RangeError);
      });
    });

    describe("clampBatchSize boundary", () => {
      it("returns NaN for NaN (current behavior — not NaN-safe)", () => {
        expect(Number.isNaN(clampBatchSize(NaN))).toBe(true);
      });

      it("returns 0 for negative values", () => {
        expect(clampBatchSize(-100)).toBe(0);
      });
    });

    describe("assertNonNegative boundary", () => {
      it("rejects negative zero string coercion", () => {
        expect(() => assertNonNegative(-0, "test")).not.toThrow();
      });

      it("throws for non-number type", () => {
        expect(() => assertNonNegative("0" as unknown as number, "test")).toThrow(RangeError);
      });
    });
  });

  // ── B6: Assert that removing a constraint would be detected ────────────

  describe("B6 — constraint inventory completeness", () => {
    it("every agreement constraint from migration SQL is present in Drizzle metadata", () => {
      const names = getCheckConstraintNames(agreements);
      expect(names).toEqual(
        expect.arrayContaining([
          "agreements_mode_check",
          "agreements_payment_type_check",
          "agreements_status_check",
          "agreements_dispute_status_check",
          "agreements_block_number_check",
          "agreements_total_amount_check",
          "agreements_paid_amount_check",
        ]),
      );
    });

    it("no duplicate CHECK constraint names exist across the schema", () => {
      const seen = new Map<string, string>();
      const duplicates: Array<{ name: string; tables: string[] }> = [];

      for (const { name, table } of schema.SCHEMA_TABLES) {
        for (const checkName of getCheckConstraintNames(table)) {
          const existing = seen.get(checkName);
          if (existing) {
            if (!duplicates.find((d) => d.name === checkName)) {
              duplicates.push({ name: checkName, tables: [existing] });
            }
            const entry = duplicates.find((d) => d.name === checkName);
            entry?.tables.push(name);
          } else {
            seen.set(checkName, name);
          }
        }
      }

      expect(duplicates, "duplicate CHECK constraint names across tables").toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency contract
// ---------------------------------------------------------------------------

describe("idempotency contract", () => {
  // ── I1: Pure-function helpers return the same value on repeated calls ──

  describe("I1 — query helper idempotency", () => {
    it("isValidU256 returns the same result for the same input", () => {
      const inputs = ["0", "1", "12345", "", "-1", "01", "1.5", "abc"];
      for (const input of inputs) {
        const first = isValidU256(input);
        const second = isValidU256(input);
        expect(second, `isValidU256("${input}") must be idempotent`).toBe(first);
      }
    });

    it("isValidCurrencyCode returns the same result for the same input", () => {
      const codes = ["USD", "EUR", "GBP", "", "usd", "US", "USDD", "123"];
      for (const code of codes) {
        const first = isValidCurrencyCode(code);
        const second = isValidCurrencyCode(code);
        expect(second, `isValidCurrencyCode("${code}") must be idempotent`).toBe(first);
      }
    });

    it("isValidNonNegativeInteger returns the same result for the same input", () => {
      const inputs = [0, 1, 100, -1, 1.5, NaN, Infinity];
      for (const input of inputs) {
        const first = isValidNonNegativeInteger(input);
        const second = isValidNonNegativeInteger(input);
        expect(second, `isValidNonNegativeInteger(${input}) must be idempotent`).toBe(first);
      }
    });

    it("clampPageLimit returns the same value for the same input", () => {
      const inputs = [-5, 0, 1, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_PAGE_SIZE + 1, 1000, NaN, -Infinity];
      for (const input of inputs) {
        const first = clampPageLimit(input);
        const second = clampPageLimit(input);
        expect(Number.isNaN(first) ? Number.isNaN(second) : second === first).toBe(true);
      }
    });

    it("clampBatchSize returns the same value for the same input", () => {
      const inputs = [-5, 0, 1, MAX_BATCH_SIZE, MAX_BATCH_SIZE + 1, 50, NaN, -100];
      for (const input of inputs) {
        const first = clampBatchSize(input);
        const second = clampBatchSize(input);
        expect(Number.isNaN(first) ? Number.isNaN(second) : second === first).toBe(true);
      }
    });

    it("validateBatchSize returns the same value for the same valid input", () => {
      const inputs = [1, MAX_BATCH_SIZE, 50];
      for (const input of inputs) {
        const first = validateBatchSize(input);
        const second = validateBatchSize(input);
        expect(second, `validateBatchSize(${input}) must be idempotent`).toBe(first);
      }
    });

    it("stripSensitiveBillingFields is idempotent", () => {
      const input = {
        id: "profile-1",
        ownerAddress: "0xowner",
        taxId: "EIN-12345",
        dateOfBirth: "1990-01-01",
        firstName: "Alice",
      };
      const first = schema.stripSensitiveBillingFields(input);
      const second = schema.stripSensitiveBillingFields(first);
      expect(second).toEqual(first);
    });

    it("stripSensitiveBillingFields is a no-op when called twice", () => {
      const input = {
        id: "profile-2",
        ownerAddress: "0xowner",
        firstName: "Bob",
      };
      const first = schema.stripSensitiveBillingFields(input);
      const second = schema.stripSensitiveBillingFields(first);
      expect(second).toEqual(first);
    });
  });

  // ── I2: Assertion helpers throw the same error on repeated invalid calls ──

  describe("I2 — assertion helper idempotency", () => {
    it("assertNonNegative succeeds on repeated valid calls", () => {
      expect(() => { assertNonNegative(0, "test"); }).not.toThrow();
      expect(() => { assertNonNegative(0, "test"); }).not.toThrow();
    });

    it("assertNonNegative throws the same error type on repeated invalid calls", () => {
      expect(() => { assertNonNegative(-1, "test"); }).toThrow(RangeError);
      expect(() => { assertNonNegative(-1, "test"); }).toThrow(RangeError);
    });

    it("assertValidU256 succeeds on repeated valid calls", () => {
      expect(() => { assertValidU256("0", "test"); }).not.toThrow();
      expect(() => { assertValidU256("0", "test"); }).not.toThrow();
    });

    it("assertValidU256 throws the same error type on repeated invalid calls", () => {
      expect(() => { assertValidU256("-1", "test"); }).toThrow(RangeError);
      expect(() => { assertValidU256("-1", "test"); }).toThrow(RangeError);
    });

    it("assertValidCurrencyCode succeeds on repeated valid calls", () => {
      expect(() => { assertValidCurrencyCode("USD", "test"); }).not.toThrow();
      expect(() => { assertValidCurrencyCode("USD", "test"); }).not.toThrow();
    });

    it("assertValidCurrencyCode throws the same error type on repeated invalid calls", () => {
      expect(() => { assertValidCurrencyCode("usd", "test"); }).toThrow(RangeError);
      expect(() => { assertValidCurrencyCode("usd", "test"); }).toThrow(RangeError);
    });
  });

  // ── I3: Validation error messages are stable (same input → same message text) ──

  describe("I3 — error message stability", () => {
    it("assertNonNegative produces the same message text for the same invalid input", () => {
      const extract = (fn: () => void): string => {
        try { fn(); return "no-error"; } catch (e: any) { return e.message; }
      };
      const msg1 = extract(() => assertNonNegative(-1, "blockNumber"));
      const msg2 = extract(() => assertNonNegative(-1, "blockNumber"));
      expect(msg1).toBe("blockNumber must be non-negative, got -1");
      expect(msg2).toBe(msg1);
    });

    it("assertValidU256 produces the same message text for the same invalid input", () => {
      const extract = (fn: () => void): string => {
        try { fn(); return "no-error"; } catch (e: any) { return e.message; }
      };
      const msg1 = extract(() => assertValidU256("-1", "amount"));
      const msg2 = extract(() => assertValidU256("-1", "amount"));
      expect(msg1).toContain("amount");
      expect(msg1).toContain('"-1"');
      expect(msg2).toBe(msg1);
    });

    it("assertValidCurrencyCode produces the same message text for the same invalid input", () => {
      const extract = (fn: () => void): string => {
        try { fn(); return "no-error"; } catch (e: any) { return e.message; }
      };
      const msg1 = extract(() => assertValidCurrencyCode("usd", "currency"));
      const msg2 = extract(() => assertValidCurrencyCode("usd", "currency"));
      expect(msg1).toContain("currency");
      expect(msg1).toContain('"usd"');
      expect(msg2).toBe(msg1);
    });

    it("validateBatchSize produces the same message text for the same invalid input", () => {
      const extract = (fn: () => void): string => {
        try { fn(); return "no-error"; } catch (e: any) { return e.message; }
      };
      const msg1 = extract(() => validateBatchSize(0, "batchSize"));
      const msg2 = extract(() => validateBatchSize(0, "batchSize"));
      expect(msg1).toContain("batchSize");
      expect(msg2).toBe(msg1);
    });
  });

  // ── I4: Migration helpers are idempotent ──────────────────────────

  describe("I4 — migration helper idempotency", () => {
    it("getPendingMigrationFileNames returns the same result for the same inputs", () => {
      const entries = [
        { idx: 0, when: 100, tag: "0000_initial" },
        { idx: 1, when: 200, tag: "0001_add_sessions" },
      ];

      const first = getPendingMigrationFileNames(entries, 100);
      const second = getPendingMigrationFileNames(entries, 100);
      expect(first).toEqual(["0001_add_sessions.sql"]);
      expect(second).toEqual(first);
    });

    it("getPendingMigrationFileNames with null timestamp returns all pending both times", () => {
      const entries = [
        { idx: 0, when: 100, tag: "0000_initial" },
        { idx: 1, when: 200, tag: "0001_add_sessions" },
      ];

      const first = getPendingMigrationFileNames(entries, null);
      const second = getPendingMigrationFileNames(entries, null);
      expect(first).toEqual(["0000_initial.sql", "0001_add_sessions.sql"]);
      expect(second).toEqual(first);
    });

    it("getPendingMigrationFileNames with up-to-date timestamp returns empty both times", () => {
      const entries = [
        { idx: 0, when: 100, tag: "0000_initial" },
      ];

      const first = getPendingMigrationFileNames(entries, 200);
      const second = getPendingMigrationFileNames(entries, 200);
      expect(first).toEqual([]);
      expect(second).toEqual(first);
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

describe("schema contract validation", () => {
  it("validateSchema succeeds on the production schema", () => {
    expect(() => validateSchema(schema as Record<string, unknown>)).not.toThrow();
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
    expect(log).toHaveBeenCalledWith("20240101000000_faulty_mole_man.sql");
    expect(log).toHaveBeenCalledWith("20240102000000_faulty_blue_blade.sql");
    expect(log).toHaveBeenCalledWith("20240103000000_hard_onslaught.sql");
    expect(log).toHaveBeenCalledWith("20240104000000_schema_check_constraints.sql");
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

describe("schema foreign key constraints", () => {
  it("defines agreementId references for agreement child tables", () => {
    const childTables = [
      schema.agreementEvents,
      schema.payments,
      schema.milestones,
      schema.employees,
      schema.escrowEvents,
    ];

    for (const table of childTables) {
      const fks = getTableConfig(table).foreignKeys;
      expect(fks).toHaveLength(1);
      const ref = fks[0].reference();
      expect(getTableName(ref.foreignTable)).toBe("agreements");
      expect(ref.columns.map((c: any) => c.name)).toEqual(["agreement_id"]);
      expect(ref.foreignColumns.map((c: any) => c.name)).toEqual(["id"]);
      expect(fks[0].onDelete).toBe("no action");
      expect(fks[0].onUpdate).toBe("no action");
    }
  });

  it("defines profileId cascade references for billing child tables", () => {
    const childTables = [
      schema.billingPaymentMethods,
      schema.billingInvoices,
    ];

    for (const table of childTables) {
      const fks = getTableConfig(table).foreignKeys;
      expect(fks).toHaveLength(1);
      const ref = fks[0].reference();
      expect(getTableName(ref.foreignTable)).toBe("billing_profiles");
      expect(ref.columns.map((c: any) => c.name)).toEqual(["profile_id"]);
      expect(ref.foreignColumns.map((c: any) => c.name)).toEqual(["id"]);
      expect(fks[0].onDelete).toBe("cascade");
      expect(fks[0].onUpdate).toBe("no action");
    }
  });

  it("does not define foreign keys for standalone tables", () => {
    expect(getTableConfig(schema.agreements).foreignKeys).toEqual([]);
    expect(getTableConfig(schema.billingProfiles).foreignKeys).toEqual([]);
    expect(getTableConfig(schema.sessions).foreignKeys).toEqual([]);
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

  it("verifies foreign key constraints exist after migration", async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();

    const res = await client.query(`
      SELECT tc.table_name, tc.constraint_name
      FROM information_schema.table_constraints tc
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY tc.table_name, tc.constraint_name
    `);

    const fkTables = new Set(res.rows.map((row) => row.table_name));
    expect(fkTables.has("agreement_events")).toBe(true);
    expect(fkTables.has("payments")).toBe(true);
    expect(fkTables.has("milestones")).toBe(true);
    expect(fkTables.has("employees")).toBe(true);
    expect(fkTables.has("escrow_events")).toBe(true);
    expect(fkTables.has("billing_payment_methods")).toBe(true);
    expect(fkTables.has("billing_invoices")).toBe(true);

    await client.end();
  });

  it("rejects inserts that violate foreign key constraints", async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();

    try {
      await client.query(
        `INSERT INTO agreement_events (id, agreement_id, contract_address, event_type, block_number, transaction_hash, event_index, created_at)
         VALUES ('fk-test-event', 'non-existent-id', '0x0', 'AgreementCreated', 1, '0x0', 0, NOW())`,
      );
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.code).toBe("23503");
    } finally {
      await client.end();
    }
  });

  it("cascades delete from billing_profiles to billing_payment_methods", async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();

    try {
      await client.query(
        `INSERT INTO billing_profiles (id, owner_address) VALUES ('fk-cascade-test', '0xOwner')`,
      );
      await client.query(
        `INSERT INTO billing_payment_methods (id, profile_id, type) VALUES ('fk-cascade-pm', 'fk-cascade-test', 'bank_account')`,
      );

      await client.query(`DELETE FROM billing_profiles WHERE id = 'fk-cascade-test'`);

      const res = await client.query(
        `SELECT COUNT(*) FROM billing_payment_methods WHERE id = 'fk-cascade-pm'`,
      );
      expect(res.rows[0].count).toBe("0");
    } finally {
      await client.end();
    }
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

// ---------------------------------------------------------------------------
// Migration naming consistency
// ---------------------------------------------------------------------------

describe("migration naming consistency", () => {
  const MIGRATIONS_DIR = resolve("src/db/migrations");

  function readSqlFiles(): string[] {
    return fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"));
  }

  function readJournalTags(): string[] {
    const journal = JSON.parse(
      fs.readFileSync(resolve("src/db/migrations/meta/_journal.json"), "utf8"),
    );
    return journal.entries.map((e: { tag: string }) => e.tag);
  }

  it("every .sql migration file is registered in _journal.json", () => {
    const sqlFiles = readSqlFiles().map((f) => f.replace(/\.sql$/, ""));
    const journalTags = readJournalTags();
    const journalSet = new Set(journalTags);

    const unregistered = sqlFiles.filter((tag) => !journalSet.has(tag));
    expect(
      unregistered,
      `Unregistered migration files: ${unregistered.join(", ")}`,
    ).toEqual([]);
  });

  it("every journal tag has a corresponding .sql file", () => {
    const sqlFiles = new Set(
      readSqlFiles().map((f) => f.replace(/\.sql$/, "")),
    );
    const journalTags = readJournalTags();

    const missing = journalTags.filter((tag) => !sqlFiles.has(tag));
    expect(
      missing,
      `Journal entries without .sql files: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no duplicate tags in _journal.json", () => {
    const journalTags = readJournalTags();
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const tag of journalTags) {
      if (seen.has(tag)) duplicates.push(tag);
      seen.add(tag);
    }
    expect(
      duplicates,
      `Duplicate journal tags: ${duplicates.join(", ")}`,
    ).toEqual([]);
  });

  it("journal entries have monotonically increasing idx values", () => {
    const journal = JSON.parse(
      fs.readFileSync(resolve("src/db/migrations/meta/_journal.json"), "utf8"),
    );
    const indices = journal.entries.map((e: { idx: number }) => e.idx);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  it("new timestamp-prefixed migrations use unique 13-14 digit prefixes", () => {
    const sqlFiles = readSqlFiles();
    const timestampPattern = /^\d{13,14}_(.+)\.sql$/;
    const prefixes = new Map<string, string[]>();

    for (const file of sqlFiles) {
      const match = file.match(timestampPattern);
      if (match) {
        const prefix = file.split("_")[0];
        const existing = prefixes.get(prefix) ?? [];
        existing.push(file);
        prefixes.set(prefix, existing);
      }
    }

    for (const [prefix, files] of prefixes) {
      expect(
        files.length,
        `Duplicate timestamp prefix "${prefix}" in: ${files.join(", ")}`,
      ).toBe(1);
    }
  });
});

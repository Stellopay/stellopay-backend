import { index, pgTable, text } from "drizzle-orm/pg-core";
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

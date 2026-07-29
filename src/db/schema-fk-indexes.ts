import { getTableColumns, getTableName, isTable, type Table } from "drizzle-orm";
import { getTableConfig, type PgColumn } from "drizzle-orm/pg-core";

/** Identifier columns ending in Id that are not foreign-key relations. */
const NON_FOREIGN_KEY_ID_COLUMNS = new Set(["taxId"]);

export interface UnindexedForeignKeyColumn {
  tableName: string;
  columnName: string;
  jsName: string;
}

const TABLE_CONFIG_CACHE = new WeakMap<Table, ReturnType<typeof getTableConfig>>();

function getCachedTableConfig(table: Table): ReturnType<typeof getTableConfig> {
  if (!TABLE_CONFIG_CACHE.has(table)) {
    TABLE_CONFIG_CACHE.set(table, getTableConfig(table));
  }
  return TABLE_CONFIG_CACHE.get(table)!;
}

/**
 * True when the column looks like a relational foreign key (e.g. agreementId -> agreement_id).
 * Sensitive identifiers such as taxId are excluded.
 */
export function isForeignKeyShapedColumn(
  jsName: string,
  sqlName: string,
  isPrimaryKey: boolean,
): boolean {
  if (isPrimaryKey || jsName === "id" || sqlName === "id") {
    return false;
  }
  if (NON_FOREIGN_KEY_ID_COLUMNS.has(jsName)) {
    return false;
  }
  return jsName.endsWith("Id") && sqlName.endsWith("_id");
}

function isPgColumn(value: unknown): value is PgColumn {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as PgColumn).name === "string" &&
    "table" in value
  );
}

function addColumnNames(target: Set<string>, columns: readonly unknown[]): void {
  for (const column of columns) {
    if (isPgColumn(column)) {
      target.add(column.name);
      continue;
    }
    if (
      typeof column === "object" &&
      column !== null &&
      "name" in column &&
      typeof (column as { name: unknown }).name === "string"
    ) {
      target.add((column as { name: string }).name);
    }
  }
}

function readConstraintColumns(constraint: unknown): readonly unknown[] {
  if (typeof constraint !== "object" || constraint === null) {
    return [];
  }
  if ("columns" in constraint && Array.isArray(constraint.columns)) {
    return constraint.columns;
  }
  if ("config" in constraint) {
    const nested = (constraint as { config?: { columns?: unknown[] } }).config?.columns;
    if (Array.isArray(nested)) {
      return nested;
    }
  }
  return [];
}

/** SQL column names covered by indexes, primary keys, or unique constraints on the table. */
export function getIndexedColumnSqlNames(table: Table, config?: ReturnType<typeof getTableConfig>): Set<string> {
  const tableConfig = config ?? getCachedTableConfig(table);
  if (!tableConfig) {
    return new Set();
  }

  const indexed = new Set<string>();

  for (const primaryKey of tableConfig.primaryKeys) {
    addColumnNames(indexed, readConstraintColumns(primaryKey));
  }

  for (const tableIndex of tableConfig.indexes) {
    addColumnNames(indexed, readConstraintColumns(tableIndex));
  }

  for (const uniqueConstraint of tableConfig.uniqueConstraints) {
    addColumnNames(indexed, readConstraintColumns(uniqueConstraint));
  }

  return indexed;
}

/**
 * Returns FK-shaped columns on {@link table} that are not indexed.
 */
export function findUnindexedForeignKeyColumns(table: Table): UnindexedForeignKeyColumn[] {
  const tableName = getTableName(table);
  const config = getCachedTableConfig(table);
  if (!config) {
    return [];
  }
  const indexedColumns = getIndexedColumnSqlNames(table, config);
  const offenders: UnindexedForeignKeyColumn[] = [];

  for (const [jsName, column] of Object.entries(getTableColumns(table))) {
    if (
      isForeignKeyShapedColumn(jsName, column.name, column.primary) &&
      !indexedColumns.has(column.name)
    ) {
      offenders.push({
        tableName,
        columnName: column.name,
        jsName,
      });
    }
  }

  return offenders;
}

/**
 * Walks every Drizzle table export and returns unindexed FK-shaped columns.
 */
export function findUnindexedForeignKeyColumnsInSchema(
  schemaModule: Record<string, unknown>,
): UnindexedForeignKeyColumn[] {
  const offenders: UnindexedForeignKeyColumn[] = [];

  for (const exportValue of Object.values(schemaModule)) {
    if (!isTable(exportValue)) {
      continue;
    }
    offenders.push(...findUnindexedForeignKeyColumns(exportValue));
  }

  return offenders;
}

/**
 * Validates the schema contract: every FK-shaped column must have a supporting index.
 *
 * This is the single entry point for schema validation. It replaces ad-hoc calls to
 * `assertSchemaForeignKeyIndexes` and `findUnindexedForeignKeyColumnsInSchema` in tests,
 * ensuring the schema contract is checked through one tight path.
 */
export function validateSchema(schemaModule: Record<string, unknown>): void {
  const unindexed = findUnindexedForeignKeyColumnsInSchema(schemaModule);

  if (unindexed.length === 0) {
    return;
  }

  const details = unindexed
    .map(({ tableName, columnName, jsName }) => `${tableName}.${columnName} (${jsName})`)
    .join(", ");

  throw new Error(
    `Foreign-key-shaped column(s) missing an index: ${details}. ` +
      "Add a Drizzle index() on the column or document an exclusion in schema-fk-indexes.ts.",
  );
}

/**
 * @deprecated Use {@link validateSchema} instead. Kept for backward compatibility.
 */
export function assertSchemaForeignKeyIndexes(schemaModule: Record<string, unknown>): void {
  validateSchema(schemaModule);
}

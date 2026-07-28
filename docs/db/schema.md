# Database Schema

> Source of truth: [`src/db/schema.ts`](../src/db/schema.ts). The Drizzle table
> definitions, CHECK constraints, FK indexes, and runtime validation helpers
> exported from that module drive every query, migration, and test.

The database schema is the single source of truth for tables, CHECK
constraints, FK relationships, and their runtime validators. This document
describes the contract enforced by `src/db/schema.ts` and verified by
`src/db/migration.test.ts` and `src/db/schema-consistency.test.ts`.

## Table inventory

| # | Table                          | Purpose                                  | FK out                                            |
|---|--------------------------------|------------------------------------------|---------------------------------------------------|
| 1 | `agreements`                   | Work-agreement header record             | —                                                 |
| 2 | `agreement_events`             | Per-event log for each agreement         | `agreement_id` → `agreements.id`                  |
| 3 | `payments`                     | Payment sent/received log                | `agreement_id` → `agreements.id`                  |
| 4 | `milestones`                   | Milestones attached to an agreement      | `agreement_id` → `agreements.id`                  |
| 5 | `employees`                    | Payroll employees per agreement          | `agreement_id` → `agreements.id`                  |
| 6 | `escrow_events`                | Funded/Released/Refunded escrow events   | `agreement_id` → `agreements.id`                  |
| 7 | `billing_profiles`             | Per-wallet billing identity              | —                                                 |
| 8 | `billing_payment_methods`      | Masked payment methods per profile       | `profile_id` → `billing_profiles.id` (CASCADE)    |
| 9 | `billing_invoices`             | Invoice records per profile              | `profile_id` → `billing_profiles.id` (CASCADE)    |
| 10| `sessions`                     | Auth sessions with family/rotation state | —                                                 |
| 11| `backfill_progress`            | Backfill-job checkpoints                 | —                                                 |

`agreements`, `agreement_events`, `payments`, `milestones`, `employees`, and
`escrow_events` share the same `agreement_id` foreign key with
`ON DELETE NO ACTION`. The two `billing_*` child tables cascade on delete so
removing a profile purges its payment methods and invoices.

## Constraints and migration safety

### CHECK constraint catalogue

Every CHECK constraint is registered in [`src/db/migrations/20240104000000_schema_check_constraints.sql`](../src/db/migrations/20240104000000_schema_check_constraints.sql)
and mirrored in Drizzle via the `check(...)` block in `src/db/schema.ts`.

| Pattern                             | Affected columns                                                  |
|-------------------------------------|-------------------------------------------------------------------|
| `^(0|[1-9][0-9]{0,77})$`            | Every `amount` / `total_amount` / `paid_amount` / `salary_per_period` (u256) |
| `^[A-Z]{3}$`                        | `currency` columns (`billing_profiles`, `billing_invoices`)       |
| `>= 0`                              | Every `block_number`, `event_index`, `employee_index`, `milestone_id`, `claimed_periods`, `total_scanned`, `total_created`, `annual_reward_limit`, `used_amount`, `amount` (numeric) |
| `IN (...)` (enum)                   | `mode`, `payment_type`, `status`, `dispute_status`, `event_type`, `profile_type`, `type`, `backfill_progress.status` |
| `BETWEEN 0 AND 5`                   | `agreements.status`                                               |

> **Migration safety rule.** Every CHECK constraint name must be **globally
> unique within the schema**. Postgres enforces this when migrations run; if two
> tables accidentally reuse the same name, the second `ADD CONSTRAINT` fails.
> `src/db/migration.test.ts` locks this rule down with a global uniqueness
> assertion over `SCHEMA_TABLES`.

### Runtime ↔ DB parity

Every CHECK pattern has a runtime validator that callers can use before hitting
the database. The pairs below are exported from `src/db/schema.ts`:

| DB CHECK regex / range             | Predicate                                | Asserting variant                  |
|------------------------------------|------------------------------------------|-------------------------------------|
| `U256_DECIMAL_REGEX` (u256)        | `isValidU256(value)`                     | `assertValidU256(value, name)`     |
| `CURRENCY_CODE_REGEX` (currency)   | `isValidCurrencyCode(code)`              | `assertValidCurrencyCode(code, name)` |
| `>= 0` (numeric/integer bound)     | `isValidNonNegativeInteger(value)`       | `assertNonNegative(value, name)`   |
| `>= 1 && <= MAX_BATCH_SIZE`        | —                                        | `validateBatchSize(value, name?)`  |

The asserting variants emit a structured `schema_validation_failed` log entry
before throwing `RangeError`, so observability tooling can correlate rejections
with the field name and rejected value. When possible, prefer the asserting
variants on the write path; reserve the non-throwing predicates for read paths
that need to ignore invalid historical rows.

### Pagination & batch limits

`src/db/schema.ts` exports three limits and a clamp helper:

- `MAX_PAGE_SIZE = 100` — upper bound for list endpoints
- `DEFAULT_PAGE_SIZE = 50` — fallback when `limit <= 0`
- `MAX_BATCH_SIZE = 100` — upper bound for bulk operations

| Helper             | Behaviour on invalid input   | Use when                                       |
|--------------------|------------------------------|------------------------------------------------|
| `clampPageLimit`   | Defaults to 50, caps at 100  | Read paths that tolerate clamped values        |
| `clampBatchSize`   | Returns `0` silently (legacy)| Existing callers — prefer `validateBatchSize`  |
| `validateBatchSize`| Throws `RangeError`          | New code on the write path                      |

## Schema invariants (I1–I7)

`src/db/schema.ts` advertises seven invariants. Each is verified by
`src/db/schema-consistency.test.ts` (and partially by
`src/db/migration.test.ts`):

| #  | Invariant                                                              | Test reference                            |
|----|------------------------------------------------------------------------|-------------------------------------------|
| I1 | Exactly 11 tables exported via `SCHEMA_TABLES`                         | `schema-consistency.test.ts > I1`        |
| I2 | Every FK-shaped `*Id` column has a btree index                       | `schema-consistency.test.ts > FK indexes`|
| I3 | Every u256 amount column uses `U256_DECIMAL_REGEX`                    | `schema-consistency.test.ts > CHECK coverage`|
| I4 | Every `currency` column uses `^[A-Z]{3}$`                             | `migration.test.ts > currency code`       |
| I5 | Every `block_number` column has `CHECK >= 0`                          | `schema-consistency.test.ts > CHECK coverage`|
| I6 | Every enum column has `CHECK IN (...)` / `CHECK BETWEEN`             | `schema-consistency.test.ts > enum check` |
| I7 | Every CHECK pattern has a runtime helper exported from `schema.ts`    | `schema-consistency.test.ts > I7`         |

### Adding a new table

1. Define it in `src/db/schema.ts` with the appropriate CHECK constraints,
   FK indexes, and runtime helpers (assertValidX / isValidX) where applicable.
2. Add an entry to `SCHEMA_TABLES` so the table-inventory test stays in sync.
3. Add a CHECK-constraint test in `src/db/migration.test.ts`.
4. Write a migration in `src/db/migrations/` and register it in
   `src/db/migrations/meta/_journal.json`.
5. Update this document with the new table and any new constraints.

### Migration safety

- **Advisory lock.** `src/db/migrate.ts` takes a StelloPay-namespaced
  PostgreSQL advisory lock around migration execution; concurrent runs wait.
- **Dry-run.** `pnpm db:migrate -- --dry-run` lists pending migrations
  without acquiring the lock or applying schema changes.
- **Constraint migration ordering.** The CHECK migration
  (`20240104000000_schema_check_constraints.sql`) uses `ADD CONSTRAINT`
  per table; tables without existing rows validate immediately, while
  tables with rows are still enforced by Postgres at insert time.
- **Integration coverage.** `src/db/migration.test.ts > Database migration
  integration test` (gated by `RUN_DB_MIGRATION_TESTS=1`) starts a real
  Postgres container, applies migrations, and verifies PK/FK existence,
  FK reject behaviour, and cascade delete on `billing_payment_methods`.

### Out of scope

- Type-narrowing of `mode`, `payment_type`, `status`, etc. — Drizzle does not
  expose a typed enum primitive, so values are typed as `number` and the
  enum is enforced purely by the DB CHECK invariant (I6).
- Per-row CHECK semantics for `u256` (leading-zero rejection, max width).
  The runtime helpers in `src/db/schema.ts` are the canonical reference;
  the DB CHECK does the same work via the shared `U256_DECIMAL_REGEX`.

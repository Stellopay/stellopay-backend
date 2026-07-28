# Database Schema

## Tables

The schema is defined in `src/db/schema.ts` and exported via `src/db/index.ts` as `schema`.

| Table | Purpose |
|-------|---------|
| `agreements` | On-chain agreement creation, status, and financial state |
| `agreement_events` | Every agreement lifecycle event emitted by the indexer |
| `payments` | Payment sent / received events per agreement |
| `milestones` | Milestone approval, claim, and payout tracking |
| `employees` | Payroll employee entries per agreement |
| `escrow_events` | Escrow fund, release, and refund events |
| `billing_profiles` | Billing identity per user |
| `billing_payment_methods` | Payment methods attached to a billing profile |
| `billing_invoices` | Invoice records linked to a billing profile |
| `sessions` | Auth sessions with sliding and absolute expiry |

## Schema Contract

`src/db/schema.ts` owns the database contract. It is the single source of truth for table shapes, column types, foreign-key relationships, and indexes. All enforcement is described below, and every invariant checked at build time or test time covers a property that `schema.ts` guarantees.

Validation of the contract is centralized in `src/db/schema-fk-indexes.ts` through `validateSchema(schemaModule)`. Tests, tooling, and the migration path rely on that one entry point rather than ad-hoc assertions.

## Foreign Key Contract

All child tables declare explicit `.references()` constraints in `src/db/schema.ts`. This tightens the contract in three ways:

1. **Referential integrity** - the database rejects inserts or updates that reference non-existent parents.
2. **No orphaned rows** - cascade rules prevent billing child rows from persisting after their profile is removed.
3. **Single source of truth** - the schema file owns the relationship graph; callers do not need to repeat validation logic.

### Blockchain event tables (immutable append-only)

`agreement_events`, `payments`, `milestones`, `employees`, and `escrow_events` each reference `agreements.id` with `ON DELETE NO ACTION`. This preserves blockchain-event integrity: accidental or malicious deletion of an agreement row is blocked, preventing silent data loss.

| Child table | Parent table | FK column | ON DELETE |
|-------------|-------------|-----------|-----------|
| `agreement_events` | `agreements` | `agreement_id` | `NO ACTION` |
| `payments` | `agreements` | `agreement_id` | `NO ACTION` |
| `milestones` | `agreements` | `agreement_id` | `NO ACTION` |
| `employees` | `agreements` | `agreement_id` | `NO ACTION` |
| `escrow_events` | `agreements` | `agreement_id` | `NO ACTION` |

### Billing tables (mutable user data)

`billing_payment_methods` and `billing_invoices` reference `billing_profiles.id` with `ON DELETE CASCADE`. When a profile is removed, its payment methods and invoices are automatically cleaned up, preventing orphaned PII and billing records.

| Child table | Parent table | FK column | ON DELETE |
|-------------|-------------|-----------|-----------|
| `billing_payment_methods` | `billing_profiles` | `profile_id` | `CASCADE` |
| `billing_invoices` | `billing_profiles` | `profile_id` | `CASCADE` |

### Standalone tables

`agreements`, `billing_profiles`, and `sessions` have no outgoing foreign keys.

## Index Convention

Every foreign-key-shaped column (camelCase `*Id` mapped to SQL `*_id`) must have a btree index declared in the same `pgTable` definition. Primary keys and non-relational identifiers such as `taxId` are excluded.

This convention is enforced by `src/db/schema-consistency.test.ts` via `validateSchema()`.

Table config lookups are cached inside `schema-fk-indexes.ts` so repeated validation calls (across tests or tooling) do not re-process internal Drizzle metadata for the same table.

## Migrations

Schema changes are tracked with Drizzle Kit. Adding or modifying tables always produces a new timestamped migration file under `src/db/migrations/`. Existing migrations are never rewritten.

Foreign key constraints introduced by `.references()` are emitted as `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` statements in a separate migration file. This preserves the ability to replay existing migrations on databases that have already applied them.

### Applying migrations

```bash
pnpm db:migrate          # apply pending migrations
pnpm db:migrate -- --dry-run  # list pending migrations without applying
```

Migrations are protected by a Postgres advisory lock (`0x5374656c, 0x4d696772`) so concurrent deploys cannot race.

The dry-run path skips redundant migration-file disk reads; it relies on the journal and a lightweight timestamp query to determine pending migrations.

## Failure and Boundary Paths

- **FK violation on insert**: inserting a child row with a parent `id` that does not exist returns Postgres error code `23503` (`foreign_key_violation`).
- **Cascade delete**: deleting a `billing_profiles` row automatically removes all child `billing_payment_methods` and `billing_invoices` rows.
- **Orphan prevention**: deleting an `agreements` row is rejected while any child event, payment, milestone, employee, or escrow row still references it.

## Edge Cases Out of Scope

- Soft-delete for blockchain event tables is not implemented; the `NO ACTION` policy assumes these rows are immutable.
- Circular references across billing tables are not present in the current schema and are not guarded against.

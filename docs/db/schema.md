# Database Schema

> Source of truth: [`src/db/schema.ts`](../src/db/schema.ts). The Drizzle table
> definitions, CHECK constraints, FK indexes, and runtime validation helpers
> exported from that module drive every query, migration, and test.

## Idempotency Contract

Every exported function in the schema module is **idempotent**:

- **Query helpers** (`isValidU256`, `isValidCurrencyCode`,
  `isValidNonNegativeInteger`, `clampPageLimit`, `clampBatchSize`,
  `validateBatchSize`, `stripSensitiveBillingFields`): pure-function
  contract — the same arguments always produce the same return value.
- **Assertion helpers** (`assertNonNegative`, `assertValidU256`,
  `assertValidCurrencyCode`): same-throw contract — the same valid
  arguments always succeed; the same invalid arguments always throw a
  semantically equivalent error.
- **Migration helpers** (`getPendingMigrationFileNames`,
  `withMigrationLock`): pure logic and transactional locks mean the
  migration system is safe to retry. Drizzle's migrator tracks applied
  migrations, so re-applying the same set is a no-op.

This contract is enforced by the `idempotency contract` test block in
`src/db/migration.test.ts` (invariant I8).

## Backward-compatibility Policy

The schema module exports a public API surface that follows strict backward
compatibility. Compatibility is tracked via `SCHEMA_COMPATIBILITY_VERSION`
(currently `1`).

### Breaking changes (must bump `SCHEMA_COMPATIBILITY_VERSION`)

- Removing or renaming any exported table definition
- Removing or renaming any exported runtime validation helper
- Changing the signature (parameter count, types, return type) of any
  exported helper
- Removing or renaming a named CHECK constraint
- Changing the regex or logic in a shared constraint constant
  (`U256_DECIMAL_REGEX`, `CURRENCY_CODE_REGEX`)
- Changing the numeric value of `MAX_PAGE_SIZE`, `DEFAULT_PAGE_SIZE`, or
  `MAX_BATCH_SIZE`
- Removing items from `SENSITIVE_BILLING_FIELDS`

### Safe additive changes

- Adding a new table definition (requires entry in `SCHEMA_TABLES`)
- Adding a new CHECK constraint (must not collide with existing names)
- Adding a new runtime validation helper following existing naming patterns
- Adding a new column with a `DEFAULT` clause to an existing table
- Adding new items to `SENSITIVE_BILLING_FIELDS` (tightening the boundary)

## Invariants

The schema enforces eight invariants (I1–I8), verified by
`schema-consistency.test.ts` and `migration.test.ts`:

| # | Invariant | Enforcement |
|---|-----------|-------------|
| I1 | **Table inventory** — exactly 11 tables. | `schema-consistency.test.ts` |
| I2 | **FK index** — every `*Id` column mapped to `*_id` has a btree index. | `schema-fk-indexes.ts` |
| I3 | **u256 amount CHECK** — every u256 column uses `U256_DECIMAL_REGEX`. | `migration.test.ts` |
| I4 | **Currency CHECK** — every currency column uses `'^[A-Z]{3}$'`. | `migration.test.ts` |
| I5 | **Block-number CHECK** — every block_number column has `CHECK >= 0`. | `migration.test.ts` |
| I6 | **Enum CHECK** — every closed-set column has `CHECK IN (...)` or `CHECK BETWEEN`. | `schema-consistency.test.ts` |
| I7 | **Runtime ↔ DB parity** — every CHECK has a runtime validation helper. | `migration.test.ts` |
| I8 | **Idempotency** — every exported helper produces the same result for the same arguments on repeated calls. | `migration.test.ts` |

## Constraints and Migration Safety

- **Validation Handlers**: Schema check constraints are mirrored in runtime via
  validation helpers like `assertNonNegative` and `validateBatchSize`.
- **Structured Logs**: Runtime validation helpers log structured warnings
  (e.g., `schema_validation_failed`) with contextual bounds information (value
  requested, limit) to improve observability of schema boundary violations.
- **Migration Tests**: All check constraints and migration operations are
  tested end-to-end against a clean sandbox container, avoiding accidental
  schema drifts.
- **Naming Conventions**: Check constraint names follow the pattern
  `<table>_<column>_check` (e.g., `agreements_mode_check`). Names must be
  unique within the schema — duplicate names cause Postgres migration failures.
- **SQL ↔ Drizzle Parity**: Every CHECK constraint in migration SQL must also
  be declared in Drizzle's metadata (`schema.ts`). The test suite detects drift
  between these two representations.

## Tables

| Table | SQL Name | Description |
|-------|----------|-------------|
| `agreements` | `agreements` | Agreement creation and status updates |
| `agreementEvents` | `agreement_events` | All agreement-related events |
| `payments` | `payments` | Payment events |
| `milestones` | `milestones` | Milestone events |
| `employees` | `employees` | Employee information for payroll |
| `escrowEvents` | `escrow_events` | Escrow funding, release, and refund events |
| `billingProfiles` | `billing_profiles` | User billing identities |
| `billingPaymentMethods` | `billing_payment_methods` | Payment methods per billing profile |
| `billingInvoices` | `billing_invoices` | Invoice records |
| `sessions` | `sessions` | Auth sessions with sliding and absolute expiry |
| `backfillProgress` | `backfill_progress` | Backfill job progress tracking |
| `idempotencyKeys` | `idempotency_keys` | Durable 24-hour response replay records |

Idempotency records are keyed by `(route, key)` and include the request body
fingerprint, response status, response body, and expiry timestamp. The unique
primary key gives billing and diagnostics handlers a shared database-level
claim point; expired rows can be removed by a scheduled cleanup query using the
`expires_at` index.

## Security Boundary (Sensitive Fields)

- **Sensitive Fields**: Sensitive fields (`taxId`, `dateOfBirth` in the
  `billing_profiles` schema) are designated as sensitive and must not be leaked
  in API responses or public views.
- **Enforcement Helper**: The schema module exports the
  `SENSITIVE_BILLING_FIELDS` list and a `stripSensitiveBillingFields` helper
  function to enforce this contract at the schema boundary.
- **Integration**: API handlers retrieving billing profiles sanitize rows using
  this schema helper to prevent privilege drift.
- **Boundary Verification**: The security boundary is verified in
  `src/db/migration.test.ts` to assert correct sanitization (success/boundary
  paths) and prevent schema drift.

## Runtime Validation Helpers

| Helper | Input | Returns | Corresponding CHECK |
|--------|-------|---------|---------------------|
| `isValidU256` | `string` | `boolean` | `U256_DECIMAL_REGEX` |
| `isValidCurrencyCode` | `string` | `boolean` | `CURRENCY_CODE_REGEX` |
| `isValidNonNegativeInteger` | `number` | `boolean` | `CHECK >= 0` |
| `assertNonNegative` | `number, name` | `void` (throws) | `CHECK >= 0` |
| `assertValidU256` | `string, name` | `void` (throws) | `U256_DECIMAL_REGEX` |
| `assertValidCurrencyCode` | `string, name` | `void` (throws) | `CURRENCY_CODE_REGEX` |
| `clampPageLimit` | `number` | `number` | — |
| `clampBatchSize` | `number` | `number` | — |
| `validateBatchSize` | `number, name?` | `number` (throws) | — |
| `stripSensitiveBillingFields` | `object` | `object` | — |

## Pagination & Batching Constants

| Constant | Value |
|----------|-------|
| `MAX_PAGE_SIZE` | `100` |
| `DEFAULT_PAGE_SIZE` | `50` |
| `MAX_BATCH_SIZE` | `100` |

## Adding a New Table

1. Define it in `src/db/schema.ts` with the appropriate CHECK constraints,
   FK indexes, and runtime helpers.
2. Add an entry to `SCHEMA_TABLES` so the table-inventory test stays in sync.
3. Add a CHECK-constraint test in `src/db/migration.test.ts`.
4. Write a migration in `src/db/migrations/` and register it in
   `src/db/migrations/meta/_journal.json`.
5. Update this document with the table documentation.

## Edge Cases Intentionally Out of Scope

- Cross-schema foreign key references (all FKs are within the `public` schema).
- Composite primary keys that span more than one column (all PKs are single-column).
- Database-level triggers or stored procedures (all logic lives in application code).
- Sharding or table partitioning (all tables are unpartitioned).

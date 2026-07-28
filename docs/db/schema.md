# Database Schema

The database schema (`src/db/schema.ts`) is the single source of truth for tables, CHECK constraints, and FK relationships.

## Constraints and Migration Safety
- **Validation Handlers**: Schema check constraints are mirrored in runtime via validation helpers like `assertNonNegative` and `validateBatchSize`.
- **Structured Logs**: Runtime validation helpers log structured warnings (e.g., `schema_validation_failed`) with contextual bounds information (value requested, limit) to improve observability of schema boundary violations.
- **Migration Tests**: All check constraints and migration operations are tested end-to-end against a clean sandbox container, avoiding accidental schema drifts.

## Security Boundary (Sensitive Fields)
- **Sensitive Fields**: Sensitive fields (`taxId`, `dateOfBirth` in the `billing_profiles` schema) are designated as sensitive and must not be leaked in API responses or public views.
- **Enforcement Helper**: The schema module exports the `SENSITIVE_BILLING_FIELDS` list and a `stripSensitiveBillingFields` helper function to enforce this contract at the schema boundary.
- **Integration**: API handlers retrieving billing profiles sanitize rows using this schema helper to prevent privilege drift.
- **Boundary Verification**: The security boundary is verified in `src/db/migration.test.ts` to assert correct sanitization (success/boundary paths) and prevent schema drift.

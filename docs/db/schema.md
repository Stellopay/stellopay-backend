# Database Schema

The database schema (`src/db/schema.ts`) is the single source of truth for tables, CHECK constraints, and FK relationships.

## Constraints and Migration Safety
- **Validation Handlers**: Schema check constraints are mirrored in runtime via validation helpers like `assertNonNegative` and `validateBatchSize`.
- **Structured Logs**: Runtime validation helpers log structured warnings (e.g., `schema_validation_failed`) with contextual bounds information (value requested, limit) to improve observability of schema boundary violations.
- **Migration Tests**: All check constraints and migration operations are tested end-to-end against a clean sandbox container, avoiding accidental schema drifts.

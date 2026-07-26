# Backfill Events Route

Admin-only endpoints for re-processing missed events.

### Observability Features
- **Resume Tokens**: Each response includes a `nextResumeToken` (timestamp). Pass this back as a query parameter to continue processing from where the previous window ended.
- **Metrics**: Response includes `durationMs` to track database performance.
- **Structured Logs**: Logs include scan counts and window boundaries for production debugging.

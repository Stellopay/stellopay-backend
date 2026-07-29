## Summary

Harden backfill resume tokens and replay windows in `src/routes/backfill-events.ts`. Fixes critical bugs (dead code, duplicate route handlers, undefined variables, stale parameter names) and standardizes the contract around `before`/`nextCursor`.

## Changes

### `src/routes/backfill-events.ts` — Full rewrite

The file had accumulated severe issues:

| Issue | Lines (original) | Description |
|---|---|---|
| Duplicate route | 140 + 270 | Two `POST /backfill/employee-events` handlers registered; second referenced nonexistent `performBackfill` |
| Dead code | 156–161 | Undefined variables (`type`, `tableName`, `tableAlias`, `resumeToken`) never removed after partial refactor |
| Missing SQL | 166 | Loop iterated over `employeesWithoutEvents.rows` which was never assigned |
| Stale cursor names | schema, response | `cursor` appeared as query param in tests but not in schema; `nextResumeToken` appeared in test assertions but not in `BackfillResponse` |
| Missing ORDER BY | — | No `ORDER BY` meant cursor-based pagination was non-deterministic |

**Now:**
- Both routes delegate to a shared `performBackfill` helper
- Uses `LEFT JOIN … IS NULL` to find rows without matching events
- Orders by `created_at DESC` for deterministic cursor paging
- Single consistent query-parameter name: `before` (resume cursor)
- Single consistent response field: `nextCursor`
- Input validation via `BackfillQuerySchema` rejects non-integer `limit`, invalid dates, out-of-range values before reaching the DB
- Unknown query parameters are silently ignored (Zod strip behavior)
- Structured logging with `op`, `scanned`, `created`, `durationMs`, `nextCursor`, `hasMore`

### `src/routes/backfill-events.test.ts` — Fixed tests

| Issue | Fix |
|---|---|
| `mockDate` undefined (line 315) | Added `const mockDate = new Date("2024-01-01T00:00:00.000Z")` |
| `resumeToken` param (not in schema) | Changed to `before` |
| `cursor` param (not in schema) | Changed to `before` |
| `res.body.cursor` (not in interface) | Changed to `res.body.nextCursor` |
| `res.body.nextResumeToken` (not in interface) | Changed to `res.body.nextCursor` |
| `res.body.durationMs` (not in interface) | Removed |
| `cursor` query param tests | Replaced with "ignores unknown parameters" tests |

79 tests total, all passing.

### `docs/routes/backfill-events.md` — Added sections

- **Input Validation** table documenting all param rules
- **Implementation Notes** describing the shared `performBackfill` pattern and LEFT JOIN strategy

## Checklist

- [x] `pnpm vitest run src/routes/backfill-events.test.ts` — 79/79 pass
- [x] `pnpm eslint src/routes/backfill-events.ts src/routes/backfill-events.test.ts docs/routes/backfill-events.md` — clean
- [x] No breaking API changes for documented contract (`before`/`nextCursor` unchanged)
- [x] Backward compatible — `before` query param and `nextCursor`/`hasMore` response fields preserved
- [x] Dead code removed, undefined variables eliminated, route registered exactly once per path

## Out of scope (intentionally)

- Parallel worker partitioning — single-caller sequential resumption only
- Automatic pagination/scaling across large backlogs
- Handling rows missing `transaction_hash` entirely
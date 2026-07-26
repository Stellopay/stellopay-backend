# Indexed Routes

Source: [`src/routes/indexed.ts`](../../src/routes/indexed.ts)

Read-only endpoints serving data already written to Postgres by the indexer
(agreements, payments, milestones, employees, escrow events). These routes
never call the chain directly — they query the indexed copy, which is why
every response is tagged `source: "indexed"` where applicable.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/indexed/agreements/:contract_address/user/:user_address` | Agreements where the user is employer, contributor, or a payroll employee |
| GET | `/indexed/agreement/:contract_address/:agreement_id` | Full detail for one agreement (events, payments, milestones, employees, escrow events) |
| GET | `/indexed/payments/user/:user_address` | Payments where the user is sender or recipient |
| GET | `/indexed/escrow/:contract_address/balance/:agreement_id` | Escrow balance, computed by folding `Funded`/`Released`/`Refunded` events |

All `:contract_address`/`:user_address` params are validated with
`StarknetAddress`; `:agreement_id` with `AgreementId`. Pagination (`limit`,
`offset`) goes through the shared `parsePagination` helper.

---

## Concurrent queries, not sequential round trips

Several endpoints need more than one independent read to answer a single
request. Where two queries don't depend on each other's result, they are
issued concurrently with `Promise.all` rather than one `await` after another,
so the request pays for the *slowest* query instead of the *sum* of both:

- **`/indexed/agreements/:contract_address/user/:user_address`** — the
  direct-agreements query (employer/contributor match) and the
  employee-agreements query (payroll join) don't depend on each other and run
  concurrently. Results are merged and deduplicated by agreement `id` in
  application code, then bounded to `limit`.
- **`/indexed/agreement/:contract_address/:agreement_id`** — events, payments,
  milestones, employees, and escrow events for the agreement are all fetched
  concurrently via a single `Promise.all`.

This is a correctness-neutral performance property: the merged/deduplicated
result is identical regardless of which query happens to finish first, since
combination only happens after both have resolved.

---

## Deduplication on the agreements-for-user endpoint

A user can match the direct-agreements query and the employee-agreements
query for the same agreement (e.g. an employer who is also listed as an
employee). Results from both queries are deduplicated by `id` using a `Map`
before the `limit` is applied, so the same agreement is never returned twice
and the response never exceeds the requested page size.

---

## Escrow balance calculation

`/indexed/escrow/:contract_address/balance/:agreement_id` computes balance by
folding over every escrow event for the agreement, in ascending block order:

- `Funded` adds `amount`
- `Released` and `Refunded` subtract `amount`
- any other `eventType` is ignored

Amounts are handled as `BigInt` throughout and the final balance is returned
as a string to avoid precision loss over the wire.

---

## Out of scope

- **Freshness/staleness signaling** — these endpoints do not report how far
  behind the indexer is relative to chain head. That is exposed separately by
  `/indexer/status` (`src/routes/indexer-status.ts`), not by this file.
- **Cursor-based pagination** — these endpoints use offset/limit
  (`parsePagination`), not the cursor pattern documented in
  [`docs/routes/read.md`](./read.md).
- **Cross-request caching** — every request re-reads from Postgres; there is
  no in-process or shared cache in front of these queries.

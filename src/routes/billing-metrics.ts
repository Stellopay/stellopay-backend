import { env } from "../config.js";

/**
 * Billing observability helpers.
 *
 * This module owns two side-channels for `src/routes/billing.ts`:
 *
 *  1. `logBillingEvent` — emits a single structured log entry per billing
 *     decision (invoice aggregation, summary math, ownership denial, DB
 *     failure). Output format mirrors `src/auth/session-metrics.ts`: JSON
 *     when `LOG_FORMAT=json`, otherwise a single human-readable line. The
 *     `LOG_LEVEL` env var controls the minimum level emitted.
 *
 *  2. Billing metric counters — process-local, monotonically increasing
 *     counters. Snapshot via {@link getBillingMetricsSnapshot} for
 *     diagnostics or for an `/admin/metrics` endpoint if/when one is added.
 *     No external metrics library is introduced here on purpose: the scope
 *     is "telemetry for billing.ts" and adding Prometheus/OTel is
 *     intentionally deferred.
 *
 * SECURITY: callers MUST NOT pass `taxId`, `dateOfBirth`, raw payment
 * account numbers, or session tokens. Allowed fields are profile IDs, owner
 * addresses, bounded reason codes, row counts, durations, and the already
 * rounded monetary aggregates that the routes return to the client anyway.
 */

export type BillingLogLevel = "error" | "warn" | "info" | "debug";

export type BillingEventName =
  | "billing.profile.fetched"
  | "billing.profile.failed"
  | "billing.general_information.fetched"
  | "billing.general_information.failed"
  | "billing.payment_methods.listed"
  | "billing.payment_methods.failed"
  | "billing.invoices.listed"
  | "billing.invoices.failed"
  | "billing.summary.computed"
  | "billing.summary.failed"
  | "billing.summary.limit_exceeded"
  | "billing.amount.coerced"
  | "billing.ownership.denied"
  | "billing.ownership.failed"
  | "billing.idempotency.replayed"
  | "billing.idempotency.conflict";

/**
 * Bounded set of reason codes used for `billing.ownership.denied`. The set is
 * intentionally closed so caller-supplied profile IDs never widen log
 * cardinality through the reason field.
 *
 * `not_found` and `not_owner` are distinguished **in logs only** — the HTTP
 * response is an identical 404 for both so callers cannot enumerate profile
 * IDs. Operators need the split to tell "bad link" apart from "someone is
 * probing other people's profiles".
 */
export type BillingOwnershipDenialReason = "not_found" | "not_owner";

/**
 * Bounded set of reason codes describing why a stored `numeric(18,6)` value
 * had to be coerced to `0` by the billing math. Every one of these means the
 * database holds a value the billing math cannot use as-is, which is exactly
 * the signal that is hard to diagnose from the response body alone.
 */
export type BillingAmountCoercionReason = "missing" | "malformed" | "negative";

const LEVEL_RANK: Record<BillingLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const _rawLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
const configuredLevel: BillingLogLevel =
  _rawLevel in LEVEL_RANK ? (_rawLevel as BillingLogLevel) : "info";

function isLevelEnabled(level: BillingLogLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[configuredLevel];
}

// ---------------------------------------------------------------------------
// Metric counters
// ---------------------------------------------------------------------------

const counters: Record<string, number> = {};

/** Increment a counter by `by` (default 1). Creates it on first write. */
export function incBillingMetric(name: string, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

/**
 * Point-in-time snapshot of every billing counter. Suitable for exposing via
 * an admin endpoint. Returns a shallow copy so callers cannot mutate the
 * internal state.
 */
export function getBillingMetricsSnapshot(): { counters: Record<string, number> } {
  return { counters: { ...counters } };
}

/**
 * Reset every counter. Tests call this in `beforeEach` so each case starts
 * from a clean slate. Not intended for production use.
 */
export function resetBillingMetrics(): void {
  for (const k of Object.keys(counters)) delete counters[k];
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

/**
 * Emit exactly one structured log line for a billing event.
 *
 * The payload is merged with `{ timestamp, level, event }` and serialised
 * according to `env.LOG_FORMAT`. Levels below `env.LOG_LEVEL` are dropped
 * before serialization.
 *
 * Callers must keep `data` free of sensitive profile columns. See the
 * SECURITY note at the top of this module.
 */
export function logBillingEvent(
  level: BillingLogLevel,
  event: BillingEventName,
  data: Record<string, unknown> = {},
): void {
  if (!isLevelEnabled(level)) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  };

  if (env.LOG_FORMAT === "json") {
    console[level](JSON.stringify(entry));
    return;
  }

  const flat = Object.entries(data)
    .map(([k, v]) => `${k}=${formatScalar(v)}`)
    .join(" ");
  console[level](`[billing] ${entry.timestamp} ${level.toUpperCase()} ${event} ${flat}`);
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserializable>";
  }
}

// ---------------------------------------------------------------------------
// Metric name constants (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Counter names — stable across releases. Use these constants (not raw
 * strings) at every call site so renames stay in lock-step with dashboards.
 */
export const BILLING_METRICS = {
  PROFILE_FETCHED: "billing_profile_fetched_total",
  GENERAL_INFORMATION_FETCHED: "billing_general_information_fetched_total",
  PAYMENT_METHODS_LISTED: "billing_payment_methods_listed_total",
  INVOICES_LISTED: "billing_invoices_listed_total",
  /** Number of invoice rows aggregated, not the number of list calls. */
  INVOICE_ROWS: "billing_invoice_rows_total",
  SUMMARY_COMPUTED: "billing_summary_computed_total",
  /** A stored numeric column could not be used as-is and was coerced to 0. */
  AMOUNT_COERCED: "billing_amount_coerced_total",
  /** `usedAmount` has overrun `annualRewardLimit` in the database. */
  SUMMARY_LIMIT_EXCEEDED: "billing_summary_limit_exceeded_total",
  OWNERSHIP_DENIED: "billing_ownership_denied_total",
  OWNERSHIP_DENIED_NOT_FOUND: "billing_ownership_denied_not_found_total",
  OWNERSHIP_DENIED_NOT_OWNER: "billing_ownership_denied_not_owner_total",
  /** Any 5xx-producing failure in a billing route, including ownership lookup. */
  ERRORS: "billing_errors_total",
  IDEMPOTENCY_REPLAYED: "billing_idempotency_replayed_total",
  IDEMPOTENCY_CONFLICT: "billing_idempotency_conflict_total",
  /**
   * Cumulative handler wall-time. Divide by the matching `*_total` counter
   * for a mean; percentiles need a real histogram, which is out of scope.
   */
  INVOICES_DURATION_MS: "billing_invoices_duration_ms_total",
  SUMMARY_DURATION_MS: "billing_summary_duration_ms_total",
} as const;

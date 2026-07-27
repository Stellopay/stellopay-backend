import {
  bigint,
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  numeric,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Index convention (enforced by schema-consistency.test.ts):
 * Every foreign-key-shaped column — camelCase *Id mapped to SQL *_id (e.g. agreementId,
 * profileId, milestoneId) — must have a btree index declared in this file. Primary keys and
 * non-relational identifiers (e.g. taxId) are excluded. Missing indexes hurt join and filter
 * performance as tables grow.
 */

// ---------------------------------------------------------------------------
// Shared constraint helpers
// ---------------------------------------------------------------------------

/**
 * Regex pattern that matches a valid unsigned-256-bit decimal integer string.
 * Accepts "0" and any positive integer up to 78 digits (the max decimal width
 * of 2^256 - 1 is 78 digits). Leading zeros are intentionally rejected to keep
 * the canonical form unambiguous.
 *
 * Used as a DB-level CHECK constraint on every `amount` column that stores a
 * Cairo u256 value serialised as a decimal string.
 *
 * @example
 *   isValidU256("0")        // true
 *   isValidU256("12345")    // true
 *   isValidU256("01")       // false — leading zero
 *   isValidU256("-1")       // false — negative
 *   isValidU256("1.5")      // false — decimal
 */
export const U256_DECIMAL_REGEX = "^(0|[1-9][0-9]{0,77})$";

/** Compiled pattern for runtime validation — see {@link U256_DECIMAL_REGEX}. */
export const U256_DECIMAL_PATTERN = new RegExp(U256_DECIMAL_REGEX);

/**
 * Regex that matches ISO 4217-style currency codes — exactly three uppercase
 * ASCII letters. Used in CHECK constraints on `currency` columns.
 *
 * @example
 *   isValidCurrencyCode("USD")  // true
 *   isValidCurrencyCode("usd")  // false — lowercase
 *   isValidCurrencyCode("US")   // false — too short
 */
export const CURRENCY_CODE_REGEX = /^[A-Z]{3}$/;

/**
 * Returns true when `value` is a canonical decimal string representing a
 * valid Cairo u256 (0 … 2²⁵⁶−1).
 *
 * This is the runtime counterpart of the DB-level CHECK constraint using
 * {@link U256_DECIMAL_REGEX}. Callers should validate early to produce
 * actionable errors rather than relying on a database constraint violation.
 */
export function isValidU256(value: string): boolean {
  return U256_DECIMAL_PATTERN.test(value);
}

/**
 * Returns true when `code` is a valid ISO 4217-style currency code (three
 * uppercase ASCII letters).
 *
 * Runtime counterpart of the DB-level CHECK constraint using
 * {@link CURRENCY_CODE_REGEX}.
 */
export function isValidCurrencyCode(code: string): boolean {
  return CURRENCY_CODE_REGEX.test(code);
}

/**
 * Returns true when `value` is a non-negative integer.
 */
export function isValidNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Asserts that `value` is a non-negative integer. Throws a descriptive
 * {@link RangeError} when the assertion fails.
 *
 * Use this in write-path code to fail fast before a query reaches the
 * database, making failures easier to catch and retry.
 */
export function assertNonNegative(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`${name} must be non-negative, got ${value}`);
  }
}

/**
 * Asserts that `value` is a valid u256 decimal string. Throws a descriptive
 * {@link RangeError} when the assertion fails.
 *
 * Use this in write-path code to validate amounts before inserting into
 * columns guarded by the `U256_DECIMAL_REGEX` CHECK constraint.
 */
export function assertValidU256(value: string, name: string): void {
  if (!U256_DECIMAL_PATTERN.test(value)) {
    throw new RangeError(
      `${name} must be a valid u256 decimal string (0 or positive integer up to 78 digits), got "${value}"`,
    );
  }
}

// Agreements table - stores agreement creation and status updates
export const agreements = pgTable(
  "agreements",
  {
    id: text("id").primaryKey(), // agreement_id as string
    contractAddress: text("contract_address").notNull(),
    employer: text("employer").notNull(),
    contributor: text("contributor"), // Can be null for payroll
    token: text("token").notNull(),
    mode: integer("mode").notNull(), // 0 = Escrow, 1 = Payroll
    paymentType: integer("payment_type").notNull(), // 0 = None, 1 = TimeBased, 2 = MilestoneBased
    status: integer("status").notNull(), // 0-5: Created, Active, Paused, Cancelled, Completed, Disputed
    totalAmount: text("total_amount").notNull(), // u256 as string
    paidAmount: text("paid_amount").notNull(), // u256 as string
    disputeStatus: integer("dispute_status").default(0), // 0 = None, 1 = Raised, 2 = Resolved
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    transactionHash: text("transaction_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    contractAddressIdx: index("agreements_contract_address_idx").on(table.contractAddress),
    employerIdx: index("agreements_employer_idx").on(table.employer),
    contributorIdx: index("agreements_contributor_idx").on(table.contributor),
    statusIdx: index("agreements_status_idx").on(table.status),
    // CHECK constraints — reject malformed inputs before they reach application code
    modeCheck: check("agreements_mode_check", sql`${table.mode} IN (0, 1)`),
    paymentTypeCheck: check(
      "agreements_payment_type_check",
      sql`${table.paymentType} IN (0, 1, 2)`,
    ),
    statusCheck: check(
      "agreements_status_check",
      sql`${table.status} BETWEEN 0 AND 5`,
    ),
    disputeStatusCheck: check(
      "agreements_dispute_status_check",
      sql`${table.disputeStatus} IN (0, 1, 2)`,
    ),
    blockNumberCheck: check(
      "agreements_block_number_check",
      sql`${table.blockNumber} >= 0`,
    ),
    totalAmountCheck: check(
      "agreements_total_amount_check",
      sql`${table.totalAmount} ~ ${U256_DECIMAL_REGEX}`,
    ),
    paidAmountCheck: check(
      "agreements_paid_amount_check",
      sql`${table.paidAmount} ~ ${U256_DECIMAL_REGEX}`,
    ),
  }),
);

// Agreement events table - stores all agreement-related events
export const agreementEvents = pgTable(
  "agreement_events",
  {
    id: text("id").primaryKey(), // transaction_hash + event_index
    agreementId: text("agreement_id").notNull(),
    contractAddress: text("contract_address").notNull(),
    eventType: text("event_type").notNull(), // AgreementCreated, AgreementActivated, etc.
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    transactionHash: text("transaction_hash").notNull(),
    eventIndex: integer("event_index").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agreementIdIdx: index("agreement_events_agreement_id_idx").on(table.agreementId),
    contractAddressIdx: index("agreement_events_contract_address_idx").on(table.contractAddress),
    eventTypeIdx: index("agreement_events_event_type_idx").on(table.eventType),
    blockNumberIdx: index("agreement_events_block_number_idx").on(table.blockNumber),
    blockNumberCheck: check(
      "agreement_events_block_number_check",
      sql`${table.blockNumber} >= 0`,
    ),
    eventIndexCheck: check(
      "agreement_events_event_index_check",
      sql`${table.eventIndex} >= 0`,
    ),
  }),
);

// Payments table - stores payment events
export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(), // transaction_hash + event_index
    agreementId: text("agreement_id").notNull(),
    contractAddress: text("contract_address").notNull(),
    from: text("from_address").notNull(),
    to: text("to_address").notNull(),
    amount: text("amount").notNull(), // u256 as string
    token: text("token").notNull(),
    eventType: text("event_type").notNull(), // PaymentSent, PaymentReceived
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    transactionHash: text("transaction_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agreementIdIdx: index("payments_agreement_id_idx").on(table.agreementId),
    fromIdx: index("payments_from_idx").on(table.from),
    toIdx: index("payments_to_idx").on(table.to),
    blockNumberIdx: index("payments_block_number_idx").on(table.blockNumber),
    blockNumberCheck: check("payments_block_number_check", sql`${table.blockNumber} >= 0`),
    amountCheck: check(
      "payments_amount_check",
      sql`${table.amount} ~ ${U256_DECIMAL_REGEX}`,
    ),
    eventTypeCheck: check(
      "payments_event_type_check",
      sql`${table.eventType} IN ('PaymentSent', 'PaymentReceived')`,
    ),
  }),
);

// Milestones table - stores milestone events
export const milestones = pgTable(
  "milestones",
  {
    id: text("id").primaryKey(), // agreement_id + milestone_id
    agreementId: text("agreement_id").notNull(),
    contractAddress: text("contract_address").notNull(),
    milestoneId: integer("milestone_id").notNull(),
    amount: text("amount").notNull(), // u256 as string
    approved: boolean("approved").default(false),
    claimed: boolean("claimed").default(false),
    claimedBy: text("claimed_by"), // Address who claimed
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    transactionHash: text("transaction_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    agreementIdIdx: index("milestones_agreement_id_idx").on(table.agreementId),
    milestoneIdIdx: index("milestones_milestone_id_idx").on(table.milestoneId),
    milestoneIdCheck: check("milestones_milestone_id_check", sql`${table.milestoneId} >= 0`),
    blockNumberCheck: check("milestones_block_number_check", sql`${table.blockNumber} >= 0`),
    amountCheck: check(
      "milestones_amount_check",
      sql`${table.amount} ~ ${U256_DECIMAL_REGEX}`,
    ),
  }),
);

// Employees table - stores employee information for payroll agreements
export const employees = pgTable(
  "employees",
  {
    id: text("id").primaryKey(), // agreement_id + employee_index
    agreementId: text("agreement_id").notNull(),
    contractAddress: text("contract_address").notNull(),
    employeeAddress: text("employee_address").notNull(),
    employeeIndex: integer("employee_index").notNull(),
    salaryPerPeriod: text("salary_per_period").notNull(), // u256 as string
    claimedPeriods: integer("claimed_periods").default(0),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    transactionHash: text("transaction_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    agreementIdIdx: index("employees_agreement_id_idx").on(table.agreementId),
    employeeAddressIdx: index("employees_employee_address_idx").on(table.employeeAddress),
    employeeIndexCheck: check("employees_employee_index_check", sql`${table.employeeIndex} >= 0`),
    claimedPeriodsCheck: check(
      "employees_claimed_periods_check",
      sql`${table.claimedPeriods} >= 0`,
    ),
    blockNumberCheck: check("employees_block_number_check", sql`${table.blockNumber} >= 0`),
    salaryCheck: check(
      "employees_salary_per_period_check",
      sql`${table.salaryPerPeriod} ~ ${U256_DECIMAL_REGEX}`,
    ),
  }),
);

// Escrow events table - stores escrow funding, release, and refund events
export const escrowEvents = pgTable(
  "escrow_events",
  {
    id: text("id").primaryKey(), // transaction_hash + event_index
    agreementId: text("agreement_id").notNull(),
    contractAddress: text("contract_address").notNull(),
    eventType: text("event_type").notNull(), // Funded, Released, Refunded
    employer: text("employer").notNull(),
    to: text("to_address"), // For Released/Refunded events
    amount: text("amount").notNull(), // u256 as string
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    transactionHash: text("transaction_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agreementIdIdx: index("escrow_events_agreement_id_idx").on(table.agreementId),
    contractAddressIdx: index("escrow_events_contract_address_idx").on(table.contractAddress),
    eventTypeIdx: index("escrow_events_event_type_idx").on(table.eventType),
    blockNumberIdx: index("escrow_events_block_number_idx").on(table.blockNumber),
    blockNumberCheck: check("escrow_events_block_number_check", sql`${table.blockNumber} >= 0`),
    amountCheck: check(
      "escrow_events_amount_check",
      sql`${table.amount} ~ ${U256_DECIMAL_REGEX}`,
    ),
    eventTypeCheck: check(
      "escrow_events_event_type_check",
      sql`${table.eventType} IN ('Funded', 'Released', 'Refunded')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

/**
 * billing_profiles – one row per user billing identity.
 * Sensitive fields (taxId, dateOfBirth) are stored but never returned by the
 * API unless the BILLING_ENABLED flag is true and the caller is authorised.
 */
export const billingProfiles = pgTable(
  "billing_profiles",
  {
    id: text("id").primaryKey(), // uuid or wallet-derived id
    ownerAddress: text("owner_address").notNull().unique(), // Starknet wallet address
    profileType: text("profile_type").notNull().default("Individual"), // Individual | Business
    // Reward limits
    annualRewardLimit: numeric("annual_reward_limit", {
      precision: 18,
      scale: 6,
    })
      .notNull()
      .default("0"),
    usedAmount: numeric("used_amount", { precision: 18, scale: 6 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    // General information
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    street: text("street"),
    city: text("city"),
    state: text("state"),
    zipCode: text("zip_code"),
    country: text("country"),
    // Sensitive – never echoed in list responses
    taxId: text("tax_id"), // EIN / SSN – treated as sensitive
    taxResidency: text("tax_residency"),
    dateOfBirth: text("date_of_birth"), // ISO date string – sensitive
    // Business fields
    companyName: text("company_name"),
    vatNumber: text("vat_number"),
    businessType: text("business_type"),
    occupation: text("occupation"),
    website: text("website"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    ownerAddressIdx: index("billing_profiles_owner_address_idx").on(table.ownerAddress),
    profileTypeCheck: check(
      "billing_profiles_profile_type_check",
      sql`${table.profileType} IN ('Individual', 'Business')`,
    ),
    currencyCheck: check(
      "billing_profiles_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    annualRewardLimitCheck: check(
      "billing_profiles_annual_reward_limit_check",
      sql`${table.annualRewardLimit} >= 0`,
    ),
    usedAmountCheck: check(
      "billing_profiles_used_amount_check",
      sql`${table.usedAmount} >= 0`,
    ),
  }),
);

/**
 * billing_payment_methods – payment methods attached to a billing profile.
 * Actual account/routing numbers must never be stored in plaintext; store only
 * masked representations (e.g. "****1234") or a reference to a payment
 * processor vault ID.
 */
export const billingPaymentMethods = pgTable(
  "billing_payment_methods",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull(), // → billingProfiles.id
    type: text("type").notNull(), // bank_account | paypal | crypto | etc.
    // Masked / safe-to-store fields only
    displayName: text("display_name"), // e.g. "Chase ****1234"
    maskedAccount: text("masked_account"), // e.g. "****1234"
    maskedRouting: text("masked_routing"), // e.g. "****5678"
    email: text("email"), // for PayPal / similar
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    profileIdIdx: index("billing_payment_methods_profile_id_idx").on(table.profileId),
    typeCheck: check(
      "billing_payment_methods_type_check",
      sql`${table.type} IN ('bank_account', 'paypal', 'crypto', 'wire', 'check', 'other')`,
    ),
  }),
);

/**
 * billing_invoices – invoice records associated with a billing profile.
 */
export const billingInvoices = pgTable(
  "billing_invoices",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull(), // → billingProfiles.id
    invoiceNumber: text("invoice_number").notNull().unique(),
    amount: numeric("amount", { precision: 18, scale: 6 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    status: text("status").notNull().default("pending"), // pending | paid | void
    description: text("description"),
    issuedAt: timestamp("issued_at").notNull(),
    paidAt: timestamp("paid_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    profileIdIdx: index("billing_invoices_profile_id_idx").on(table.profileId),
    statusIdx: index("billing_invoices_status_idx").on(table.status),
    statusCheck: check(
      "billing_invoices_status_check",
      sql`${table.status} IN ('pending', 'paid', 'void')`,
    ),
    currencyCheck: check(
      "billing_invoices_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    amountCheck: check("billing_invoices_amount_check", sql`${table.amount} >= 0`),
  }),
);


// ---------------------------------------------------------------------------
// Pagination & Batching Constants
// ---------------------------------------------------------------------------

/** Maximum rows per page across all list endpoints. */
export const MAX_PAGE_SIZE = 100;

/** Default page size when the caller does not specify a limit. */
export const DEFAULT_PAGE_SIZE = 50;

/** Maximum batch size for bulk operations (inserts, updates, deletes). */
export const MAX_BATCH_SIZE = 100;

/**
 * Clamp a caller-supplied limit to the allowed pagination range [1, MAX_PAGE_SIZE].
 * Values <= 0 default to DEFAULT_PAGE_SIZE. Values > MAX_PAGE_SIZE are capped.
 */
export function clampPageLimit(requested: number): number {
  if (requested <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(requested, MAX_PAGE_SIZE);
}

/**
 * Clamp a caller-supplied batch size to the allowed range [1, MAX_BATCH_SIZE].
 * Values <= 0 or > MAX_BATCH_SIZE are rejected by returning 0 — callers must
 * validate before proceeding with a bulk operation.
 *
 * Prefer {@link validateBatchSize} in new code because it throws a descriptive
 * error instead of silently returning 0, making failures visible and retryable.
 */
export function clampBatchSize(requested: number): number {
  if (requested <= 0 || requested > MAX_BATCH_SIZE) return 0;
  return requested;
}

/**
 * Validate and return a batch size, throwing a {@link RangeError} when
 * `requested` is outside [1, {@link MAX_BATCH_SIZE}].
 *
 * Unlike {@link clampBatchSize} — which returns 0 on invalid input — this
 * function fails fast with a descriptive message. This makes it suitable for
 * user-facing input validation where the caller should know the value was
 * rejected rather than silently adjusted, and for retry-safe code paths that
 * need explicit errors rather than silent fallbacks.
 *
 * @throws {RangeError} when `requested` is not an integer in [1, MAX_BATCH_SIZE].
 */
export function validateBatchSize(requested: number, name?: string): number {
  if (!Number.isInteger(requested) || requested <= 0 || requested > MAX_BATCH_SIZE) {
    throw new RangeError(
      `${name ?? "batchSize"} must be an integer between 1 and ${MAX_BATCH_SIZE}, got ${requested}`,
    );
  }
  return requested;
}

// Sessions table - stores auth sessions with sliding and absolute expiry
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    address: text("address").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    lastSeen: timestamp("last_seen"),
    // BE-154: groups every token descended from one login, so the whole
    // chain can be revoked at once if a rotated-out token is reused.
    familyId: text("family_id"),
    // BE-154: set the moment this token is rotated out. A non-null value
    // being presented again means someone replayed a stale refresh token.
    rotatedAt: timestamp("rotated_at"),
  },
  (table) => ({
    addressIdx: index("sessions_address_idx").on(table.address),
    familyIdIdx: index("sessions_family_id_idx").on(table.familyId),
  }),
);


import {
  bigint,
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  numeric,
} from "drizzle-orm/pg-core";

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
  }),
);

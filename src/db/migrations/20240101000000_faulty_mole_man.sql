CREATE TABLE "agreement_events" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"contract_address" text NOT NULL,
	"event_type" text NOT NULL,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"event_index" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_address" text NOT NULL,
	"employer" text NOT NULL,
	"contributor" text,
	"token" text NOT NULL,
	"mode" integer NOT NULL,
	"payment_type" integer NOT NULL,
	"status" integer NOT NULL,
	"total_amount" text NOT NULL,
	"paid_amount" text NOT NULL,
	"dispute_status" integer DEFAULT 0,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"invoice_number" text NOT NULL,
	"amount" numeric(18, 6) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"description" text,
	"issued_at" timestamp NOT NULL,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "billing_payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"type" text NOT NULL,
	"display_name" text,
	"masked_account" text,
	"masked_routing" text,
	"email" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_address" text NOT NULL,
	"profile_type" text DEFAULT 'Individual' NOT NULL,
	"annual_reward_limit" numeric(18, 6) DEFAULT '0' NOT NULL,
	"used_amount" numeric(18, 6) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"street" text,
	"city" text,
	"state" text,
	"zip_code" text,
	"country" text,
	"tax_id" text,
	"tax_residency" text,
	"date_of_birth" text,
	"company_name" text,
	"vat_number" text,
	"business_type" text,
	"occupation" text,
	"website" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_profiles_owner_address_unique" UNIQUE("owner_address")
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"contract_address" text NOT NULL,
	"employee_address" text NOT NULL,
	"employee_index" integer NOT NULL,
	"salary_per_period" text NOT NULL,
	"claimed_periods" integer DEFAULT 0,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrow_events" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"contract_address" text NOT NULL,
	"event_type" text NOT NULL,
	"employer" text NOT NULL,
	"to_address" text,
	"amount" text NOT NULL,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"contract_address" text NOT NULL,
	"milestone_id" integer NOT NULL,
	"amount" text NOT NULL,
	"approved" boolean DEFAULT false,
	"claimed" boolean DEFAULT false,
	"claimed_by" text,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"contract_address" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"amount" text NOT NULL,
	"token" text NOT NULL,
	"event_type" text NOT NULL,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agreement_events_agreement_id_idx" ON "agreement_events" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "agreement_events_contract_address_idx" ON "agreement_events" USING btree ("contract_address");--> statement-breakpoint
CREATE INDEX "agreement_events_event_type_idx" ON "agreement_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "agreement_events_block_number_idx" ON "agreement_events" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "agreements_contract_address_idx" ON "agreements" USING btree ("contract_address");--> statement-breakpoint
CREATE INDEX "agreements_employer_idx" ON "agreements" USING btree ("employer");--> statement-breakpoint
CREATE INDEX "agreements_contributor_idx" ON "agreements" USING btree ("contributor");--> statement-breakpoint
CREATE INDEX "agreements_status_idx" ON "agreements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billing_invoices_profile_id_idx" ON "billing_invoices" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "billing_invoices_status_idx" ON "billing_invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billing_payment_methods_profile_id_idx" ON "billing_payment_methods" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "billing_profiles_owner_address_idx" ON "billing_profiles" USING btree ("owner_address");--> statement-breakpoint
CREATE INDEX "employees_agreement_id_idx" ON "employees" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "employees_employee_address_idx" ON "employees" USING btree ("employee_address");--> statement-breakpoint
CREATE INDEX "escrow_events_agreement_id_idx" ON "escrow_events" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "escrow_events_contract_address_idx" ON "escrow_events" USING btree ("contract_address");--> statement-breakpoint
CREATE INDEX "escrow_events_event_type_idx" ON "escrow_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "escrow_events_block_number_idx" ON "escrow_events" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "milestones_agreement_id_idx" ON "milestones" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "milestones_milestone_id_idx" ON "milestones" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "payments_agreement_id_idx" ON "payments" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "payments_from_idx" ON "payments" USING btree ("from_address");--> statement-breakpoint
CREATE INDEX "payments_to_idx" ON "payments" USING btree ("to_address");--> statement-breakpoint
CREATE INDEX "payments_block_number_idx" ON "payments" USING btree ("block_number");
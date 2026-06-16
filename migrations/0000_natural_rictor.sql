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
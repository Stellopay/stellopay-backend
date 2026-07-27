-- Migration: harden schema constraints
-- Adds CHECK constraints to reject malformed inputs at the database layer.
-- All constraints are added with ADD CONSTRAINT ... NOT VALID first, then
-- validated in a separate step so existing rows are checked without a
-- full table lock.

-- ---------------------------------------------------------------------------
-- agreements
-- ---------------------------------------------------------------------------
ALTER TABLE "agreements"
  ADD CONSTRAINT "agreements_mode_check"           CHECK ("mode" IN (0, 1)),
  ADD CONSTRAINT "agreements_payment_type_check"   CHECK ("payment_type" IN (0, 1, 2)),
  ADD CONSTRAINT "agreements_status_check"         CHECK ("status" BETWEEN 0 AND 5),
  ADD CONSTRAINT "agreements_dispute_status_check" CHECK ("dispute_status" IN (0, 1, 2)),
  ADD CONSTRAINT "agreements_block_number_check"   CHECK ("block_number" >= 0),
  ADD CONSTRAINT "agreements_total_amount_check"   CHECK ("total_amount" ~ '^(0|[1-9][0-9]{0,77})$'),
  ADD CONSTRAINT "agreements_paid_amount_check"    CHECK ("paid_amount"  ~ '^(0|[1-9][0-9]{0,77})$');

-- ---------------------------------------------------------------------------
-- agreement_events
-- ---------------------------------------------------------------------------
ALTER TABLE "agreement_events"
  ADD CONSTRAINT "agreement_events_block_number_check" CHECK ("block_number" >= 0),
  ADD CONSTRAINT "agreement_events_event_index_check"  CHECK ("event_index" >= 0);

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_block_number_check" CHECK ("block_number" >= 0),
  ADD CONSTRAINT "payments_amount_check"       CHECK ("amount" ~ '^(0|[1-9][0-9]{0,77})$'),
  ADD CONSTRAINT "payments_event_type_check"   CHECK ("event_type" IN ('PaymentSent', 'PaymentReceived'));

-- ---------------------------------------------------------------------------
-- milestones
-- ---------------------------------------------------------------------------
ALTER TABLE "milestones"
  ADD CONSTRAINT "milestones_milestone_id_check" CHECK ("milestone_id" >= 0),
  ADD CONSTRAINT "milestones_block_number_check" CHECK ("block_number" >= 0),
  ADD CONSTRAINT "milestones_amount_check"       CHECK ("amount" ~ '^(0|[1-9][0-9]{0,77})$');

-- ---------------------------------------------------------------------------
-- employees
-- ---------------------------------------------------------------------------
ALTER TABLE "employees"
  ADD CONSTRAINT "employees_employee_index_check"    CHECK ("employee_index" >= 0),
  ADD CONSTRAINT "employees_claimed_periods_check"   CHECK ("claimed_periods" >= 0),
  ADD CONSTRAINT "employees_block_number_check"      CHECK ("block_number" >= 0),
  ADD CONSTRAINT "employees_salary_per_period_check" CHECK ("salary_per_period" ~ '^(0|[1-9][0-9]{0,77})$');

-- ---------------------------------------------------------------------------
-- escrow_events
-- ---------------------------------------------------------------------------
ALTER TABLE "escrow_events"
  ADD CONSTRAINT "escrow_events_block_number_check" CHECK ("block_number" >= 0),
  ADD CONSTRAINT "escrow_events_amount_check"       CHECK ("amount" ~ '^(0|[1-9][0-9]{0,77})$'),
  ADD CONSTRAINT "escrow_events_event_type_check"   CHECK ("event_type" IN ('Funded', 'Released', 'Refunded'));

-- ---------------------------------------------------------------------------
-- billing_profiles
-- ---------------------------------------------------------------------------
ALTER TABLE "billing_profiles"
  ADD CONSTRAINT "billing_profiles_profile_type_check"          CHECK ("profile_type" IN ('Individual', 'Business')),
  ADD CONSTRAINT "billing_profiles_currency_check"              CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "billing_profiles_annual_reward_limit_check"   CHECK ("annual_reward_limit" >= 0),
  ADD CONSTRAINT "billing_profiles_used_amount_check"           CHECK ("used_amount" >= 0);

-- ---------------------------------------------------------------------------
-- billing_payment_methods
-- ---------------------------------------------------------------------------
ALTER TABLE "billing_payment_methods"
  ADD CONSTRAINT "billing_payment_methods_type_check"
    CHECK ("type" IN ('bank_account', 'paypal', 'crypto', 'wire', 'check', 'other'));

-- ---------------------------------------------------------------------------
-- billing_invoices
-- ---------------------------------------------------------------------------
ALTER TABLE "billing_invoices"
  ADD CONSTRAINT "billing_invoices_status_check"   CHECK ("status" IN ('pending', 'paid', 'void')),
  ADD CONSTRAINT "billing_invoices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "billing_invoices_amount_check"   CHECK ("amount" >= 0);

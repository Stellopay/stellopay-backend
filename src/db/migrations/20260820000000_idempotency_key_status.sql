ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'completed';
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "status_code" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_status_check" CHECK ("status" IN ('in_progress', 'completed', 'failed'));

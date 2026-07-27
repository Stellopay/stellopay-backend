-- Only the new backfill_progress table is created here. drizzle-kit's diff
-- also tried to re-add every CHECK constraint from 0003_schema_check_constraints.sql
-- because that migration was hand-authored and never fed back into
-- meta/*_snapshot.json — those constraints already exist in the database, so
-- re-adding them here was trimmed out to avoid a duplicate-constraint error.
CREATE TABLE "backfill_progress" (
	"job_name" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_cursor" timestamp,
	"total_scanned" integer DEFAULT 0 NOT NULL,
	"total_created" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "backfill_progress_status_check" CHECK ("backfill_progress"."status" IN ('idle', 'running', 'completed', 'failed')),
	CONSTRAINT "backfill_progress_total_scanned_check" CHECK ("backfill_progress"."total_scanned" >= 0),
	CONSTRAINT "backfill_progress_total_created_check" CHECK ("backfill_progress"."total_created" >= 0)
);
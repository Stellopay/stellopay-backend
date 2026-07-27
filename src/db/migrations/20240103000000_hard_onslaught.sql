ALTER TABLE "sessions" ADD COLUMN "family_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rotated_at" timestamp;--> statement-breakpoint
CREATE INDEX "sessions_family_id_idx" ON "sessions" USING btree ("family_id");
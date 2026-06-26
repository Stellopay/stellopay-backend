CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"absolute_expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"last_seen" timestamp
);
--> statement-breakpoint
CREATE INDEX "sessions_address_idx" ON "sessions" USING btree ("address");
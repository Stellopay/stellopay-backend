CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  "route" text NOT NULL,
  "key" text NOT NULL,
  "body_fingerprint" text NOT NULL,
  "status_code" integer NOT NULL,
  "response_body" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "expires_at" timestamp NOT NULL,
  CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("route", "key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx"
  ON "idempotency_keys" USING btree ("expires_at");

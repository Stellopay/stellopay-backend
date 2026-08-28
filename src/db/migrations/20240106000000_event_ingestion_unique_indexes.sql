-- Prevent the same on-chain transaction position from being ingested twice.
-- The application already uses ON CONFLICT DO NOTHING; these indexes make that
-- protection hold across live indexing, retries, and backfill workers.
CREATE UNIQUE INDEX IF NOT EXISTS "agreement_events_transaction_position_key"
  ON "agreement_events" ("transaction_hash", "event_index");

CREATE UNIQUE INDEX IF NOT EXISTS "escrow_events_transaction_position_key"
  ON "escrow_events" ("id");

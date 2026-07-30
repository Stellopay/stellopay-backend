ALTER TABLE "backfill_progress"
  ADD COLUMN "last_block_number" bigint,
  ADD COLUMN "last_contract_address" text;

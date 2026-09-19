-- Batch 1C Phase 2 — parties, open items, advances: staging identity and the
-- VAT position (decision pack §15.5 steps 3–7, §15.6 R2/R3/R9/R10).
--
-- Identity is unique WITHIN a batch. Across batches the one-committed-batch-
-- per-company rule (0077) is what keeps a source row from producing two
-- accounting events; a discarded or reversed batch has no live effect, and a
-- re-run after reversal must be able to import the same ids again.
-- A party's decision is NULL while undecided (a likely duplicate blocks until
-- the operator chooses create / use_existing).
DROP INDEX "migration_advances_identity_unq";--> statement-breakpoint
DROP INDEX "migration_open_items_identity_unq";--> statement-breakpoint
DROP INDEX "migration_parties_identity_unq";--> statement-breakpoint
ALTER TABLE "migration_parties" ALTER COLUMN "decision" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "migration_parties" ALTER COLUMN "decision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_batches" ADD COLUMN "vat_position" jsonb;--> statement-breakpoint
ALTER TABLE "migration_parties" ADD COLUMN "decided_by" integer;--> statement-breakpoint
ALTER TABLE "migration_parties" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_advances_identity_unq" ON "migration_advances" USING btree ("batch_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_open_items_identity_unq" ON "migration_open_items" USING btree ("batch_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_parties_identity_unq" ON "migration_parties" USING btree ("batch_id","party_type","source_id");
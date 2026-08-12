ALTER TABLE "transactions" ADD COLUMN "review_status" text DEFAULT 'pending_review' NOT NULL;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- M15 — backfill: every EXISTING transaction is `accepted`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Correct, not convenient: every current row was entered by a human under the
-- old rules — typed one at a time or pasted and reviewed. They already had a
-- person behind them. Only rows arriving AFTER this migration through an import
-- path land pending, because import changes the AUTHORSHIP of rows that move
-- tax figures — which is the entire reason the holding area exists.
UPDATE "transactions" SET "review_status" = 'accepted';--> statement-breakpoint

-- The reports filter on it in every tax-facing query.
CREATE INDEX IF NOT EXISTS "transactions_review_status_idx"
  ON "transactions" ("organization_id", "review_status");

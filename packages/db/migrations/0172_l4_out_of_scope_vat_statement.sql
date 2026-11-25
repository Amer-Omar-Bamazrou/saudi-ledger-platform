-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 L4 (owner, 2026-11-25) — VAT ON AN OUT-OF-SCOPE EXPENSE ACCOUNT needs a STATED commercial supply.
--  · Three nullable columns on bills: the reason, who stated it, when.
--  · The service requires them whenever a bill on an out-of-scope account (the account's own treatment 'O') carries
--    VAT — at entry, edit and approval; the claim itself still waits on a valid tax invoice (the 13A verdict).
--  · CHECK (hand-written, as 0136's): all NULL, or a non-blank reason with its time.
-- No existing row is read or changed: every existing bill keeps NULL, which the CHECK accepts.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "bills" ADD COLUMN "commercial_supply_reason" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "commercial_supply_stated_by" integer;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "commercial_supply_stated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_commercial_supply_chk" CHECK (
  ("commercial_supply_reason" IS NULL AND "commercial_supply_stated_by" IS NULL AND "commercial_supply_stated_at" IS NULL)
  OR ("commercial_supply_reason" IS NOT NULL AND btrim("commercial_supply_reason") <> '' AND "commercial_supply_stated_at" IS NOT NULL)
);

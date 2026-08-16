-- ═══════════════════════════════════════════════════════════════════════════
-- B5 — a transfer must be able to say WHERE THE MONEY WENT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 🔴 THE FACT THIS CAPTURES EXPIRES AT ENTRY. `transactions.bank_account_id`
-- records which account a transfer LEFT; nothing records where it arrived. So
-- the platform cannot distinguish:
--
--   • money moving between two accounts of the same business — total business
--     cash unchanged, and NOT posting to the ledger is correct;
--   • money leaving the business entirely (owner drawings, cash withdrawn and
--     kept) — total cash FELL, and not posting is wrong.
--
-- Both are `kind = 'transfer'`. Only the person entering the row knows which,
-- and only on the day: it is not derivable from the amount, the description, or
-- anything else the row holds. Every transfer recorded without this column is
-- losing that fact permanently — no migration recovers it. (Named pattern:
-- "facts about intent expire at entry", with B4.)
--
-- ── 🔴 NULL MEANS "NOT DECLARED", NEVER "EXTERNAL" ─────────────────────────
-- The same discipline as M17.1's `ownership_type` and the fiscal-year decision
-- (F8/F10): a nullable column with NO default, because a default would have the
-- platform assert on the tenant's behalf exactly the fact it is trying to
-- collect. Three states, and the third is real:
--
--   'own_account' — moved between accounts of this business. Business cash
--                   unchanged; the ledger's silence is CORRECT.
--   'external'    — left the business. Business cash fell; the ledger is
--                   understating it.
--   NULL          — nobody has said. The platform must report this as unknown
--                   rather than guessing, which is what the cash reconciliation
--                   now does.
--
-- Existing rows are left NULL deliberately: they are undeclared, and marking
-- them 'own_account' would manufacture the very assertion this exists to avoid.

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "transfer_direction" varchar(20);--> statement-breakpoint

-- Optional even for 'own_account': the destination may be an account the tenant
-- does not track in this product, and requiring it would block them from
-- declaring the thing that actually matters (did it leave the business).
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "counterparty_bank_account_id" integer
  REFERENCES "bank_accounts"("id");--> statement-breakpoint

-- ── Write-boundary invariants (the M12.5 / audit-close-out posture) ────────
-- Enforced in the DATABASE, not in one service, because three paths write
-- transactions (import, manual create, review edit) and per-path enforcement is
-- per-path review — a fourth path starts at zero.

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transfer_direction_values"
  CHECK ("transfer_direction" IS NULL
         OR "transfer_direction" IN ('own_account', 'external'));--> statement-breakpoint

-- Only a TRANSFER may carry either field. A direction on an operating row would
-- be read by a future consumer as a claim about a row that never made one.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transfer_fields_need_transfer"
  CHECK ("kind" = 'transfer'
         OR ("transfer_direction" IS NULL AND "counterparty_bank_account_id" IS NULL));--> statement-breakpoint

-- A counterparty account only means anything for an own-account move. Naming a
-- destination account while declaring the money left the business is a
-- contradiction, not a detail.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_counterparty_needs_own_account"
  CHECK ("counterparty_bank_account_id" IS NULL
         OR "transfer_direction" = 'own_account');--> statement-breakpoint

-- The destination cannot be the account it left.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_counterparty_is_not_self"
  CHECK ("counterparty_bank_account_id" IS NULL
         OR "bank_account_id" IS NULL
         OR "counterparty_bank_account_id" <> "bank_account_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "transactions_transfer_direction_idx"
  ON "transactions" ("organization_id", "kind", "transfer_direction");

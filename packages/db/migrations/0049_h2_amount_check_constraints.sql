-- ═══════════════════════════════════════════════════════════════════════════
-- H2 — AMOUNT CONSTRAINTS AT THE WRITE BOUNDARY (audit 2026-08-20)
--
-- The audit found NO CHECK constraint on any amount column anywhere: a
-- negative or absurd amount that slipped past a service reached the ledger
-- with nothing underneath to stop it. The service-layer guards
-- (lib/writeGuards.ts) are the diagnosable 400s; these constraints are the
-- BACKSTOP — the standing rule is that an invariant several writers can
-- violate belongs in a DB CHECK or a shared gate, not in per-path code,
-- because per-path enforcement is per-path review and a NEW path starts at
-- zero.
--
-- Amounts are stored POSITIVE by design; direction lives in `document_type`
-- (invoices/bills) and in the debit-vs-credit column pair (journal lines), so
-- "≥ 0" is the platform's own convention, not an assumption imposed here.
-- Verified against live data before writing: zero existing rows violate any
-- constraint below (checked on the dev org, all five tables).
--
-- 🔴 Deliberately NOT constrained:
--   * bank_accounts.balance / opening_balance — an overdraft is a real
--     negative balance; the service bounds the magnitude only.
--   * transactions.amount — already positive by the ingest path, and a CHECK
--     here would fight the M16.2 kind/treatment CHECKs on the same table if
--     a future correction path needs a signed value. Service-guarded.
--   * budgets.budgeted_amount — M19.0 deliberately reports NEGATIVE actuals
--     rather than clamping; the budget figure itself is service-guarded to
--     avoid a constraint that a future "credit budget" concept would fight.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "journal_entry_lines" DROP CONSTRAINT IF EXISTS "je_lines_amounts_non_negative";
ALTER TABLE "journal_entry_lines"
  ADD CONSTRAINT "je_lines_amounts_non_negative"
  CHECK (debit_amount >= 0 AND credit_amount >= 0);--> statement-breakpoint

ALTER TABLE "invoice_items" DROP CONSTRAINT IF EXISTS "invoice_items_amounts_sane";
ALTER TABLE "invoice_items"
  ADD CONSTRAINT "invoice_items_amounts_sane"
  CHECK (
    quantity >= 0 AND unit_price >= 0 AND total >= 0
    AND (discount IS NULL OR discount >= 0)
    AND (vat_amount IS NULL OR vat_amount >= 0)
    AND (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100))
  );--> statement-breakpoint

-- NOTE: `bill_items` has no `discount` column (unlike `invoice_items`) — the
-- two item tables are NOT symmetric. Verified against information_schema
-- rather than assumed from the invoice side.
ALTER TABLE "bill_items" DROP CONSTRAINT IF EXISTS "bill_items_amounts_sane";
ALTER TABLE "bill_items"
  ADD CONSTRAINT "bill_items_amounts_sane"
  CHECK (
    quantity >= 0 AND unit_price >= 0 AND total >= 0
    AND (vat_amount IS NULL OR vat_amount >= 0)
    AND (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100))
  );--> statement-breakpoint

ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_totals_non_negative";
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_totals_non_negative"
  CHECK (
    subtotal >= 0 AND vat_amount >= 0 AND total >= 0
    AND (discount IS NULL OR discount >= 0)
    AND (paid_amount IS NULL OR paid_amount >= 0)
  );--> statement-breakpoint

ALTER TABLE "bills" DROP CONSTRAINT IF EXISTS "bills_totals_non_negative";
ALTER TABLE "bills"
  ADD CONSTRAINT "bills_totals_non_negative"
  CHECK (
    subtotal >= 0 AND vat_amount >= 0 AND total >= 0
    AND (paid_amount IS NULL OR paid_amount >= 0)
  );--> statement-breakpoint

-- Employee pay is never negative (it feeds payroll and GOSI arithmetic).
ALTER TABLE "employees" DROP CONSTRAINT IF EXISTS "employees_pay_non_negative";
ALTER TABLE "employees"
  ADD CONSTRAINT "employees_pay_non_negative"
  CHECK (
    basic_salary >= 0
    AND (housing_allowance IS NULL OR housing_allowance >= 0)
    AND (transport_allowance IS NULL OR transport_allowance >= 0)
    AND (other_allowances IS NULL OR other_allowances >= 0)
  );--> statement-breakpoint

-- A zero useful life produced Infinity annual depreciation (serialized as
-- null in the view — a figure that vanished rather than erroring).
ALTER TABLE "fixed_assets" DROP CONSTRAINT IF EXISTS "fixed_assets_amounts_sane";
ALTER TABLE "fixed_assets"
  ADD CONSTRAINT "fixed_assets_amounts_sane"
  CHECK (
    purchase_cost >= 0
    AND (salvage_value IS NULL OR salvage_value >= 0)
    AND useful_life_years >= 1
  );--> statement-breakpoint

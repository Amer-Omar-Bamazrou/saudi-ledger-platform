-- ═══════════════════════════════════════════════════════════════════════════
-- Single currency, enforced at the WRITE BOUNDARY (2026-08-26)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `currency` is stored on nine tables and consulted by NO aggregate. Verified
-- by grep, not assumed: zero references in glPosting.ts, reports.repository.ts,
-- analytics.repository.ts, summary.repository.ts and the VAT return; no
-- exchange-rate column exists in any of the 56 tables; no conversion function
-- exists in any service. A row stored as USD therefore has its bare number
-- added straight into SAR totals, the trial balance and the filed VAT return.
--
-- 🔴 The invariant already existed in exactly ONE path — transactions.service
-- refuses non-SAR statement rows (audit finding #4). Per-path enforcement is
-- per-path review: bankAccounts.service allowlisted `currency` for direct
-- client writes with NO validation, and a free-text input in the UI wrote
-- through it. This is the backstop that covers every path, present and future.
--
-- NULL stays permitted where the column is nullable: it means "not stated",
-- and every reader already coalesces it to SAR. The CHECK constrains what a
-- value may BE, never that one must exist.
--
-- This migration REFUSES to run if non-SAR rows exist, and NAMES them rather
-- than coercing. Silently rewriting a stored USD amount's label to SAR would
-- assert that a number we never converted is a riyal figure — the same
-- confident-wrong shape this migration exists to close. (C12 precedent.)

DO $$
DECLARE
  t text;
  offending text := '';
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bank_accounts', 'bills', 'customers', 'invoices', 'products',
    'purchase_orders', 'quotations', 'transactions', 'vendors'
  ] LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE currency IS NOT NULL AND upper(btrim(currency)) <> ''SAR''', t
    ) INTO n;
    IF n > 0 THEN
      offending := offending || format('  %s: %s row(s)%s', t, n, chr(10));
    END IF;
  END LOOP;

  IF offending <> '' THEN
    RAISE EXCEPTION E'Refusing to add the single-currency CHECK: non-SAR rows exist.\n%\nConvert each to SAR at the rate that applied on its own date and record that conversion, or delete the rows. This migration will not relabel them.', offending;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "bank_accounts"   ADD CONSTRAINT "bank_accounts_currency_sar"   CHECK (currency IS NULL OR currency = 'SAR');--> statement-breakpoint
ALTER TABLE "bills"           ADD CONSTRAINT "bills_currency_sar"           CHECK (currency IS NULL OR currency = 'SAR');--> statement-breakpoint
ALTER TABLE "customers"       ADD CONSTRAINT "customers_currency_sar"       CHECK (currency IS NULL OR currency = 'SAR');--> statement-breakpoint
ALTER TABLE "invoices"        ADD CONSTRAINT "invoices_currency_sar"        CHECK (currency IS NULL OR currency = 'SAR');--> statement-breakpoint
ALTER TABLE "products"        ADD CONSTRAINT "products_currency_sar"        CHECK (currency IS NULL OR currency = 'SAR');--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_currency_sar" CHECK (currency IS NULL OR currency = 'SAR');--> statement-breakpoint
ALTER TABLE "quotations"      ADD CONSTRAINT "quotations_currency_sar"      CHECK (currency IS NULL OR currency = 'SAR');--> statement-breakpoint
ALTER TABLE "transactions"    ADD CONSTRAINT "transactions_currency_sar"    CHECK (currency = 'SAR');--> statement-breakpoint
ALTER TABLE "vendors"         ADD CONSTRAINT "vendors_currency_sar"         CHECK (currency IS NULL OR currency = 'SAR');

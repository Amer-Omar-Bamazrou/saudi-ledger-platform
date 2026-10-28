-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 G2b — owner decision A5(c) (2026-10-27): recording a VAT filing
-- posts the entry clearing output and input VAT to VAT payable (receivable).
-- Register §11.39. The entry is the posting seam's own:
--  · 'vat_return_filing' joins the T1d journal source types (its source_id is
--    vat_return_filings.id) — the list is JOURNAL_SOURCE_TYPES;
--  · 'VATFILE' joins the reserved entry-number prefixes a manual or recurring
--    entry never takes — the list is RESERVED_ENTRY_NUMBER_PREFIXES.
-- Both CHECKs are redefined whole (drizzle does not track CHECKs; the 0134
-- precedent). Both lists only GROW, so every existing row still passes; the
-- pre-check refuses, and repairs nothing, if a manual entry already took the
-- new prefix.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE taken int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_source_type_chk' AND conrelid = 'journal_entries'::regclass) THEN
    RAISE EXCEPTION 'pre-check REFUSED: journal_entries_source_type_chk (T1d, 0129/0134) does not exist; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_manual_number_reserved_chk' AND conrelid = 'journal_entries'::regclass) THEN
    RAISE EXCEPTION 'pre-check REFUSED: journal_entries_manual_number_reserved_chk (T1d, 0129) does not exist; nothing was changed';
  END IF;
  SELECT count(*) INTO taken FROM journal_entries WHERE source_type IN ('manual', 'recurring') AND entry_number ~* '^VATFILE-';
  IF taken > 0 THEN
    RAISE EXCEPTION 'pre-check REFUSED: % manual or recurring entr(y/ies) already numbered VATFILE-…; nothing was changed', taken;
  END IF;
  RAISE NOTICE 'pre-check: both T1d checks exist; no user entry takes the VATFILE- prefix';
END $$;--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_type_chk";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_type_chk" CHECK (
  source_type IS NULL OR source_type IN (
    'manual', 'recurring', 'reversal',
    'invoice', 'invoice_correction', 'invoice_write_off', 'credit_note_application',
    'customer_payment', 'customer_payment_allocation', 'customer_allocation_correction', 'customer_refund', 'customer_payment_reclassification',
    'bill', 'bill_payment', 'vat_evidence',
    'supplier_payment', 'supplier_advance_allocation', 'supplier_allocation_reversal', 'supplier_payment_reclassification', 'supplier_refund',
    'bank_transfer', 'bank_transaction',
    'payroll_run', 'payroll_net_pay', 'payroll_gosi_payment',
    'depreciation', 'asset_disposal', 'recognition',
    'tax_computation', 'wht_remittance', 'wht_remittance_reversal',
    'migration_opening', 'migration_reversal', 'opening_correction',
    'vat_return_filing'
  )
);--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_manual_number_reserved_chk";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_manual_number_reserved_chk" CHECK (
  source_type IS NULL OR source_type NOT IN ('manual', 'recurring')
  OR entry_number !~* '^(GL|BILL|BILLCN|BILLADV|BILLADVCN|DEP|DISP|WO|PAY|VATEV|MIG|OPEN|SPAY|SALLOC|SRECLASS|SREFUND|BTR|TXN|RCPT|ALLOC|UNALLOC|REFUND|RECLASS|ZAKAT|INCTAX|WHTREM|WHTREMREV|VATFILE)-|-REV$'
);
